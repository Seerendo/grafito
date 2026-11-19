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

`tests/e2e/` holds browser tests that need the local test stack, a running dev
server and Playwright (not a project dependency), so `npm test` does not run
them. `pdf-signatures.e2e.mjs` explains how to start them; it seeds and resets
its own `e2esig-` rows. `admin-tools.e2e.mjs` runs against the test stack's
gateway (`http://127.0.0.1:8080`), writes only `e2eadm` rows and restores the
extension settings it changes. `uploads.e2e.mjs` resets the `e2eup-user` vault and
drops folders the way a browser hands them over (filesystem entries), so empty
folders are covered. `vault-pages.e2e.mjs` creates fresh `e2evp-` members
each run. Run each file and each browser on its own: sign-in is rate limited
on the gateway, and one combined run hung. `security.e2e.mjs` checks the
fixes of the November 2026 security review (one test per finding; GRAF-01 needs
a throwaway instance on an empty database, see its header).
`auth-providers.e2e.mjs` signs in through the test stack's OpenLDAP and
Keycloak (`auth-test` profile) and restores the provider settings it changes.
