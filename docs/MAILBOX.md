# Email accounts (Correo electrónico)

Each person connects their own mail accounts (Zimbra or any IMAP server, Gmail,
Microsoft 365 / Outlook.com). Grafito copies them in the background and shows
them in **Correo electrónico**, an entry of the vault's sidebar beside the
Papelera; the accounts themselves are set up in **Cuenta → Cuentas de correo**. Messages and attachments can be
searched, read and archived into portfolios as ordinary documents, and people
write and answer mail with documents taken straight from their vault. Grafito
never moves or deletes mail on the server.

This is not the SMTP server Grafito uses to send its own notices; that one is in
[MAIL.md](MAIL.md).

## Architecture

```text
 Browser ── /mail ───► Grafito web (app)                      mail servers
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

| Provider                | Integration                                | Sign-in                  | Incremental sync                                                                                                   |
| ----------------------- | ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Zimbra, generic IMAP    | IMAP over TLS (993) or STARTTLS (143)      | Password or app password | UIDVALIDITY per folder; new UIDs above the last confirmed one; CONDSTORE/MODSEQ for flags; periodic reconciliation |
| Exchange on premises    | IMAP, when the server enables it           | As the server allows     | As IMAP                                                                                                            |
| Gmail                   | Gmail API (`gmail.readonly`, `gmail.send`) | OAuth 2.0 + PKCE         | History API from the stored history id; labels as folders                                                          |
| Microsoft 365 / Outlook | Microsoft Graph (`Mail.Read`, `Mail.Send`) | OAuth 2.0 + PKCE         | Delta query per folder (delta link), immutable ids                                                                 |

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

| Table                                         | Holds                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mail_account`                                | Owner, provider, address, server, sealed secret, sync settings, status, MCP permission, leases             |
| `mail_folder`                                 | Folders or labels of an account, role (special use), whether they sync, counters                           |
| `mail_sync_state`                             | Cursor per folder (UIDVALIDITY, last UID, MODSEQ, backfill cursor, delta link) or per account (history id) |
| `mail_message`                                | Normalized message: headers, text, HTML, snippet, remote and local flags, search vector                    |
| `mail_message_location`                       | Where a message is: folder, UID, UIDVALIDITY, flags; a Gmail message has one per label                     |
| `mail_attachment`                             | Attachment metadata; once downloaded, its storage key, checksum and antivirus result                       |
| `mail_archive_reference`                      | Which document an archived message or attachment became (the document is independent)                      |
| `mail_job`, `mail_worker`, `mail_oauth_state` | Queue, heartbeats, OAuth sign-ins in progress                                                              |

`mail_profile` and `mail_account.admin_paused` (migration 0048) are no longer
used since 0049 and stay only so no data is dropped.

Every table carries `user_id`, and every query filters by it. Two messages with
the same Message-ID are not merged. Attachment bytes live in MinIO
(`mail/<user>/<account>/<attachment>`), never in Postgres when MinIO is there.

## Using it

- **Where:** the sidebar's **Correo electrónico** entry shows to everyone with
  `mailbox.use` (Miembro by default) while the extension is on, also before
  any account is connected; it then opens an empty screen. Accounts are
  connected and managed in **Cuenta → Cuentas de correo** (the gear in the mail
  screen leads there). Each person sets up only their own; there is nothing
  about mail accounts in Administración.
- **Connect:** the address, the IMAP server and port (993 TLS or 143
  STARTTLS), the SMTP server for sending (empty: the IMAP host; 587 STARTTLS
  or 465 TLS), and the password. The password is tried once before anything is
  stored. Gmail and Microsoft use their own sign-in page, when the server has
  their OAuth applications.
- **Per account:** name, default account, automatic sync and its frequency
  (two minutes at least), folders that sync, the SMTP server, new credentials,
  **Volver a autorizar** (OAuth), **Permitir acceso por MCP**, **Desconectar**
  (credentials forgotten, messages kept) and **Borrar la copia local**
  (messages and downloaded attachments deleted here, archived documents kept).
  Nothing ever changes on the mail server.
- **History:** an account copies its whole mailbox by default (every folder:
  the server's own, Drafts, Sent…), newest first, so Grafito shows what the
  mail server shows; a shorter window can be chosen per account (Historial).
  Widening it makes every folder look back again. Accounts left at the old
  30-day default were moved to the whole history by migration 0052.
- **Reading:** unified inbox and per account, sent, drafts, archive, spam,
  mail trash, starred and the server's own folders. Search (subject, people,
  attachment names, text) and filters (unread, with attachments, sender,
  dates, account). The list pages with a keyset cursor and draws only the rows
  on screen. Read, starred and hidden are kept in Grafito only.
- **Attachments** are downloaded when opened: the worker fetches them,
  ClamAV scans them, and PDFs, images, audio, video and text open in Grafito's
  viewers. Office files open once saved into the vault (Collabora edits vault
  documents). Executables and disk images are only downloaded.
- **Tabs:** like Outlook, the reading pane has tabs: the message chosen in the
  list, messages opened with **Abrir en una nueva pestaña**, and messages being
  written. **Redactar**, Responder and Reenviar open a new tab there, not a
  window. A message being written lives only in its tab: closing a tab with
  changes asks «¿Desea guardarlo como borrador?». **Sí** keeps it in the
  account's Drafts on the server (IMAP append with `\Draft`, Gmail drafts,
  Graph messages), recipients, Bcc and attachments included, so Zimbra shows it
  too; **No** throws it away and deletes the files uploaded for it. Leaving the
  page with a message being written asks the browser to confirm.
- **Flags and the right click:** each message has a flag (**Fichar**, red when
  set, IMAP `\Flagged`) clicked straight on the list; **Fichados** lists them.
  A right click on a message offers Abrir, Abrir en una nueva pestaña,
  Responder, Responder a todos, Reenviar, read or unread, Fichar, Programar
  reunión, Archivar en Grafito and Ocultar aquí.
- **Options:** the gear of the mail screen opens a menu: **Preferencias** (the
  signature of each account, where kept attachments go) and **Cuentas de
  correo** (the Account section).
- **Writing:** **Redactar**, and **Responder**, **Responder a todos** and
  **Reenviar** on a message, open a plain-text message with From (one of the
  person's accounts), To, CC, CCO and Subject. **Adjuntar desde Grafito**
  browses the Carpeta Personal and each share, or searches, and ticks
  documents: files go as they are, notes as `.md`. Nothing is uploaded from the
  computer: the server reads each document, checks the person may open it and
  take it out (files need `files.download`, notes `notes.export`, the same as
  downloading), and refuses more than 20 attachments or 20 MB. Replies carry
  In-Reply-To and References; forwarding repeats the original header and text,
  not its attachments. IMAP accounts send through their SMTP server (the
  password is the account's) and the message is appended to the server's Sent
  folder; Gmail and Microsoft send through their APIs, which keep it in Sent.
  Each send is audited (`mail.send`: account, number of recipients and the ids
  of the documents sent, never the text). Gmail and Microsoft accounts
  connected before sending existed need **Volver a autorizar**.
- **Signature:** each account has one (Cuenta → Cuentas de correo → Firma),
  written below new messages after the usual `-- ` line and above the quoted
  text of replies and forwards; changing the From account swaps it.
- **Recipients by name:** To, CC, CCO and the guests of an event suggest
  people while typing: those seen in the person's mail (`mail_contact`, filled
  by the sync and by sending) and the directory of the account's server.
  Zimbra's global address list is searched through its SOAP interface
  (`AuthRequest`, `AutoCompleteGalRequest`) with the account's own password, at
  `https://<web server>/service/soap` (the web server is the IMAP host unless
  set in **Directorio y agenda**). The first try decides whether the server is
  a Zimbra; a server without that interface is not asked again.
- **Files from the computer:** like Outlook, dragging files over the message
  turns its body into two drop zones: **Guardar en Grafito y adjuntar** (kept
  as a document in the place chosen in **Guardar en**, remembered in the
  browser: the Carpeta Personal or one of its portfolios) and **Adjuntar
  archivos** (the file only goes with the message and is removed once sent or
  discarded). No dialog opens. A dropped folder gives the files inside it.
  **Desde el equipo** only attaches. Both take the vault's upload path (size
  limit, antivirus).
- **Meetings:** **Programar reunión** on a message (or its right click) opens
  the event form with its subject, its people as guests and its text. Guests
  are invited by the calendar server when it schedules (RFC 6638: it has a
  scheduling outbox, as Zimbra), or otherwise by an invitation mail from the
  account (iMIP, RFC 6047: text/calendar REQUEST; CANCEL when a guest is taken
  off or the event is deleted).
- **Answering invitations:** a message carrying an invitation (text/calendar)
  shows a card, as Zimbra does: what, when, where, who organizes, every guest's
  answer, and **Aceptar · Quizás · Rechazar**. Answering puts the event in the
  account's calendar with that answer (or updates it when the server already
  put it there) and tells the organizer: the scheduling server does, or a REPLY
  mail. Events where the account is a guest are answered from the Agenda too;
  a guest does not edit the organizer's event.
- **Agenda:** the calendars of the person's IMAP accounts through CalDAV
  (Zimbra, Nextcloud, Radicale, iCloud…), found at
  `https://<web server>/.well-known/caldav` or the **Dirección CalDAV** set in
  **Directorio y agenda**. Día, Semana (an hour grid, overlapping events side by
  side), Mes and Lista views. Each event shows this account's answer: accepted
  or organized solid, «quizás» striped, waiting for an answer outlined,
  declined struck through; small icons mark repeating events, meetings with
  guests and the answer. Month and week views, calendars shown or hidden,
  events with their repetitions expanded; new events and changes (title, dates,
  all day, place, guests, description) and deletions go straight to the server,
  with ETags so a change made elsewhere is not overwritten. Guests are written
  as ATTENDEE with the account as ORGANIZER; servers that handle scheduling
  (Zimbra does) send the invitations. Repeating events are shown but changed on
  the mail server. Nothing of the calendar is copied into Grafito
  (`mail_calendar` only remembers which calendars exist and which show).
- **Archiving:** a message as a Markdown note (provenance table, the text in a
  fence), plain text or the original `.eml` (exact source, fetched by the
  worker); attachments as files. Into the Carpeta Personal, one of its
  portfolios, a new one, or a share or workspace where the person can add
  files. The note links to the attachments saved with it, so the graph shows
  them together. Archived documents follow the normal upload path (rights,
  quota, antivirus, indexing) and stay when the message is deleted on the
  server or the account is disconnected.

## Server setup

The module is the **Correo electrónico** extension (Administración →
Extensiones), off until an administrator turns it on, which needs mail-sync
running. Everything else is in the server's environment (`.env`), passed to
both `app` and `mail-sync`:

| Variable                                                   | Meaning                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MAIL_TRUSTED_HOSTS`                                       | Mail servers on a private network people may use (IMAP, SMTP, directory, CalDAV; names or `*.suffix`, comma-separated) |
| `MAIL_GMAIL_CLIENT_ID`, `MAIL_GMAIL_CLIENT_SECRET`         | Google's OAuth application; without it, no **Conectar Gmail**                                                          |
| `MAIL_MICROSOFT_CLIENT_ID`, `MAIL_MICROSOFT_CLIENT_SECRET` | Microsoft's OAuth application; without it, no **Conectar Microsoft 365 / Outlook**                                     |
| `MAIL_MICROSOFT_TENANT`                                    | `common` (any account) or one organization's tenant id                                                                 |

The limits (five accounts per person, sync every two minutes at most, a year
of history, 25 MB per attachment, 2 GB of attachments per person, four jobs per
worker…) are defaults; an operator can override them with a JSON object in the
`app_setting` row `mail_policy` (`src/domain/mail/policy.ts` lists the keys and
clamps them).

### Zimbra

People connect with their address, the Zimbra mail host (for example
`mail.universidad.edu`, port 993) and their password. If the server is
reachable only inside the network, add it to `MAIL_TRUSTED_HOSTS`. If its certificate comes from the institution's own
authority, mount the CA and set `NODE_EXTRA_CA_CERTS` on **both** `app` and
`mail-sync`.

### Generic IMAP

Any server with IMAP over TLS (993) or STARTTLS (143). Providers that require
app passwords (Yahoo, iCloud, Gmail by IMAP) work with one. Cleartext IMAP is
not supported.

### Gmail

1. In Google Cloud: a project, the Gmail API enabled, an OAuth client of type
   "Web application" with the redirect address
   `<BETTER_AUTH_URL>/api/mail/oauth/callback`, the scope
   `https://www.googleapis.com/auth/gmail.readonly`, and the consent screen.
2. Set `MAIL_GMAIL_CLIENT_ID` and `MAIL_GMAIL_CLIENT_SECRET` and recreate
   `app` and `mail-sync`.

### Microsoft 365 / Outlook.com

1. In Entra ID (Azure): an app registration, platform "Web", the same redirect
   address, delegated permissions `Mail.Read`, `User.Read`, `offline_access`.
   For Outlook.com and other tenants, supported account types "any directory
   and personal accounts", tenant `common`; for one organization, its tenant id.
2. Set `MAIL_MICROSOFT_CLIENT_ID`, `MAIL_MICROSOFT_CLIENT_SECRET` and
   `MAIL_MICROSOFT_TENANT`, and recreate `app` and `mail-sync`.

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

**Outbound access** the worker (and the app, to test a connection and to send)
needs: the IMAP servers on 993/143 and their SMTP servers on 587/465; `gmail.googleapis.com` and `oauth2.googleapis.com`
for Gmail; `graph.microsoft.com` and `login.microsoftonline.com` for Microsoft.

## Security

- **Credentials** are sealed with `GRAFITO_ENCRYPTION_KEY` (AES-256-GCM, the
  same as Git tokens), never returned to the browser, never logged. Rotating
  the key works as for the other secrets (OPERATIONS.md). OAuth client secrets
  stay on the server.
- **OAuth:** authorization code with PKCE (S256), a random single-use `state`
  bound to the person and valid ten minutes, read-only scopes. The provider
  sends the person back to **Cuenta → Cuentas de correo**, where their own
  session finishes the
  sign-in: a link prepared by someone else cannot attach a mailbox to another
  Grafito account. `invalid_grant` marks the account expired, not retried.
- **Isolation:** every query filters by the signed-in person. An attachment
  link is signed for its owner and expires in ten minutes. Administrators
  have no view of anyone's accounts or messages.
- **SSRF:** the IMAP host, the SMTP host for sending and the web server
  (directory, CalDAV, HTTPS on 443 or 8443 only) are resolved once; loopback, link-local, cloud
  metadata, multicast and Grafito's own services are refused; a private
  address only when `MAIL_TRUSTED_HOSTS` names the host; ports 993, 143, 587,
  465 (SMTP) and
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
- **MCP tools:** `list_mail_accounts`, `search_mail`, `read_mail`,
  `mark_mail` (read, flagged), `archive_mail`, `save_mail_attachment`,
  `wait_for_mail` (new mail since a cursor, waiting up to 60 s: how an
  assistant notices arrivals), `find_recipients`, `save_mail_draft` (kept in
  Drafts, never sent), `list_calendar_events` and `create_calendar_event`
  (without guests, as inviting sends mail).
- **MCP:** only accounts whose owner turned on «Permitir acceso por MCP», only
  for that owner. Mail text comes back under `untrusted_content`, and the
  server instructions tell clients never to follow instructions found there.
  No MCP tool sends, moves or deletes mail: sending is a person's act in the
  mail screen, so a message's text cannot make an assistant send the vault out.
- **Directory and calendar** requests use the account's password over HTTPS
  with the certificate validated; redirects are checked again, stay on https
  and drop the credentials when they leave the host; answers are capped at
  8 MB. Event text is shown as plain text.
- **Sending** takes only documents the person may download or export, read on
  the server (a document id from someone else's vault, or from a share that was
  withdrawn, is refused), with mail-composer's file and URL access off. Bcc is
  kept out of the copy in Sent.

Residual risks: the worker runs as the same user as the app (it reads the
installation secrets); an MCP client that ignores the untrusted-content marking
could still act on what a message says (its own permissions bound the damage,
and deletions need `confirm`); a private server in `MAIL_TRUSTED_HOSTS`
is reachable for every person.

## Troubleshooting

| What you see                                | Why / what to do                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The extension does not turn on              | `mail-sync` is not running or not reaching Postgres: `docker compose ps mail-sync`, its logs           |
| «El certificado del servidor no es válido…» | The server's certificate does not match its name or comes from a private CA: `NODE_EXTRA_CA_CERTS`     |
| «Ese servidor está en una red privada…»     | Add the host to `MAIL_TRUSTED_HOSTS` (app and mail-sync)                                               |
| «Error de autenticación»                    | Wrong password, or the provider needs an app password; update the credentials                          |
| «Autorización caducada»                     | The refresh token was revoked or expired: **Volver a autorizar**                                       |
| «Reintento programado a las …»              | The server did not answer or asked to wait; retried with backoff (with jitter, respecting Retry-After) |
| An attachment stays «Descargando…»          | Look at the worker's logs; MinIO or ClamAV may be down; it is retried a few times                      |
| Many failed jobs                            | Wrong credentials are not retried until the owner fixes them in their Account                          |

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
