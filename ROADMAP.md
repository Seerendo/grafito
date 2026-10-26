# Roadmap

What is planned beyond v0.0.x, roughly in priority order.

The "decided" notes record choices that are already made, so work can start
from them.

## Done in this round

- Version history for notes, with author, diff and restore.
- Trash with restore and 30-day retention.
- Sharing with read-only or edit access.
- Scheduled database backups with retention, plus a restore runbook
  ([docs/OPERATIONS.md](docs/OPERATIONS.md)).
- Encryption-key rotation (`GRAFITO_ENCRYPTION_KEY_PREVIOUS`).
- Security headers and a Content Security Policy, plus a custom 404 page.
- CI on GitHub Actions (typecheck, lint, tests, build, Docker image).
- AGPL-3.0 license.
- MinIO capacity in the storage panel.
- Files in object storage (item 4 below): chunked uploads up to a
  configurable limit (100 MB by default), signed links, migration of older
  files, a bucket backup, and a Postgres fallback without MinIO.

## 1. Office documents (decided: Collabora Online)

Goal: edit Word, Excel, PowerPoint and OpenDocument files (`.docx`, `.xlsx`,
`.pptx`, `.odt`, `.ods`, `.odp`) inside Grafito, with native track changes.

- **Engine:** Collabora Online (the CODE image, MPL licensed), added as an
  optional `office` profile in `docker-compose.yml`.
- **Protocol:** Grafito implements the WOPI host endpoints:
  - `CheckFileInfo`, `GetFile` and `PutFile`, under `/wopi/files/:id`.
  - Short-lived access tokens, scoped to one document and one user.
- **Permissions:** the Grafito role and share access decide whether Collabora
  opens a document read-only or editable.
- **Versions:** every `PutFile` creates a version in the document history.
- **Prerequisite (done):** item 4, files in object storage. Office files now
  fit within the upload limit, and Collabora reads and writes them through
  `server/blobs.ts`.

## 2. Team spaces

- Spaces owned by an organization rather than a person, each with its own
  home page.
- Per-portfolio permissions inside a space: read, edit, manage.
- Notifications for new shares, mentions (`@name`), and public links about to
  expire.

## 3. Real SSO

- Map identity-provider groups to Grafito roles and organizations.
- Automatic deprovisioning when the account is disabled at the provider
  (SCIM, or a check on each sign-in).
- Single logout (OIDC RP-initiated logout).
- Multi-factor authentication for local accounts (TOTP).

## 4. Files in object storage (mostly done)

Done: storage in MinIO / S3 (or Postgres), chunked uploads with a configurable
limit, signed links, migration of older files, and a bucket backup.

Still open:

- Resumable uploads across page reloads.
- A sweep for orphan uploads (started but never attached to a document).
- Antivirus scanning on upload (ClamAV), as an optional profile.
- Previews for Office files, generated as PDF through Collabora's convert API.

## 5. Search and API

- Full-text search of note bodies in the search palette (Elasticsearch is
  already indexing them).
- API search endpoint, webhooks for note events, and tokens with an expiry and
  scopes.

## 6. Governance and audit

- Exportable audit log (CSV and JSON) with a retention setting.
- Expiry dates on public links, and bulk revocation from administration.
- Retention settings for logs, trash and versions.
- Bulk export per user or organization (Markdown plus files, as a ZIP) for
  portability and offboarding.
- Usage reports: orphan notes, broken links, inactive accounts, storage per
  person.

## 7. Knowledge workflows

- Note templates and reusable blocks.
- A draft → review → published flow, with reviewers.
- AI agent safety:
  - A confirmation step before the AI writes.
  - A log of the agent's actions that can be undone. Versions already make
    every AI edit reversible by hand.
  - A check that the model actually called a tool before it claims it did.

## 8. Platform

- Interface translations (i18n), starting with English.
- Offline-first mobile client with conflict resolution.
- External observability: OpenTelemetry traces and a Prometheus `/metrics`
  endpoint.
- A real extension system instead of on/off plugin flags.
- A nonce-based Content Security Policy (drop `'unsafe-inline'` for scripts).
