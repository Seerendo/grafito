# Maintenance

Run `npm run format` before submitting changes. CI verifies formatting with
`npm run format:check`. Generated routes, build output, local data, backups and
dependency files are excluded from formatting.

## MCP service boundaries

`src/routes/api/mcp.ts` authenticates the personal token and checks `api.use`.
`src/server/mcp/protocol.ts` is pure JSON-RPC: it has no database or HTTP
dependencies and is tested directly. `tools.ts` filters tools by role and runs
them against `corpus.ts`, which decides what the token's owner can open and
change and rechecks every write through the same share and upload checks as
the app.

The application remains a modular monolith. Keep these services in process:
vault mutations depend on the same authorization and persistence rules as
the REST API and browser synchronization. Existing vault access checks remain
authoritative for every write. No additional service deployment is required.

## Folder conventions

| Folder            | Responsibility                                               |
| ----------------- | ------------------------------------------------------------ |
| `src/routes/`     | File-based URLs, request parsing and HTTP responses          |
| `src/components/` | React views grouped by feature; reusable controls in `ui/`   |
| `src/app/`        | Browser state, synchronization and client-side orchestration |
| `src/domain/`     | Pure business rules and shared data contracts                |
| `src/server/`     | Authorized use cases, persistence and external integrations  |
| `src/lib/`        | Cross-cutting infrastructure such as authentication and SQL  |
| `tests/`          | Tests mirroring `domain/`, `server/` and `scripts/`          |
| `scripts/`        | Explicit development, migration and operational entry points |
| `migrations/`     | Ordered database schema changes                              |
| `docs/`           | Contributor conventions, architecture decisions and runbooks |

Keep tests and test-only fixtures outside `src/`. Tests use explicit relative
imports with `.ts` extensions for Node's type-stripping runner. Production
code and tests have separate TypeScript configurations, both checked by
`npm run typecheck`. See [tests/README.md](../tests/README.md).

Keep feature-specific helpers beside their feature. Avoid generic helper
folders that obscure ownership. A feature's server-function adapter belongs
beside its server use cases; shared browser/server contracts belong in
`domain/`, not in server implementations. `shared-tree.ts` owns the published
tree contract; the server re-exports it for existing callers. ESLint rejects
domain imports from application, UI, routes and infrastructure layers.

Write comments and contributor documentation in English. Preserve localized
interface strings, sample content and protocol identifiers. Document intent,
authorization assumptions and non-obvious constraints; tests should describe
observable behavior. Do not alter migration SQL while editing its comments.

## Architecture review

| Area                         | Assessment and maintenance rule                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and sessions  | Centralized verification, leases and server middleware. Never trust client user IDs or move server auth into browser bundles.                                                    |
| Vault and synchronization    | One authoritative server vault; browser state is a cache with merge bases. Keep REST, MCP and shared edits on the same mutation/history path.                                    |
| Sharing and workspaces       | Grants determine visible content; workspace membership alone does not grant folder access. Shared contracts now live in domain.                                                  |
| Files, Office and signatures | Storage adapters already separate bytes from metadata. Preserve per-save permission checks and version retention.                                                                |
| Tables and forms             | Authorization adapters delegate to table persistence; public forms expose creation rather than table reading. Keep those contracts distinct.                                     |
| MCP                          | Protocol, authorization corpus and tools have explicit responsibilities. A new tool declares its permission and whether it writes or deletes; deletions require `confirm`.       |
| Search, Git and mail         | Existing in-process jobs use database claims. Keep scheduling ownership explicit and avoid duplicate loops when adding features.                                                 |
| Hierarchies                  | Shared linear subtree traversal replaces repeated organization scans. Forest construction is iterative and indexes parents once. Tests cover deep and cyclic inputs.             |
| UI                           | Feature folders remain appropriate. Large views such as TableView and PdfView should be split by cohesive behavior when that behavior changes, keeping state ownership explicit. |

The review does not justify a wholesale deployment rewrite. Remaining
operational constraints are explicit: WebDAV locks and fallback rate limits
are process-local, Redis coordinates shared caches/presence, and job leases
expire rather than holding a permanent distributed lock. Consult
[OPERATIONS.md](OPERATIONS.md) before scaling replicas.

## Verification

Run `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test`
and `npm run build`. The build command also runs database migrations when
`DATABASE_URL` is configured; use an isolated database for validation.
