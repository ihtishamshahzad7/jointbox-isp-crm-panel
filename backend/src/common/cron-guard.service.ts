import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { isPrimaryInstance } from './cluster-util';

/**
 * Structural enforcement of the "background work runs on ONE process" rule.
 *
 * WHY THIS EXISTS
 *
 * Every @Cron method is supposed to start with `if (!isPrimaryInstance()) return;`.
 * That is a convention, and conventions are enforced by whoever remembers them.
 * An audit found 25 cron methods that did not have the guard, running on all 11
 * pm2 web workers at once — the duplicate-session sweep logging the same row
 * twelve times was one visible symptom, but every unguarded job was doing its
 * side effects twelve times over.
 *
 * Adding the missing guards fixed those 25. It did nothing about the twenty-
 * sixth, which will be written next month by someone who never read this file.
 *
 * So instead of DETECTING the missing guard, this removes the possibility: on a
 * process that is not the primary instance, every registered cron job is
 * unregistered at boot. An unguarded cron on a web node cannot fire, because
 * there is no longer a job to fire. The per-method guards stay where they are —
 * belt and braces, and they keep the intent readable at the call site.
 *
 * OPT-OUT
 *
 * Some work genuinely is per-process (in-memory cache eviction, local metrics).
 * List those job names in CRON_ALWAYS, comma-separated, and they are left alone.
 * Nest names a job after its method unless @Cron was given an explicit name.
 */
@Injectable()
export class CronGuardService implements OnApplicationBootstrap {
  private readonly log = new Logger('CronGuard');

  constructor(private readonly registry: SchedulerRegistry) {}

  onApplicationBootstrap() {
    const role = process.env.JOINTBOX_ROLE || 'all';
    const inst = process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? '—';

    if (isPrimaryInstance()) {
      const count = this.safeJobCount();
      this.log.log(
        `Primary instance (role=${role}, pm2 instance=${inst}) — ${count} scheduled job(s) active here.`,
      );
      return;
    }

    const keep = new Set(
      (process.env.CRON_ALWAYS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    let removed = 0;
    const kept: string[] = [];

    // Snapshot the names first: deleting while iterating the registry's own map
    // is asking for trouble.
    let names: string[] = [];
    try {
      names = [...this.registry.getCronJobs().keys()];
    } catch {
      // No jobs registered at all (or a Nest version that throws on empty).
      names = [];
    }

    for (const name of names) {
      if (keep.has(name)) {
        kept.push(name);
        continue;
      }
      try {
        this.registry.getCronJobs().get(name)?.stop();
        this.registry.deleteCronJob(name);
        removed++;
      } catch (e: any) {
        // Never let this take the process down — a cron that failed to stop is
        // a duplicated job, which is exactly the bug we already survive today.
        this.log.warn(`Could not stop cron "${name}": ${e?.message || e}`);
      }
    }

    // Intervals and timeouts registered via @Interval/@Timeout are singleton
    // background work too, and have the same duplication problem.
    let intervals = 0;
    try {
      for (const name of [...this.registry.getIntervals()]) {
        if (keep.has(name)) { kept.push(name); continue; }
        this.registry.deleteInterval(name);
        intervals++;
      }
    } catch { /* none registered */ }

    this.log.log(
      `Not the primary instance (role=${role}, pm2 instance=${inst}) — ` +
        `stopped ${removed} cron job(s) and ${intervals} interval(s). ` +
        `Background work belongs to the worker.` +
        (kept.length ? ` Kept by CRON_ALWAYS: ${kept.join(', ')}.` : ''),
    );
  }

  private safeJobCount(): number {
    try {
      return this.registry.getCronJobs().size;
    } catch {
      return 0;
    }
  }
}
