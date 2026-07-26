import { Injectable, Logger, OnModuleInit, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ScopeService, Actor } from '../common/scope.service';

/** Handler signature. `update` lets a job report progress as it runs. */
export type JobHandler = (
  payload: any,
  update: (done: number, total?: number) => Promise<void>,
  job: { id: number; createdById: number | null; rootId: number | null },
) => Promise<any>;

/**
 * Durable async job queue (J6). Unlike the in-memory QueueService, every job is
 * a row in the Job table, so it survives restarts, is scoped to the owning ISP
 * subtree, and can be listed and watched in the UI. A single in-process poller
 * drains QUEUED jobs one at a time and runs the registered handler, updating
 * progress on the row. Set-and-forget from the caller's point of view — the
 * HTTP request returns a job id immediately.
 */
@Injectable()
export class JobsService implements OnModuleInit {
  private readonly logger = new Logger(JobsService.name);
  private handlers = new Map<string, JobHandler>();
  private draining = false;

  constructor(private prisma: PrismaService, private scope: ScopeService) {}

  /** Other services call this at startup to expose a job type. */
  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
    this.logger.log(`Registered job handler: ${type}`);
  }

  registeredTypes() {
    return [...this.handlers.keys()];
  }

  async onModuleInit() {
    // Built-in handler used to exercise the queue end-to-end (progress, done,
    // result) without any side effects. payload: { steps?: number, ms?: number }.
    this.register('demo.progress', async (payload, update) => {
      const steps = Math.max(1, Math.min(Number(payload?.steps ?? 5), 100));
      const ms = Math.max(0, Math.min(Number(payload?.ms ?? 300), 5000));
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, ms));
        await update(i, steps);
      }
      return { steps, message: `Completed ${steps} steps` };
    });

    // A job left RUNNING means the process died mid-flight. Requeue it so the
    // poller picks it up again rather than leaving it stuck forever.
    try {
      await this.prisma.job.updateMany({ where: { status: 'RUNNING' }, data: { status: 'QUEUED', progress: 0, done: 0 } });
    } catch { /* table may not exist until db:push — ignore on first boot */ }
    void this.drain();
  }

  /** Enqueue a job. Returns the created row. Kicks the poller. */
  async enqueue(type: string, opts: { payload?: any; label?: string; actor?: Actor } = {}) {
    if (!this.handlers.has(type)) {
      throw new NotFoundException(`No job handler registered for "${type}"`);
    }
    const actor = opts.actor;
    const rootId = actor ? await this.scope.rootId(actor).catch(() => null) : null;
    const job = await this.prisma.job.create({
      data: {
        type, status: 'QUEUED', label: opts.label ?? type,
        payload: opts.payload ?? undefined,
        createdById: (actor as any)?.sub ?? (actor as any)?.id ?? null,
        rootId,
      },
    });
    void this.drain();
    return job;
  }

  /** Drain the queue one job at a time. Re-entrant-safe via the draining flag. */
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const job = await this.prisma.job.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
        if (!job) break;
        await this.run(job);
      }
    } catch (e: any) {
      this.logger.error(`Job drain error: ${e?.message}`);
    } finally {
      this.draining = false;
    }
  }

  private async run(job: any) {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.prisma.job.update({ where: { id: job.id }, data: { status: 'FAILED', error: `No handler for ${job.type}`, finishedAt: new Date() } });
      return;
    }
    await this.prisma.job.update({ where: { id: job.id }, data: { status: 'RUNNING', startedAt: new Date(), progress: 0, done: 0 } });

    const update = async (done: number, total?: number) => {
      const t = total ?? job.total ?? 0;
      const progress = t > 0 ? Math.min(100, Math.round((done / t) * 100)) : Math.min(99, done);
      await this.prisma.job.update({ where: { id: job.id }, data: { done, ...(total != null ? { total } : {}), progress } }).catch(() => null);
    };

    try {
      const result = await handler(job.payload ?? {}, update, { id: job.id, createdById: job.createdById, rootId: job.rootId });
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'DONE', progress: 100, result: result ?? undefined, finishedAt: new Date() },
      });
    } catch (e: any) {
      this.logger.error(`Job #${job.id} (${job.type}) failed: ${e?.message}`);
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: String(e?.message ?? e).slice(0, 500), finishedAt: new Date() },
      });
    }
  }

  /** Tenant-scoped list for the queue view. */
  async list(actor: Actor, status?: string, limit = 50) {
    const where: any = {};
    if (status && status !== 'ALL') where.status = status;
    // Non-ISP accounts see only jobs in their own subtree.
    if (actor && !this.scope.isAdmin((actor as any)?.role)) {
      const rootId = await this.scope.rootId(actor);
      where.rootId = rootId;
    }
    return this.prisma.job.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 200) });
  }

  async get(actor: Actor, id: number) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Job not found');
    if (actor && !this.scope.isAdmin((actor as any)?.role) && job.rootId != null) {
      const rootId = await this.scope.rootId(actor);
      if (job.rootId !== rootId) throw new ForbiddenException('This job belongs to another account.');
    }
    return job;
  }
}
