import { QueueService } from './queue.service';

/**
 * EVERY BACKGROUND JOB GETS RETRIES.
 *
 * A RADIUS sync, a disconnection, an invoice run — all of it goes through
 * BullMQ, and all of it was running with `attempts: 1` because the queues the
 * Bull-Board dashboard and the stats endpoint pre-created at boot had no
 * `defaultJobOptions`. One transient Redis hiccup and the job was gone, with
 * nothing in the log to say so. See the comment on `makeQueue` for the full
 * account.
 *
 * The bug was EXTRA construction sites. So the test is about construction
 * sites, not about one queue.
 */
describe('queues: job options are not silently dropped', () => {
  const src = () => require('fs').readFileSync(__dirname + '/queue.service.ts', 'utf8');

  it('the retry policy is what we think it is', () => {
    expect(QueueService.JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });

  /**
   * THE RATCHET.
   *
   * `new this.bull.Queue(` may appear exactly once in this file. A second one
   * is how the defect happened, and the diff that introduces it will not look
   * wrong — it will look like a helper politely creating the queue it needs.
   *
   * This test earned its place immediately: it found a THIRD site, on the
   * queue stats endpoint, that reading the file had missed.
   */
  it('a Queue is constructed in exactly one place', () => {
    expect((src().match(/new this\.bull\.Queue\(/g) || []).length).toBe(1);
  });

  it('and that one place passes the options', () => {
    const s = src();
    const make = s.slice(s.indexOf('private makeQueue'), s.indexOf('static readonly JOB_OPTIONS'));
    expect(make).toContain('defaultJobOptions');
    expect(make).toContain('QueueService.JOB_OPTIONS');
  });

  /**
   * Every caller must route through it. The dashboard path is the one that
   * runs first, at boot, and it is the one that was wrong.
   */
  it('no caller constructs its own queue', () => {
    const s = src();
    // Every `this.queues.set(` must hand it a makeQueue result.
    const sets = s.match(/this\.queues\.set\([^)]*\)/g) || [];
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(set).toMatch(/makeQueue|queue\b/);
    }
    expect(s).not.toMatch(/this\.queues\.set\([^)]*new this\.bull\.Queue/);
  });
});
