# Email accounts (Correo electrónico)

Each person connects their own mail accounts (Zimbra or any IMAP server, Gmail,
Microsoft 365 / Outlook.com). Grafito copies them in the background and shows
them in **Correo electrónico** (avatar menu). Messages and attachments can be
searched, read and archived into portfolios as ordinary documents. Grafito only
reads: it never sends, moves or deletes mail on the server.

This is not the SMTP server Grafito uses to send its own notices; that one is in
[MAIL.md](MAIL.md).

## Architecture

```text
 Browser ── /correo ──► Grafito web (app)                    mail servers
                         │  server functions, MCP tools        ▲
                         │  enqueue jobs, read messages        │ IMAP (TLS), Gmail API,
                         ▼                                     │ Microsoft Graph
                     PostgreSQL ◄────── grafito-mail-sync ─────┘
                     (accounts, folders,  (service mail-sync:
                      messages, jobs,      claims jobs, syncs in
                      heartbeats)          bounded slices)
                         ▲                     │
                         │                     ▼
                       MinIO ◄──── downloaded attachments, archived files
                       ClamAV ◄─── every downloaded attachment is scanned
```

- **mail-sync** (`src/mail-worker/main.ts`, `server/mail/worker.ts`) is a
  process of its own: the app image started with `node .output-mail/main.mjs`.
  The web app never holds a connection for a sync. Several can run side by
  side (`docker compose up -d --scale mail-sync=2`).
- **Queue:** `mail_job` in Postgres (no new service). A job with the same
  dedupe key is not queued twice. Workers claim with `FOR UPDATE SKIP LOCKED`
  and a three-minute lease they renew; a worker that dies leaves an expired
  lease and the job is claimed again. One sync per account at a time (the
  account lease); attachment downloads have a lease of their own, so opening
  one never waits for a sync. `pg_notify('mail_job')` wakes a worker at once;
  polling every 2 s covers the rest. BullMQ was not used: Grafito's
  background jobs already use Postgres claims, and the queue must survive
  restarts with the data it refers to.
- **Bounded slices:** a sync runs for at most `MAIL_SYNC_SLICE_SECONDS` (25)
  and `MAIL_SYNC_BATCH` (400) messages, then goes back to the queue behind the
  other accounts (lower priority). A big mailbox cannot hold a worker.
- **Scheduler:** every 30 s one worker (claim `mail-scheduler`) queues the
  accounts that are due (`next_sync_at`), 5 minutes apart by default.
- **Heartbeat:** each worker writes `mail_worker.beat_at` every 10 s and
  `/tmp/mail-sync-beat` (the container healthcheck). The **Correo electrónico**
  extension is connected while a heartbeat is under a minute old.

### Providers

`server/mail/providers/types.ts` is the contract: `test`, `sync` (one bounded
pass), `fetchAttachment`, `fetchRaw` (.eml) and `close`. Each keeps its own way
of syncing.

| Provider                | Integration                           | Sign-in                  | Incremental sync                                                                                                   |
| ----------------------- | ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Zimbra, generic IMAP    | IMAP over TLS (993) or STARTTLS (143) | Password or app password | UIDVALIDITY per folder; new UIDs above the last confirmed one; CONDSTORE/MODSEQ for flags; periodic reconciliation |
| Exchange on premises    | IMAP, when the server enables it      | As the server allows     | As IMAP                                                                                                            |
| Gmail                   | Gmail API (`gmail.readonly`)          | OAuth 2.0 + PKCE         | History API from the stored history id; labels as folders                                                          |
| Microsoft 365 / Outlook | Microsoft Graph (`Mail.Read`)         | OAuth 2.0 + PKCE         | Delta query per folder (delta link), immutable ids                                                                 |

**IMAP in detail** (`providers/imap.ts`):

1. The host is resolved once and checked (see SSRF below); the connection goes
   to that address with the host name kept for TLS, so the certificate is
   validated against the name. Certificates are always validated.
2. Folders are listed (special-use flags, names as a fallback). Spam, trash
   and "all mail" are listed but not synced unless the person turns them on.
3. Per folder: a changed UIDVALIDITY marks every stored location of the folder
   gone and fetches it again. New messages are the UIDs above the last
   confirmed one. The history window (30 days by default) is fetched newest
   first and resumes from its cursor; messages already there are visible
   while the rest arrives.
4. Flags come from CONDSTORE (`CHANGEDSINCE`) when the server has it; every 30
   minutes a reconciliation compares UIDs (deleted on the server) and, without
   CONDSTORE, flags.
5. Each batch is stored before its cursor is saved, with upserts keyed by
   `folder:uidvalidity:uid`: a retried batch leaves one copy.

IMAP IDLE was evaluated and not used: it needs one connection per account and
folder, permanently. Polling every few minutes, with the bounded slices, keeps
connections short and their number bounded by the worker's concurrency.

## Data model (migration 0048)

| Table                                                         | Holds                                                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mail_account`                                                | Owner, provider, address, server, sealed secret, sync settings, status, MCP permission, leases             |
| `mail_folder`                                                 | Folders or labels of an account, role (special use), whether they sync, counters                           |
| `mail_sync_state`                                             | Cursor per folder (UIDVALIDITY, last UID, MODSEQ, backfill cursor, delta link) or per account (history id) |
| `mail_message`                                                | Normalized message: headers, text, HTML, snippet, remote and local flags, search vector                    |
| `mail_message_location`                                       | Where a message is: folder, UID, UIDVALIDITY, flags; a Gmail message has one per label                     |
| `mail_attachment`                                             | Attachment metadata; once downloaded, its storage key, checksum and antivirus result                       |
| `mail_archive_reference`                                      | Which document an archived message or attachment became (the document is independent)                      |
| `mail_job`, `mail_worker`, `mail_oauth_state`, `mail_profile` | Queue, heartbeats, OAuth sign-ins in progress, institutional profiles                                      |

Every table carries `user_id`, and every query filters by it. Two messages with
the same Message-ID are not merged. Attachment bytes live in MinIO
(`mail/<user>/<account>/<attachment>`), never in Postgres when MinIO is there.

## Using it

- **Connect:** **Correo electrónico** → gear → **Conectar una cuenta**. With
  an institutional profile, the address and password are enough (the domain
  of the address picks the profile). Otherwise, the IMAP server and port. The
  password is tried once before anything is stored. Gmail and Microsoft use
  their own sign-in page.
- **Per account:** name, default account, automatic sync and its frequency
  (within the administrator's minimum), folders that sync, new credentials,
  **Volver a autorizar** (OAuth), **Permitir acceso por MCP**, **Desconectar**
  (credentials forgotten, messages kept) and **Borrar la copia local**
  (messages and downloaded attachments deleted here, archived documents kept).
  Nothing ever changes on the mail server.
- **Reading:** unified inbox and per account, sent, drafts, archive, spam,
  mail trash, starred and the server's own folders. Search (subject, people,
  attachment names, text) and filters (unread, with attachments, sender,
  dates, account). The list pages with a keyset cursor and draws only the rows
  on screen. Read, starred and hidden are kept in Grafito only.
- **Attachments** are downloaded when opened: the worker fetches them,
  ClamAV scans them, and PDFs, images, audio, video and text open in Grafito's
  viewers. Office files open once saved into the vault (Collabora edits vault
  documents). Executables and disk images are only downloaded.
- **Archiving:** a message as a Markdown note (provenance table, the text in a
  fence), plain text or the original `.eml` (exact source, fetched by the
  worker); attachments as files. Into the Carpeta Personal, one of its
  portfolios, a new one, or a share or workspace where the person can add
  files. The note links to the attachments saved with it, so the graph shows
  them together. Archived documents follow the normal upload path (rights,
  quota, antivirus, indexing) and stay when the message is deleted on the
  server or the account is disconnected.

## Administration

**Administración → Cuentas de correo** (permission `mailbox.manage`; using the
module needs `mailbox.use`, on for Miembro by default). The module is the
**Correo electrónico** extension (Administración → Extensiones), off until an
administrator turns it on, which needs mail-sync running.

- **Figures** for every account (not only the administrator's): people with
  accounts, accounts by state, messages, stored attachments and space, queued,
  running and failed jobs, average sync time, queue wait, worker heartbeats,
  errors by provider. No subject, body, attachment or credential is shown.
- **Controls** (audited): pause all syncing, a provider or an account; retry
  failed jobs.
- **Policy:** providers allowed, email domains, IMAP servers allowed besides
  the profiles (`*.domain` works), profiles only, accounts per person, minimum
  and default frequency, history window, largest attachment, attachment space
  per person, largest stored body, jobs per worker and per provider, whether
  bodies are searchable.
- **Institutional profiles:** name, host, port (993 or 143) and the email
  domains that suggest it. A profile's host may be on a private network.
- **OAuth applications:** client id, secret (stored encrypted, never shown) and,
  for Microsoft, the tenant. The page shows the redirect address to register.

### Zimbra

Add a profile with the Zimbra mail host (for example `mail.universidad.edu`,
port 993) and the institution's domain. People then connect with their address
and password. If the server is reachable only inside the network, the profile
is what allows it. If its certificate comes from the institution's own
authority, mount the CA and set `NODE_EXTRA_CA_CERTS` on **both** `app` and
`mail-sync`.

### Generic IMAP

Any server with IMAP over TLS (993) or STARTTLS (143). Providers that require
app passwords (Yahoo, iCloud, Gmail by IMAP) work with one. Cleartext IMAP is
not supported.

### Gmail

1. In Google Cloud: a project, the Gmail API enabled, an OAuth client of type
   "Web application" with the redirect address shown in administration
   (`https://your-grafito/api/mail/oauth/callback`), the scope
   `https://www.googleapis.com/auth/gmail.readonly`, and the consent screen.
2. Paste the client id and secret in **Aplicaciones OAuth → Google**.

### Microsoft 365 / Outlook.com

1. In Entra ID (Azure): an app registration, platform "Web", the same redirect
   address, delegated permissions `Mail.Read`, `User.Read`, `offline_access`.
   For Outlook.com and other tenants, supported account types "any directory
   and personal accounts", tenant `common`; for one organization, its tenant id.
2. Paste the client id, secret and tenant in **Aplicaciones OAuth → Microsoft**.

## Configuration

| Variable (service `mail-sync`) | Default    | Meaning                                                                  |
| ------------------------------ | ---------- | ------------------------------------------------------------------------ |
| `MAIL_SYNC_ENABLED`            | `true`     | `false` keeps the worker idle (no heartbeat: the extension shows it off) |
| `MAIL_SYNC_CONCURRENCY`        | policy (4) | Jobs at once in this worker                                              |
| `MAIL_SYNC_SLICE_SECONDS`      | `25`       | Longest slice of one sync before it goes back to the queue               |
| `MAIL_SYNC_BATCH`              | `400`      | Most messages per slice                                                  |
| `MAIL_SYNC_DB_POOL`            | `6`        | Database connections of one worker                                       |
| `MAIL_SYNC_MEMORY`             | `512m`     | Container memory limit                                                   |
| `NODE_EXTRA_CA_CERTS`          | empty      | CA file for mail servers with a private certificate                      |

The worker reads `DATABASE_URL`, the S3 settings and the encryption key like the
app. It takes the installation secrets the app created (read-only volume) and
never creates them; on a fresh install it waits until the app has started.

**Outbound access** the worker (and the app, to test a connection) needs:
the IMAP servers on 993/143; `gmail.googleapis.com` and `oauth2.googleapis.com`
for Gmail; `graph.microsoft.com` and `login.microsoftonline.com` for Microsoft.

## Security

- **Credentials** are sealed with `GRAFITO_ENCRYPTION_KEY` (AES-256-GCM, the
  same as Git tokens), never returned to the browser, never logged. Rotating
  the key works as for the other secrets (OPERATIONS.md). OAuth client secrets
  stay on the server.
- **OAuth:** authorization code with PKCE (S256), a random single-use `state`
  bound to the person and valid ten minutes, read-only scopes. The provider
  sends the person back to `/correo`, where their own session finishes the
  sign-in: a link prepared by someone else cannot attach a mailbox to another
  Grafito account. `invalid_grant` marks the account expired, not retried.
- **Isolation:** every query filters by the signed-in person. An attachment
  link is signed for its owner and expires in ten minutes. Administrators see
  figures, not messages.
- **SSRF:** the IMAP host is resolved once; loopback, link-local, cloud
  metadata, multicast and Grafito's own services are refused; a private
  address only through a profile or the administrator's list; ports 993 and
  143 only; the connection goes to the checked address (no DNS rebinding).
  Gmail and Graph addresses are fixed.
- **HTML:** cleaned in the browser (no scripts, frames, forms, SVG, event
  handlers; links only http, https, mailto, opened outside) and shown in an
  iframe sandboxed without scripts and without the app's origin, with its own
  CSP. Remote images (tracking pixels) are blocked until the person loads them;
  embedded `cid:` images are fetched as attachments.
- **Attachments:** size limit, safe file names (no paths, control characters
  or reserved names), executables and double extensions only downloadable,
  ClamAV on every download, and a scanner failure is a refusal, not a clean
  result. Served with `nosniff` and a restrictive CSP.
- **MCP:** only accounts whose owner turned on «Permitir acceso por MCP», only
  for that owner. Mail text comes back under `untrusted_content`, and the
  server instructions tell clients never to follow instructions found there.
  No MCP tool sends, moves or deletes mail.

Residual risks: the worker runs as the same user as the app (it reads the
installation secrets); an MCP client that ignores the untrusted-content marking
could still act on what a message says (its own permissions bound the damage,
and deletions need `confirm`); IMAP to a private server named in a profile
reaches that server for every person.

## Troubleshooting

| What you see                                | Why / what to do                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The extension does not turn on              | `mail-sync` is not running or not reaching Postgres: `docker compose ps mail-sync`, its logs           |
| «El certificado del servidor no es válido…» | The server's certificate does not match its name or comes from a private CA: `NODE_EXTRA_CA_CERTS`     |
| «Ese servidor está en una red privada…»     | Add an institutional profile for it (or the administrator's allowed list)                              |
| «Error de autenticación»                    | Wrong password, or the provider needs an app password; update the credentials                          |
| «Autorización caducada»                     | The refresh token was revoked or expired: **Volver a autorizar**                                       |
| «Reintento programado a las …»              | The server did not answer or asked to wait; retried with backoff (with jitter, respecting Retry-After) |
| An attachment stays «Descargando…»          | Look at the worker's logs; MinIO or ClamAV may be down; it is retried a few times                      |
| Many failed jobs                            | **Reintentar trabajos fallidos**; wrong credentials are not retried until the owner fixes them         |

## Recovery

State is in Postgres: restarting the app, the worker or both resumes from the
last confirmed cursor. A job a worker was running when it stopped goes back to
the queue when its lease expires (at most three minutes; at once on a clean
stop). A lost Gmail history id or an expired Graph delta link fetches the
history window again; stored messages are updated, not duplicated. Messages
whose every location is gone for a week are removed with their downloaded
attachments; archived documents stay. The daily database dump includes the
module's tables; attachment bytes are in MinIO with the rest of the files.

To turn the module off without touching anything: switch the extension off, or
set `MAIL_SYNC_ENABLED=false`, or stop `mail-sync`. Grafito keeps working.
