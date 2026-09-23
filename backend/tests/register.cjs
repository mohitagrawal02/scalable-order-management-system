/**
 * Test bootstrap: tells ts-node to use `tsconfig.test.json`.
 *
 * That config widens `rootDir` to the repo root so the integration tests in
 * `tests/` can be type-checked together with `src/` (the build tsconfig keeps
 * `rootDir: ./src` so tests are never emitted into `dist/`).
 */
const path = require('node:path');

process.env.TS_NODE_PROJECT = path.join(__dirname, '..', 'tsconfig.test.json');
require('ts-node/register');