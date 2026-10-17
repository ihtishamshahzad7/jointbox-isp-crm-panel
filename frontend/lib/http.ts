/**
 * Throw on a refused request, with the server's own message.
 *
 * Many screens awaited `fetch(...)` for a write and then carried on as if it
 * had worked — fetch only rejects on a network failure, never on a 400/403/
 * 500. So a refused top-up closed its dialog, a failed delete refreshed the
 * list, and the operator was told nothing. Wrapping the call makes a refusal
 * an error the screen's existing catch (or the browser console) sees.
 */
export async function mustOk(res: Response): Promise<Response> {
  if (res.ok) return res;
  let message: unknown = "";
  try {
    message = ((await res.clone().json()) as { message?: unknown })?.message;
  } catch {
    /* not JSON */
  }
  const text = Array.isArray(message) ? message.join(", ") : String(message || "");
  throw new Error(text || `Request failed (HTTP ${res.status})`);
}
