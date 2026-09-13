/**
 * THIS FILE IS NOT A MIDDLEWARE, AND DELIBERATELY SO.
 *
 * ── What was here ────────────────────────────────────────────────────────
 * A `middleware()` export that redirected any unauthenticated request to
 * `/login`, matching `/dashboard`, `/subscribers`, `/packages`, `/nas` and
 * `/logs`. It has never run once, in any environment.
 *
 * Next.js loads middleware from exactly two places — the project root
 * (`frontend/middleware.ts`) or `src/middleware.ts`. This file sits in
 * `app/`, where the App Router treats it as an ordinary module: nothing
 * imports it, so nothing executes it. No error, no warning, no redirect.
 *
 * ── Why it was NOT simply moved up a directory ───────────────────────────
 * Because that would have broken every login in the panel. The code read the
 * JWT from a `token` COOKIE; this application has never put it in one — it
 * lives in `localStorage` (see `app/components/use-sse.ts`, and every API
 * caller). Middleware runs at the edge, before any client script, and cannot
 * read `localStorage` at all. Activating it would have sent every
 * authenticated operator to `/login` on every navigation, permanently.
 *
 * So the finding is two bugs stacked: a control that does not run, which
 * would not work if it did.
 *
 * ── Why nothing replaces it ──────────────────────────────────────────────
 * A redirect is not an access control. It hides a page from a browser; it
 * does not stop anyone calling the API that page would have called. The
 * authorization boundary is, and must remain, the backend — `JwtAuthGuard`,
 * `PermissionsGuard`, and `ScopeService`. The client-side auth check already
 * handles the user-experience half (bounce an expired session back to the
 * login form), and it CAN read `localStorage`.
 *
 * If a real edge middleware is ever wanted, it belongs at
 * `frontend/middleware.ts` — and it is worth having only AFTER the token
 * moves to an httpOnly cookie, which is the plan written up in
 * `docs/AUTH-COOKIE-MIGRATION.md`. The cookie has to exist first.
 *
 * Keeping the file, emptied, rather than deleting it: the next person to
 * wonder "why is there no middleware?" should find this answer instead of
 * re-introducing the same broken one.
 */
export {};
