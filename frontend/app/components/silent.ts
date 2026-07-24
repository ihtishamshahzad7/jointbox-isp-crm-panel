/**
 * Shared error handler for fire-and-forget API calls.
 *
 * Instead of `.catch(() => {})` which silently discards every error, this logs
 * the context and error to the console. In development the full stack trace is
 * visible; in production the log line is at least searchable in the browser
 * console.
 *
 * Usage:
 *   fetch(...).then(...).catch(silent("fetchWidgets"))
 *   get("/data").then(setData).catch(silent("loadData"))
 */

export function silent(context: string) {
  return (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[silent] ${context}: ${msg}`);
    if (process.env.NODE_ENV === 'development' && err instanceof Error) {
      console.debug(err);
    }
  };
}