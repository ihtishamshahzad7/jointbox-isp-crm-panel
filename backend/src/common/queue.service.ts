import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

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

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this.bull = require('bullmq');
        this.connection = { url };
        this.logger.log('Queue: BullMQ mode');
      } catch {
        this.logger.warn('bullmq not installed — using inline job execution');
      }
    } else {
      this.logger.log('Queue: inline mode (set REDIS_URL to enable BullMQ)');
    }
  }

  registerProcessor(name: string, fn: Processor) {
    this.processors.set(name, fn);
    if (this.bull) {
      const worker = new this.bull.Worker(
        name,
        async (job: any) => fn(job.data),
        { connection: this.connection, concurrency: 2 },
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
