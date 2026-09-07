import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { redisIsRequired } from './cache.service';

type Processor = (data: any) => Promise<any>;

/**
 * Job queue layer (Phase 0).
 * - If REDIS_URL is set → BullMQ queues + workers (durable, retried, off the request path).
 * - Otherwise → jobs run in-process on next tick (still off the request path, not durable).
 *
 * Modules register processors at startup:
 *   queueService.registerProcessor('radius-sync', (data) => this.doSync(data));
 * and enqueue work from controllers:
 *   const jobId = await queueService.add('radius-sync', { scope: 'all' });
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private processors = new Map<string, Processor>();
  private queues = new Map<string, any>();
  private workers: any[] = [];
  private bull: any = null;
  private connection: any = null;
  /** in-memory job results for status polling (both modes) */
  private jobStatus = new Map<string, { status: string; result?: any; error?: string; startedAt: number }>();

  /** Set when BullMQ was required and is unavailable. Surfaced by assertReady(). */
  private fatalError: string | null = null;

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this.bull = require('bullmq');
        this.connection = { url };
        this.logger.log('Queue: BullMQ mode');
      } catch {
        if (redisIsRequired()) {
          this.fatalError = 'Durable queues required but the bullmq package is not installed';
          this.logger.error(this.fatalError);
        } else {
          this.logger.warn('bullmq not installed — using inline job execution');
        }
      }
    } else if (redisIsRequired()) {
      this.fatalError = 'Durable queues required but REDIS_URL is not configured';
      this.logger.error(this.fatalError);
    } else {
      this.logger.log('Queue: inline mode (set REDIS_URL to enable BullMQ)');
    }
  }

  /**
   * Refuse to run undurably when the operator asked for durable queues.
   *
   * THE FAILURE THIS PREVENTS
   * Inline mode is not "the queue, a bit slower". A job enqueued inline runs in
   * the web process and exists only in its heap: a deploy, a crash, or PM2's
   * `max_memory_restart` discards every job in flight, with no dead letter and
   * nothing left in any queue to notice afterwards. A half-finished
   * 1M-subscriber RADIUS sync that vanishes without trace is materially worse
   * than one that never started, because the operator believes it ran.
   */
  assertReady(): void {
    if (this.fatalError) throw new Error(this.fatalError);
    if (redisIsRequired() && !this.bull) {
      throw new Error('Durable queues required in production but BullMQ is not active');
    }
  }

  registerProcessor(name: string, fn: Processor, opts: { concurrency?: number } = {}) {
    this.processors.set(name, fn);
    if (this.bull) {
      /**
       * CONCURRENCY WAS HARDCODED TO 2.
       *
       * Every job here is I/O bound — a RADIUS write, an SMS, an SNMP walk —
       * so the process spends nearly all of each job idle on a socket. Two at
       * a time leaves the CPU almost entirely unused while the queue backs up,
       * and it compounds with anything that also loops sequentially inside a
       * job (see bulkSyncSubscribers): 2-way concurrency wrapped around a
       * sequential 1M-row loop is still one subscriber at a time.
       *
       * Per-queue override first, then a global default, then 10 — the right
       * number differs per queue and belongs in the operator's env rather than
       * in this constant. A queue that hammers a fragile downstream can be
       * pinned back to 1 by name without touching any other.
       */
      const concurrency =
        opts.concurrency ??
        (Number(process.env[`QUEUE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CONCURRENCY`]) ||
          Number(process.env.QUEUE_CONCURRENCY) ||
          10);
      const worker = new this.bull.Worker(
        name,
        async (job: any) => fn(job.data),
        { connection: this.connection, concurrency },
      );
      worker.on('failed', (job: any, err: Error) =>
        this.logger.error(`Job ${name}#${job?.id} failed: ${err.message}`),
      );
      this.workers.push(worker);
    }
  }

  /** True when running on real BullMQ (Redis present). */
  isBull(): boolean { return !!this.bull; }

  /**
   * Backlog per queue: waiting / active / failed / delayed.
   *
   * WHY THIS IS WORTH AN ENDPOINT
   * A queue that is falling behind has no symptom until it has a large one.
   * Jobs are accepted normally, the API stays fast, nothing errors — and then
   * somebody notices that RADIUS profiles are six hours stale, or that
   * notifications from this morning are only arriving now. The first signal
   * anybody currently gets is a customer complaint.
   *
   * `waiting` growing steadily is the number that predicts it, and it predicts
   * it early: a backlog forming faster than the workers drain it is visible
   * long before the delay is user-noticeable. `failed` accumulating is the
   * other one — jobs that will never complete on their own and that nobody is
   * being told about.
   *
   * Never throws. A diagnostics call that can fail is a diagnostics call you
   * cannot use during an incident, which is the only time it matters.
   */
  async getQueueDepths(): Promise<{
    mode: 'bullmq' | 'inline';
    queues: Array<{ name: string; waiting: number; active: number; failed: number; delayed: number; error?: string }>;
  }> {
    if (!this.bull) {
      // Inline mode has no backlog to report because it has no queue: work
      // runs in the web process and is lost on restart. Saying "inline" is
      // more useful than reporting zeros that look reassuring.
      return { mode: 'inline', queues: [] };
    }
    const names = [...this.processors.keys()];
    const queues = await Promise.all(
      names.map(async (name) => {
        try {
          if (!this.queues.has(name)) {
            this.queues.set(name, new this.bull.Queue(name, { connection: this.connection }));
          }
          const c = await this.queues.get(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
          return {
            name,
            waiting: c.waiting ?? 0,
            active: c.active ?? 0,
            failed: c.failed ?? 0,
            delayed: c.delayed ?? 0,
          };
        } catch (e: any) {
          return { name, waiting: 0, active: 0, failed: 0, delayed: 0, error: e?.message || String(e) };
        }
      }),
    );
    return { mode: 'bullmq', queues };
  }

  /**
   * Queue instances for the Bull-Board dashboard. Ensures a Queue exists for
   * every registered processor so they all show up, even before their first job.
   */
  getBullQueues(): any[] {
    if (!this.bull) return [];
    for (const name of this.processors.keys()) {
      if (!this.queues.has(name)) {
        this.queues.set(name, new this.bull.Queue(name, { connection: this.connection }));
      }
    }
    return [...this.queues.values()];
  }

  /** Enqueue a job. Returns a job id usable with getStatus(). */
  async add(name: string, data: any = {}): Promise<string> {
    const fn = this.processors.get(name);
    if (!fn) throw new Error(`No processor registered for queue "${name}"`);

    if (this.bull) {
      let queue = this.queues.get(name);
      if (!queue) {
        queue = new this.bull.Queue(name, {
          connection: this.connection,
          defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 500 },
        });
        this.queues.set(name, queue);
      }
      const job = await queue.add(name, data);
      return `${name}:${job.id}`;
    }

    // inline fallback — run async, off the request path
    const id = `${name}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.jobStatus.set(id, { status: 'running', startedAt: Date.now() });
    setImmediate(async () => {
      try {
        const result = await fn(data);
        this.jobStatus.set(id, { status: 'completed', result, startedAt: Date.now() });
      } catch (e: any) {
        this.logger.error(`Inline job ${id} failed: ${e.message}`);
        this.jobStatus.set(id, { status: 'failed', error: e.message, startedAt: Date.now() });
      }
    });
    return id;
  }

  async getStatus(jobId: string) {
    const [name, id] = jobId.split(':');
    if (this.bull && this.queues.has(name)) {
      const job = await this.queues.get(name).getJob(id);
      if (!job) return { status: 'not_found' };
      return { status: await job.getState(), result: job.returnvalue ?? null, failedReason: job.failedReason ?? null };
    }
    return this.jobStatus.get(jobId) ?? { status: 'not_found' };
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      ...this.workers.map((w) => w.close()),
      ...[...this.queues.values()].map((q) => q.close()),
    ]);
  }
}
