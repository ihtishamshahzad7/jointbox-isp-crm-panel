/**
 * MAKE BigInt SURVIVE JSON SERIALISATION.
 *
 * WHY THIS FILE HAS TO EXIST
 * `JSON.stringify({ id: 10n })` does not return `{"id":10}`. It throws:
 *
 *     TypeError: Do not know how to serialize a BigInt
 *
 * Prisma maps a `BigInt` column to a JavaScript `bigint`, and Nest serialises
 * every response with `JSON.stringify`. So the moment the twelve append-only
 * tables became `BigInt`, every endpoint returning one of their rows — the
 * logs page, the syslog viewer, network events, ONU telemetry, RADIUS
 * accounting — would answer 500 instead of data. The database migration and
 * this shim are one change; shipping either alone breaks the product.
 *
 * WHY A STRING AND NOT A NUMBER
 * Emitting a number would keep today's API byte-identical, because every id
 * in existence right now is small. It would also be the same class of bug
 * being fixed here, moved somewhere harder to see: JavaScript numbers are
 * IEEE-754 doubles and lose integer precision above 2^53 (9,007,199,254,740,991).
 * Past that point `JSON.parse` silently rounds, so two different rows can
 * arrive at the browser sharing an id. Nothing raises an error; a list simply
 * starts behaving strangely.
 *
 * 2^53 is far away, but so was 2^31 when these columns were created, and the
 * whole reason this migration is happening now — while the tables are small
 * and the conversion takes seconds — is that "far away" arrives. A string is
 * exact at every magnitude.
 *
 * WHAT CALLERS SEE
 * These ids become JSON strings: `{"id":"4211"}` rather than `{"id":4211}`.
 * They are opaque handles — React keys, row identities, lookup arguments —
 * and the frontend compares them against other ids from the same responses,
 * which stays correct because both sides are strings. Code that compared such
 * an id to a numeric literal would break, which is exactly why this lands now,
 * with tiny values and an empty database, rather than after real data exists.
 *
 * WHY A PROTOTYPE PATCH RATHER THAN AN INTERCEPTOR
 * A Nest interceptor only covers controller responses. `JSON.stringify` is
 * also called by the logger, by webhook delivery, by BullMQ when it persists
 * job payloads, and by anything else that stringifies a Prisma row. Each of
 * those is a separate 500 waiting to happen, and each would be found
 * separately, in production. Defining `toJSON` on the prototype fixes the one
 * place all of them go through.
 */

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

/**
 * Idempotent, and deliberately non-enumerable.
 *
 * Assigning a plain property to a built-in prototype makes it enumerable,
 * which means it shows up in `for...in` over any object — the classic way a
 * prototype patch breaks unrelated library code. `defineProperty` keeps it
 * invisible to iteration while `JSON.stringify` still finds it.
 */
export function installBigIntJson(): void {
  if (Object.prototype.hasOwnProperty.call(BigInt.prototype, 'toJSON')) return;
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint) {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

// Applied on import so that merely importing this module is enough. Bootstrap
// imports it first, before any Prisma row can reach a serialiser.
installBigIntJson();
