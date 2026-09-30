/**
 * Test bootstrap: tells ts-node to use `tsconfig.test.json`.
 *
 * That config widens `rootDir` to the repo root so the integration tests in
 * `tests/` can be type-checked together with `src/` (the build tsconfig keeps
 * `rootDir: ./src` so tests are never emitted into `dist/`).
 */
const path = require('node:path');

process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.test.json');

/**
 * Day 8: the access log emits one structured line PER REQUEST, so a test run
 * that hits the API a hundred times would print a hundred JSON lines per file -
 * noise that buries the actual test output. Tests that care about logs install
 * their own capture sink (`setLogSink`) and lower the level themselves;
 * everything else runs at `error`.
 *
 * Set LOG_LEVEL explicitly to override, e.g.
 *   LOG_LEVEL=debug npm test   → watch every access/cache/outbox line.
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

require('ts-node/register');