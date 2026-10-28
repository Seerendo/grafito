# Grafito

Grafito is a self-hosted Markdown notes vault. Notes link to each other with
`[[wiki links]]` and `#tags`, live in nested portfolios next to uploaded files,
and can be explored as a graph. It has multi-user accounts with roles,
organizations, sharing (private, with people, or by public link), external
sign-in (LDAP, OAuth, OpenID Connect), an AI assistant that works on your notes,
and a REST API.

The interface is available in Spanish and English (**Cuenta → Preferencias de
usuario**, "Account → User preferences"). This guide quotes the Spanish labels,
with the English ones in quotes (for example **Compartir…**, "Share…").

- [Installation](#installation)
- [First run](#first-run)
- [Using the vault](#using-the-vault)
- [Sharing](#sharing)
- [History and trash](#history-and-trash)
- [Office documents](#office-documents)
- [Account](#account)
- [Administration](#administration)
- [AI assistant](#ai-assistant)
- [REST API](#rest-api)
- [Configuration](#configuration)
- [Development](#development)
- [Further reading](#further-reading)

## Installation

### Requirements

- **Software:** Docker with Docker Compose v2 (Docker Desktop on Windows and
  macOS, or Docker Engine on Linux). Git, to download the code.
- **Memory:** about 1.7 GB when idle; plan for 4 GB or more. Each document
  open in the Office editor adds some.
- **Disk:** about 5 GB for the images, plus your data and backups.
- **Ports:** `8080` (Grafito and the Office editor) and, on the machine itself, `9980` must be free.
- **Internet:** needed only for the first download. After that, everything
  runs locally (see [Offline installation](#offline-installation)).

### Default installation

```bash
git clone https://github.com/Seerendo/grafito.git
cd grafito
docker compose up -d --build
```

Open <http://127.0.0.1:8080> and follow [First run](#first-run). The first
start takes a few minutes while the images download and the app builds.

This starts:

| Service | What it does | Reachable at |
| --- | --- | --- |
| `gateway` | One port for Grafito and the Office editor (nginx) | `http://127.0.0.1:8080` |
| `app` | Grafito (production build) | through `gateway` |
| `postgres` | Accounts, vaults, sharing, versions | this machine only |
| `elasticsearch` | Full-text search | this machine only |
| `redis` | Session deadlines | this machine only |
| `minio` | Uploaded files | this machine only |
| `collabora` | Office editor (Collabora Online) | through `gateway` |
| `backup`, `backup-files` | Daily copies of the database and the files in `./backups` | — |

Migrations run automatically when the app starts. This setup works as is on
your own computer.

### Configuration with `.env`

Docker Compose reads a file named `.env` next to `docker-compose.yml`, if one
exists. Without it, the defaults written in `docker-compose.yml` are used.
They are fine for trying Grafito on your own computer, but they are public (they
are in this repository).

`.env` is listed in `.gitignore`, so your secrets never reach Git. To create it
from the template:

```bash
cp .env.example .env
```

Uncomment and fill in what you need, then apply it with
`docker compose up -d`. Generate secrets with `openssl rand -base64 32`.

| Variable | Set it when | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Optional | Signs sessions, file links and Office editor tokens. Empty: Grafito creates one for this installation (in the `grafito_secrets` volume). Changing it later only signs everyone out. |
| `GRAFITO_ENCRYPTION_KEY` | Optional | Encrypts AI keys and the SMTP password (32+ characters). Empty: Grafito creates one, like the secret above. Losing or changing it makes saved AI keys unreadable, unless you rotate it (see [docs/OPERATIONS.md](docs/OPERATIONS.md)). |
| `POSTGRES_PASSWORD`, `S3_SECRET_KEY` | **Before the first start** | Only applied when the volumes are created. Changing them later needs the steps in [docs/OPERATIONS.md](docs/OPERATIONS.md). |
| `COLLABORA_ADMIN_PASSWORD` | Always, outside your own computer | Password of Collabora's own admin console (user `admin`), reachable only on the server at port 9980. |
| `BETTER_AUTH_URL`, `GRAFITO_PUBLIC_ORIGIN`, `COLLABORA_URL` | When other machines use Grafito | See [On a server or a network](#on-a-server-or-a-network). |
| `GRAFITO_MAX_UPLOAD_MB` | To change the upload limit | 100 MB by default. |
| `BACKUP_INTERVAL_SECONDS`, `BACKUP_KEEP_DAYS` | To change the backup schedule | Daily, keeping 14 days. |

### Installation options

#### On a server or a network

Everything is served on one port, `8080`: the `gateway` service passes the
Office editor's paths to Collabora and the rest to Grafito. So the same setup
works in both ways people usually run it:

- **Directly by IP:** open `http://192.168.1.20:8080` (the server's IP) from
  any machine. Open port `8080` in the server's firewall.
- **Behind a reverse proxy with HTTPS** (nginx, Caddy, Traefik, Apache…):
  point it at port `8080`, for example `https://notes.example.com` →
  `http://127.0.0.1:8080`. The proxy must pass WebSocket upgrades, which the
  editor uses. Caddy and Traefik do it by default. For nginx:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
    client_max_body_size 0;
  }
  ```

Both can be used at once. Grafito accepts sign-ins from the address each
request was sent to, and the editor follows the page's address, `ws://` on
http and `wss://` on https. Neither needs extra variables.

Set your own secrets in `.env`, and `BETTER_AUTH_URL` to the main address
(links in emails and external sign-in use it):

```dotenv
BETTER_AUTH_URL=https://notes.example.com
BETTER_AUTH_SECRET=...
GRAFITO_ENCRYPTION_KEY=...
POSTGRES_PASSWORD=...
S3_SECRET_KEY=...
COLLABORA_ADMIN_PASSWORD=...
```

- **Plain http on a network:** works. The session then travels as a token
  instead of a cookie, since browsers only keep secure cookies on `https://`
  and `localhost`.
- **Upgrading from a version with Collabora on port 9980:** remove
  `COLLABORA_URL`, `GRAFITO_PUBLIC_ORIGIN` and `COLLABORA_SSL_TERMINATION`
  from `.env`, and the proxy rule for the editor's own domain. Port `9980` now
  only listens on the server itself.

#### Without the Office editor

```bash
# in .env
COLLABORA_URL=
```

```bash
docker compose up -d --scale collabora=0
```

Office files can still be uploaded and downloaded. See
[docs/OFFICE.md](docs/OFFICE.md).

#### Without automatic backups

```bash
docker compose up -d --scale backup=0 --scale backup-files=0
```

Use this only if you back up the Docker volumes another way. See
[docs/OPERATIONS.md](docs/OPERATIONS.md).

#### Offline installation

Grafito needs no internet connection while it runs. To install it on a machine
without internet:

1. On a machine with internet, run `docker compose pull` and
   `docker compose build`.
2. Save the images with `docker save` and copy them along with this folder.
3. On the target machine, load them with `docker load` and run
   `docker compose up -d`.

The AI assistant is the only feature that needs internet, and only with cloud
providers. Self-hosted Ollama or LM Studio also work offline.

#### Test services

`docker-compose.yml` only has what Grafito needs to run. The services used
to test connections and integrations (Keycloak and OpenLDAP for external
sign-in, Mailpit for email) live in a separate test compose that isn't part
of the repository.

Ollama and LM Studio aren't part of the compose. Run them yourself, installed
on the machine or in a compose of your own, and expose their port. See
[AI assistant](#ai-assistant).

#### Without Docker (development)

See [Development](#development).

### Updating

```bash
git pull
docker compose up -d --build
```

Migrations run by themselves. Take a backup first (see
[docs/OPERATIONS.md](docs/OPERATIONS.md)).

### Stopping and uninstalling

```bash
docker compose ps
docker compose logs -f app
docker compose down
```

`docker compose down` stops everything and keeps your data. `docker compose down -v`
also **deletes the volumes**, erasing all accounts, notes and files. The
`./backups` folder is kept.

## First run

1. The first visit shows **Primera vez** (first time). Choose the administrator
   username and password.
2. If the password is shorter than 8 characters, you must change it before you
   can see any notes.
3. A new vault starts with sample notes under the **Documentación** portfolio.
   They show the main features, and you can delete them.

After that, the start screen is a normal sign-in.

## Using the vault

### Layout

- **Left: the directory.** It has two roots:
  - **Carpeta Personal** (personal folder, formerly «Raíz») holds your own
    (private) notes, portfolios and files. Its page lists your portfolios and
    your recent documents.
  - Clicking a portfolio opens its page in the center: its path, its
    sub-portfolios, and its notes and files.
  - **Compartidos conmigo** holds what others shared with you.
  - **Papelera** (trash) holds what you deleted.
  - Collapse the directory with the « arrow to get a wider editor. It opens
    expanded again when you come back to the vault.
- **Center: the open note.** On the Carpeta Personal page, right-click a recent document
  (or the empty space) for the same menu as in the directory.
- **Right: the details panel.** It shows the outline, manual links, links
  written in the text, mentions (backlinks) and comments. Collapse it with the
  » arrow.
- **Full screen:** the ⤢ button of a note or file hides the top bar and both
  panels, and asks the browser for full screen. Esc closes an open dialog
  first, then leaves full screen (in Chrome and Edge; elsewhere the browser
  leaves full screen on the first Esc).
- **On phones,** a bottom bar switches between Notes, Note, Graph and Links.

### Notes

- **New notes** start blank. A new note that you leave without writing
  anything (and without renaming it) is discarded: it's never saved.
- **Markdown:** notes support Markdown, Mermaid diagrams (including C4) and
  task checkboxes (`- [ ]`).
- **Links:** type `[[` to link to another note. If the target doesn't exist
  yet, clicking the link creates it.
- **Tags:** `#tags` become filters. Click a tag to filter the directory.
- **View modes:** each note has three: **Editar** (edit), **Dividir** (side by
  side) and **Leer** (read).
- **Menu:** the "more actions" menu pins a note, shows its history,
  downloads it as Markdown or PDF, shares it or deletes it.

### Portfolios and files

- Portfolios are folders and can be nested. Right-click the directory to create,
  rename, move or delete them, or drag notes and portfolios onto them.
- Drop files from your computer onto a portfolio:
  - A `.md` file becomes a note.
  - Anything else is uploaded to the server in parts, with progress at the
    bottom of the directory. The limit is 100 MB per file by default
    (`GRAFITO_MAX_UPLOAD_MB`).
  - Images, PDFs, video and audio are previewed. Everything else can be
    downloaded.
- **Drawings:** **Nuevo dibujo** (on a portfolio's page or in the right-click
  menu) creates an Excalidraw drawing.
  - It is a `.excalidraw` file, so it can be linked, shared and restored from
    its history like any file.
  - It saves itself as you draw: shortly after each change, and at least
    every two seconds while you keep drawing. What's pending is also saved
    when you close it, switch tabs or reload the page.
  - In a shape's link (Ctrl+K), a note's title (or `[[Title]]`) opens that
    note in Grafito.
  - Excalidraw and its fonts are served by Grafito, so drawings work offline.
- **Linking a phrase in a PDF:** select a word or phrase in a PDF (a document
  number, for example) and click **Vincular selección**. Then pick the note or
  file it points to.
  - The phrase stays highlighted. Clicking it opens its target.
  - The target lists it under **Menciones** with its page («Contrato.pdf ·
    pág. 2 · «EXP-7781»»). Clicking that opens the PDF at the phrase.
  - A PDF can have several linked phrases, even to the same target, besides
    links from the whole file.
  - Scanned PDFs have no text to select.
- **Notes on a PDF:** select a phrase and click **Nota** to leave a note on
  it. The PDF file is not changed.
  - The phrase is highlighted in yellow. Clicking it shows its notes.
  - The notes are comments with a quote of the phrase: they appear under
    **Comentarios**, and clicking the quote opens the PDF at the phrase.
  - Anyone who can comment can add them, including on PDFs shared read-only.
  - Notes that the PDF already had (added in another PDF reader) are kept in
    the file and shown too: a yellow marker on the page and a list under
    **Comentarios** («Notas que trae el PDF»). They are read-only in Grafito.
- **Downloading a portfolio:** **Descargar (.zip)** in a portfolio's
  right-click menu, or the download button on its page, downloads the
  portfolio with its subportfolios as a `.zip`. Each portfolio is a folder,
  each note a `.md` file and each file goes as is. **Descargar todo (.zip)**
  in the root menu downloads the whole vault. Notes are included with the
  **Exportar** permission and files with **Descargar**.
- **Git (optional):** a portfolio, or the whole vault, can be kept in sync
  with a folder of a GitHub or GitLab repository, both ways. See
  [docs/GIT.md](docs/GIT.md).
- On a phone, or without drag and drop, use **Subir archivo** in the
  right-click (long-press) menu. It accepts several files and treats `.md` the
  same way.

### Graph

The graph button in the header, or **Ctrl+G**, shows notes and files as nodes
and links as edges. Click a node to open it.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+K | Search notes and tags |
| Ctrl+N | New note |
| Ctrl+E | Switch view mode (read → edit → split) |
| Ctrl+G | Toggle the graph |
| Ctrl+B | Open the AI chat (inside the editor, Ctrl+B is bold) |
| Esc | Close whatever is open |

Your vault is stored on the server and cached in the browser, so it opens
instantly and syncs every few seconds. Edits made by the AI or through the API
show up without reloading.

## Sharing

Everything is **private** by default. To change that, use **Compartir…**
("Share…") from a note's "more actions" menu or by right-clicking a note or
portfolio. Your role needs the share permission.

| Option | Who can see it |
| --- | --- |
| **Privada** | Only you |
| **Compartida** | The users and organizations you pick, either **Solo lectura** (read-only) or **Puede editar** (can edit). Sharing with an organization includes its sub-organizations. |
| **Pública** | Anyone with the link (`/p/<token>`), without signing in |

Public links are always read-only.

- **Portfolios:** sharing a portfolio includes everything inside it.
- **Markers:** the directory marks shared (👥) and public (🌐) items.
- **What recipients see:** shared items appear under **Compartidos conmigo** in
  the recipient's directory. Shared portfolios expand in place, and documents
  open in the main area. Items they can edit carry a pencil.
- **Editing a shared note:** **Editar**, then **Guardar** (or Ctrl+S).
- **Editing at the same time:** the owner, in their vault, and the people it's
  shared with can edit the same note at once.
  - While someone else edits it, the note shows «Ana está editando esta nota».
  - If the other person saved changes to other lines in the meantime, Grafito
    merges them with yours («Guardado junto con los cambios de otra persona»).
  - If you both changed the same lines (one deletes a paragraph the other is
    editing, for example), nothing is overwritten. Grafito warns you and you
    choose: keep their version (**Usar la suya**) or save yours on top
    (**Guardar la mía**). Both versions stay in the history.
  - Office documents are edited by everyone at once, live, in Collabora.
- **Comments:** anyone a note or file is shared with, even read-only, can
  comment on it without editing it. The owner sees the comments under
  **Comentarios** in the details panel. Others see them beside the shared
  document. Each person can delete their own comments; the owner can delete
  any of them. Comments are deleted with the document when the trash is
  emptied.
- **Revoking:** setting an item back to private, or deleting it, revokes access
  immediately.

## History and trash

- **History:** every note keeps its versions: who changed it, when, and what
  changed (a line-by-line diff). Open it from the "more actions" menu, or with
  the clock icon on a shared note you can edit. **Restaurar esta versión**
  restores any version. A restore is itself a new version, so you can undo it.
  Consecutive edits by the same person within 10 minutes are grouped into one
  version.
- **Trash:** deleting a note, file or portfolio moves it to **Papelera**.
  - From there you can **Recuperar** it. A note returns to its portfolio, which
    is recovered too if it was deleted.
  - Or you can delete it for good.
  - Items are removed automatically after 30 days.

## Office documents

Word, Excel, PowerPoint and OpenDocument files open straight into an editor
inside Grafito as soon as you select them. If you close the editor, **Abrir en
el editor** ("Open in the editor") opens it again. The editor is
Collabora Online, which `docker compose up -d` starts by default. To turn it
off, set `COLLABORA_URL=` in `.env` and run
`docker compose up -d --scale collabora=0`.

- **Versions:** every save is a version in the file's history, and the
  original is always kept.
- **Track changes:** Collabora's own track changes (Review → Track Changes) are
  stored in the document.
- **Offline:** it runs entirely on your machine or network, with no internet
  needed.

Setup, offline use and licensing notes for commercial use are in
[docs/OFFICE.md](docs/OFFICE.md).

## Account

Open the avatar menu → **Cuenta**. Settings are split into sections:

- **Datos de la cuenta:** display name.
- **Correo:** your email address, and whether to get an email when something
  you share, or that was shared with you, changes. Accounts that sign in with
  LDAP, OAuth or SSO get the provider's address on every sign-in and can't
  change it here.
- **Preferencias de usuario:** the interface language (Español / English). It
  is saved to the account, so it follows you to other browsers.
- **Contraseña:** change your password. Accounts that sign in with LDAP, OAuth
  or SSO change it at their provider.
- **Conexiones de IA:** connect the AI providers the administrator allowed (see
  [AI assistant](#ai-assistant)).
- **API:** create and revoke personal API tokens.

The last two sections only appear if your role allows them.

## Administration

Open the avatar menu → **Administración**. It is only visible to roles with
admin permissions. The section sidebar collapses to an icon rail.

| Section | What it does |
| --- | --- |
| **Usuarios y permisos** | Users (with their first sign-in, last activity and access state), roles with per-permission toggles, organizations and sub-organizations. A new user is created with an email instead of a password: they get a one-time temporary password by email, and **Reenviar acceso** sends a new one. |
| **Autenticación** | LDAP / Active Directory, OAuth (Google, GitHub, Microsoft) and SSO through OpenID Connect (Keycloak, Authentik, Okta…). Each provider sets the default role for new accounts and the allowed email domains. |
| **Inteligencia artificial** | Which AI providers users may connect |
| **Correo electrónico** | The SMTP server for new users' access emails and change notifications, with a test button. See [docs/MAIL.md](docs/MAIL.md). |
| **Plugins** | Turn the graph, Mermaid, links and Git sync on or off (Git is off by default) |
| **Apariencia** | **Diseño** (design), for the whole installation: **Cristal** (glass, the default: floating panels, glass and rounded controls; it was called «Moderno») or **Clásico** (classic, the original flat layout). **Temas**: ten color themes, which apply to both designs. |
| **Sesión** | Session length. Changing it signs everyone out. |
| **Monitorización y logs** | System monitor, audit log, storage usage and backend health checks |

Role changes take effect within a few seconds, without signing in again. The
initial administrator always keeps every permission.

## AI assistant

1. In **Administración → Inteligencia artificial**, an administrator allows
   providers: ChatGPT, Claude, Grok, Gemini, DeepSeek, Kimi, Ollama and LM
   Studio.
2. Each user connects their own provider in **Cuenta → Conexiones de IA**:
   - Cloud providers use the user's own API key. Keys are tested before saving,
     stored encrypted (AES-256-GCM) and never sent back to the browser.
   - Ollama and LM Studio use the address of the user's own instance:
     - On the same machine as Docker, use `localhost`, for example
       `http://localhost:11434` (Ollama) or `http://localhost:1234/v1`
       (LM Studio). Grafito calls it on the host machine through
       `host.docker.internal`, so the model doesn't need to be in Docker or on
       Grafito's network.
     - On another machine, use its IP or name, for example
       `http://192.168.1.20:11434`.
     - For safety, Grafito's own services (`postgres`, `app`…) are rejected.
3. Open the chat with the floating button or **Ctrl+B**.
   - Pick the model with the small selector under the message box, then ask.
   - **New conversation** (pen icon) starts a fresh chat at any time.
   - **History** (clock icon) lists your past conversations. Open one to
     continue it, or delete it. Each conversation keeps its own context.
     Conversations are saved on the server, so they're there in any browser.
   - **Profiles** (the person icon beside the model) change how the assistant
     works, for example «Documentación» or «Análisis». Each person creates
     their own in **Gestionar perfiles**, inside the chat:
     - a name;
     - instructions the assistant follows (tone, format, focus);
     - **Solo lectura**, so that profile can read the vault but not create or
       edit notes.

     **General** is the assistant without a profile. The chosen profile is
     remembered in that browser.
   - Clicking outside the chat minimizes it to its button. What you were
     typing is still there when you open it again.

The assistant can list portfolios, search, read, create and edit notes, within
the permissions of your role. It finds notes and portfolios by name as well as
by id, and it reads the text of uploaded files: plain text, Word, Excel,
PowerPoint, OpenDocument and PDFs with text (not scanned ones). The chat lists each tool it used, and you can
click one to open the note.

To try it with a local open model, install Ollama (or LM Studio and start its
server), download a model, allow the provider in administration, and connect
`http://localhost:11434` (or `http://localhost:1234/v1`) in your account.

- **LM Studio:** it may listen only on `127.0.0.1`. Docker Desktop reaches
  that. On Linux, enable "Serve on Local Network" so the container can reach it.
- **Ollama on Linux:** start it with `OLLAMA_HOST=0.0.0.0`.

## REST API

Create a token in **Cuenta → API**. It is shown only once. Then send it as a
bearer token:

```bash
curl -H "Authorization: Bearer gft_..." http://127.0.0.1:8080/api/v1/notes
```

| Method and path | What it does |
| --- | --- |
| `GET /api/v1/me` | Current user, role and permissions |
| `GET /api/v1/portfolios` | List portfolios |
| `POST /api/v1/portfolios` `{ name, parentId? }` | Create a portfolio |
| `GET /api/v1/notes?portfolio=<id\|root>&q=<text>&limit=<n>` | List notes and files |
| `POST /api/v1/notes` `{ title, content?, portfolioId? }` | Create a note |
| `GET /api/v1/notes/:id` | Read a note |
| `PATCH /api/v1/notes/:id` `{ title?, content?, portfolioId? }` | Update a note. Renaming also updates `[[links]]`. |
| `DELETE /api/v1/notes/:id` | Delete a note or file |
| `GET /api/v1/notes/:id/file` | Download a file |
| `GET /api/portfolios/:id/download` | Download a portfolio (`all`: the whole vault) as `.zip` |

To upload a file through the API, use the same three steps as the app:

1. `POST /api/files/uploads` with `{ name, mime, size }` returns
   `{ key, uploadId, partSize }`.
2. Send each part with `PUT /api/files/uploads/part?key=…&uploadId=…&part=1…`
   (raw bytes, up to `partSize`). Each call returns an `etag`.
3. `POST /api/files/uploads/complete` with `{ key, uploadId, parts }`.

The returned `key` can then be referenced by a file document.

Tokens carry your role's permissions. Errors are JSON `{ "error": "..." }` with
status 400, 401, 403, 404 or 409.

## Configuration

This is the full list of variables the Grafito server reads, for running it
outside the provided Docker Compose setup. With Docker Compose, set them in
`.env` as described in [Configuration with `.env`](#configuration-with-env).
`.env.example` documents them all.

| Variable | Purpose | If missing |
| --- | --- | --- |
| `DATABASE_URL` | Postgres for accounts, vaults and sharing | Embedded PGLite (development only) |
| `ELASTICSEARCH_URL` | Full-text search | Search index in Postgres |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | MinIO or S3 for uploaded files | Files stored in Postgres (20 MB limit by default) |
| `GRAFITO_MAX_UPLOAD_MB` | Per-file upload limit | 100 with S3, 20 without |
| `REDIS_URL` | Session deadlines | Stored in Postgres |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Session, file link and editor token signing; public URL | A secret created for the installation in `GRAFITO_SECRETS_DIR`; the URL is required in production |
| `GRAFITO_ENCRYPTION_KEY` | Encrypts users' AI keys and the SMTP password (32+ characters) | A key created for the installation in `GRAFITO_SECRETS_DIR` |
| `GRAFITO_SECRETS_DIR` | Where those generated secrets are kept | `.data/secrets` (`/app/.data/secrets`, the `grafito_secrets` volume, in Docker) |
| `GRAFITO_ENCRYPTION_KEY_PREVIOUS` | Previous key during a rotation | — |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Other sites allowed to send sign-ins, comma-separated | The address each request was sent to, `BETTER_AUTH_URL` and localhost |
| `COLLABORA_URL`, `COLLABORA_INTERNAL_URL`, `GRAFITO_WOPI_URL` | Office editor (see [docs/OFFICE.md](docs/OFFICE.md)) | Editor off |
| `GRAFITO_GIT_HOSTS`, `GRAFITO_GIT_SYNC_MINUTES` | Git servers allowed besides github.com and gitlab.com; minutes between syncs (see [docs/GIT.md](docs/GIT.md)) | Only github.com and gitlab.com; 2 |
| `NODE_EXTRA_CA_CERTS` | CA file for a Git server with a certificate from your own authority | Public authorities only |
| `GRAFITO_PUBLIC_ORIGIN`, `COLLABORA_SSL_TERMINATION` | Only for a `COLLABORA_URL` on an address of its own (see [docs/OFFICE.md](docs/OFFICE.md#servers-and-https)) | `localhost:*`; `false` |

### Testing external sign-in locally

Point **Administración → Autenticación** at any LDAP directory or OpenID
Connect provider you can reach. `dev/auth-test/` has a sample Keycloak realm
and LDAP users to load into your own test servers.

## Development

The app is built with TanStack Start (React 19, SSR, server functions),
Tailwind CSS v4, Better Auth and zustand. It targets Node 22.

```bash
npm install
npm run typecheck
npm run lint
npm test
```

`npm run dev` is blocked by a guard, because the app expects its Docker
services. To run it without them, on embedded PGLite, set
`GRAFITO_INTERNAL_DEV=1`. For the full stack, use Docker Compose.

If you add a dependency with an npm version other than the image's (npm 10),
regenerate the lockfile with the container's npm so that `npm ci` keeps working:

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-bookworm-slim npm install --package-lock-only
```

## Further reading

- [docs/SECURITY.md](docs/SECURITY.md): the security model and the last
  security test (XSS, SQL injection, access control, CSRF, uploads, secrets).
- [docs/OPERATIONS.md](docs/OPERATIONS.md): backups, restore, secret rotation
  and what to do when something is down.
- [docs/OFFICE.md](docs/OFFICE.md): the Office editor (Collabora), offline use
  and licensing.
- [docs/MAIL.md](docs/MAIL.md): email (SMTP), new users' one-time access and
  change notifications.
- [docs/GIT.md](docs/GIT.md): syncing portfolios with GitHub or GitLab,
  including a self-hosted (institutional) GitLab.
- [ARCHITECTURE.md](ARCHITECTURE.md): folder layout, layers, data model,
  sharing, sync, authentication and AI internals.
- [TEST.md](TEST.md): the end-to-end test log for each round of changes.
- [ROADMAP.md](ROADMAP.md): what is planned next.

## License

Grafito is licensed under the [GNU Affero General Public License v3.0](LICENSE).
If you run a modified version as a network service, you must offer its source
code to the users of that service.
