/**
 * In-process log capture.
 *
 * The backend prints its logs to stdout/stderr — the terminal window that
 * launched it. On Windows there is no pm2 or journald to tail, and no log file
 * unless you redirect one, so the console's "Backend logs" tab had nothing to
 * read. This taps stdout/stderr at the source: every line still prints to the
 * terminal as before, and a copy is kept in a ring buffer the console can pull.
 *
 * install() is called once at the very top of main.ts so it captures from boot,
 * including Nest's own logger and the raw console.log lines.
 */

const MAX = 4000;
const ring: string[] = [];
let installed = false;

function push(chunk: string) {
  // A single write can contain several lines; split so the buffer is line-addressable.
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length === 0) continue;
    ring.push(line);
  }
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
}

export function installLogCapture() {
  if (installed) return;
  installed = true;
  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write.bind(stream);
    // Keep the original behaviour (terminal still shows everything), tee to buffer.
    (stream as any).write = (chunk: any, ...args: any[]) => {
      try { push(typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? ''); } catch { /* never break logging */ }
      return (original as any)(chunk, ...args);
    };
  }
}

export function readLog(lines = 400): string {
  const n = Math.min(Math.max(Number(lines) || 400, 20), MAX);
  return ring.slice(-n).join('\n');
}

export function logBufferSize() { return ring.length; }
