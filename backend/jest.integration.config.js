/**
 * Integration tests — separate from the unit suite on purpose.
 *
 * `npm test` must stay fast and dependency-free so it runs on every save and
 * in every pre-commit. These need a live PostgreSQL, take seconds rather than
 * milliseconds, and would make the unit suite something developers skip.
 *
 * They are also the only tests that can judge the R1 fixes: a lock, a unique
 * constraint and a sequence are database behaviours, and a mocked client
 * reports all three as working whether they are or not.
 *
 * Run with:  npm run test:integration
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/integration/.*\\.integration\\.spec\\.ts$',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
  // These tests contend on purpose; the default 5s is not enough for a
  // 500-way race plus schema setup on a cold database.
  testTimeout: 60_000,
  // Each suite owns a schema, so files are isolated — but they share one
  // PostgreSQL. Serial keeps the resource accounting honest and the failures
  // readable; parallelism here buys a few seconds and costs clarity.
  maxWorkers: 1,
};
