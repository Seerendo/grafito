# Grafito

Grafito is a self-hosted Markdown notes vault. Notes link to each other with
`[[wiki links]]` and `#tags`, live in nested portfolios next to uploaded files,
and can be explored as a graph. It has multi-user accounts with roles,
organizations, sharing (private, with people, or by public link), external
sign-in (LDAP, OAuth, OpenID Connect), an AI assistant that works on your notes,
and a REST API.

The interface is in Spanish; this guide quotes on-screen labels as they appear
(for example **Compartir…**, "Share…").

- [Quick start](#quick-start)
- [First run](#first-run)
- [Using the vault](#using-the-vault)
- [Sharing](#sharing)
- [History and trash](#history-and-trash)
- [Account](#account)
- [Administration](#administration)
- [AI assistant](#ai-assistant)
- [REST API](#rest-api)
- [Configuration](#configuration)
- [Development](#development)
- [Further reading](#further-reading)

## Quick start

Requirements: Docker with Docker Compose.

```bash
git clone https://github.com/Seerendo/grafito.git
cd grafito
docker compose up -d --build
```

Open <http://127.0.0.1:8080>. Compose starts:

- The app, as a production build.
- Postgres 16, Elasticsearch 8, Redis 7 and MinIO. They are only reachable
  from the machine itself (`127.0.0.1`).
- A `backup` service that writes a daily database dump to `./backups`.

Migrations run automatically when the app starts.

> Before exposing Grafito to anyone, create a `.env` file next to
> `docker-compose.yml` with your own secrets (`BETTER_AUTH_SECRET`,
> `GRAFITO_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`, `S3_SECRET_KEY`) and the
> public address (`BETTER_AUTH_URL`). See
> [docs/OPERATIONS.md](docs/OPERATIONS.md). Keep the encryption key safe:
> without it, saved AI keys can't be read.

Useful commands:

```bash
docker compose ps
docker compose logs -f app
docker compose down
```

`docker compose down` keeps your data. Add `-v` only if you want to delete the
volumes, which erases all accounts and notes.

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
  - **Raíz** holds your own (private) notes, portfolios and files. Its page
    lists your recent documents.
  - **Compartidos conmigo** holds what others shared with you.
  - **Papelera** (trash) holds what you deleted.
  - Collapse the directory with the « arrow to get a wider editor.
- **Center: the open note.**
- **Right: the details panel.** It shows the outline, manual links, links
  written in the text, and mentions (backlinks).
- **On phones,** a bottom bar switches between Notes, Note, Graph and Links.

### Notes

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
  - Anything else is stored as a file (up to about 700 KB) and previewed when
    possible.
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
- **Editing a shared note:** **Editar**, then **Guardar** (or Ctrl+S). If the
  owner or someone else changed the note in the meantime, Grafito warns you
  instead of overwriting. You can keep their version (**Usar la suya**) or save
  yours on top (**Guardar la mía**). Both versions stay in the history.
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

## Account

Open the avatar menu → **Cuenta**. Settings are split into sections:

- **Datos de la cuenta:** display name and contact email.
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
| **Usuarios y permisos** | Users, roles with per-permission toggles, organizations and sub-organizations |
| **Autenticación** | LDAP / Active Directory, OAuth (Google, GitHub, Microsoft) and SSO through OpenID Connect (Keycloak, Authentik, Okta…). Each provider sets the default role for new accounts and the allowed email domains. |
| **Inteligencia artificial** | Which AI providers users may connect |
| **Plugins** | Turn the graph, Mermaid and links on or off |
| **Apariencia** | Ten color themes |
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
   - Ollama and LM Studio use the address of the user's own instance, for
     example `http://host.docker.internal:11434`. For safety, Grafito's own
     server and internal services are rejected.
3. Open the chat with the floating button or **Ctrl+B**. Pick a model and ask.

The assistant can list portfolios, search, read, create and edit notes, within
the permissions of your role. The chat lists each tool it used, and you can
click one to open the note.

To try it with a local open model:

```bash
docker compose --profile ai-test up -d
```

This starts Ollama with `qwen2.5:1.5b`. Allow Ollama in administration, then
connect `http://ollama:11434` in your account.

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

Tokens carry your role's permissions. Errors are JSON `{ "error": "..." }` with
status 400, 401, 403, 404 or 409.

## Configuration

The server reads environment variables. `.env.example` documents all of them.
Inside Docker Compose they are already set in `docker-compose.yml`.

| Variable | Purpose | If missing |
| --- | --- | --- |
| `DATABASE_URL` | Postgres for accounts, vaults and sharing | Embedded PGLite (development only) |
| `ELASTICSEARCH_URL` | Full-text search | Search index in Postgres |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | MinIO or S3 for files | Files kept in the vault |
| `REDIS_URL` | Session deadlines | Stored in Postgres |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Session signing and public URL | Required in production |
| `GRAFITO_ENCRYPTION_KEY` | Encrypts users' AI keys (32+ characters) | AI keys can't be saved |

### Testing external sign-in locally

```bash
docker compose --profile auth-test up -d
```

This starts Keycloak on `127.0.0.1:8180` and OpenLDAP with sample users from
`dev/auth-test/`. The comments in `docker-compose.yml` list the test
credentials to enter in **Administración → Autenticación**.

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

- [docs/OPERATIONS.md](docs/OPERATIONS.md): backups, restore, secret rotation
  and what to do when something is down.
- [ARCHITECTURE.md](ARCHITECTURE.md): folder layout, layers, data model,
  sharing, sync, authentication and AI internals.
- [TEST.md](TEST.md): the end-to-end test log for each round of changes.
- [ROADMAP.md](ROADMAP.md): what is planned next.

## License

Grafito is licensed under the [GNU Affero General Public License v3.0](LICENSE).
If you run a modified version as a network service, you must offer its source
code to the users of that service.
