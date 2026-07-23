/**
 * Tiny concurrency limiter — no external dependency.
 *
 * Polling 200 routers sequentially takes ~5s each = 17 minutes per cycle.
 * Firing all 200 at once exhausts sockets and the DB pool. The sweet spot is a
 * bounded worker pool: N in flight at a time, the rest queued.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: any }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: any }> = new Array(items.length);
  if (!items.length) return results;

  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        // One bad router must never abort the whole sweep.
        results[i] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Reject a promise that takes too long.
 *
 * A hung MikroTik API socket would otherwise occupy a worker slot for the full
 * TCP timeout and stall the cycle behind it.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
