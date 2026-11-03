# Tests

Tests mirror the production folders: `tests/domain/` tests `src/domain/`,
`tests/server/` tests `src/server/`, and `tests/scripts/` tests `scripts/`.
Keep executable tests and test-only fixtures here, outside production source.

Run everything with `npm test`, or a focused suite with
`node --experimental-strip-types --test tests/server/ai/engine.test.ts`.
The project targets Node 22. Imports in executable TypeScript tests must use
relative paths with `.ts` extensions, because Node does not resolve Vite aliases.
`npm run typecheck` checks production code and tests separately.

Use deterministic fakes for provider calls and temporary directories for files.
Do not require real credentials or a running external service in unit tests.
Test observable behavior, permissions, failures and cancellation rather than
implementation details. Live provider checks belong in explicitly invoked scripts.
