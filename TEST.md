# Grafito tests

This is the log of end-to-end testing with Docker Compose, starting after the
architecture cleanup (see [ARCHITECTURE.md](ARCHITECTURE.md)). The interface is
in Spanish, so on-screen text is quoted as it appears, with a translation where
it helps.

- **Date:** 2026-10-25
- **Environment:** Windows 11, Docker Desktop 29.6.1, Compose v5.3.0, the
  `node:22-bookworm-slim` image (npm 10.9.9)
- **Services:** Postgres 16, Elasticsearch 8.15.3, Redis 7, MinIO (Chainguard)
- **Browser:** built-in browser pane (Chromium), desktop and mobile 375×812

## How it was done

1. Removed the previous build: `docker compose down`, then deleted the
   `grafito-app` image and the local output (`.vercel/`).
2. Ran `docker compose build --no-cache app`.
3. Ran the e2e tests in an **isolated project** with empty volumes, so existing
   data wasn't touched (the `grafito_*` volumes already held an administrator
   and 2 users):

   ```bash
   docker compose -p grafito-e2e up -d --build
   ```

   Afterwards the project was torn down with
   `docker compose -p grafito-e2e down -v`, which deletes only the test volumes.
4. Started the normal stack again (`docker compose up -d`) with the new image:
   - 5 healthy services.
   - `GET /` → 200.
   - The sign-in screen, with existing data intact.

Credentials were used only on the disposable stack: administrator `admin`
(initial password `admin`) and a user `e2e` with the Member role.

## Overall result

| Area | Result |
| --- | --- |
| Image build | ✅ (after fixing the lockfile, see finding 1) |
| Service startup and health | ✅ |
| Migrations on Postgres | ✅ `0001`–`0005` applied |
| First run and forced password change | ✅ |
| Sign-in, sign-in errors and sign-out | ✅ |
| Notes: create, edit, links, tags, tasks | ✅ |
| Replication to the server (Postgres `doc_index` and Elasticsearch) | ✅ |
| Search palette | ✅ (searches titles and tags) |
| Administration: backends, storage, monitor, logs | ✅ (with notes) |
| Users: creating a Member, and the audit log | ✅ |
| Session length (Redis) and closing sessions | ✅ |
| Permissions: a Member can't reach administration | ✅ UI and server |
| Account: profile and email validation | ✅ |
| Mobile 375×812 | ✅ no horizontal overflow |
| Data isolation between users of the same browser | ✅ fixed and verified (finding 2) |

## Cases tested

### Infrastructure

| Case | Expected | Got |
| --- | --- | --- |
| `docker compose -p grafito-e2e up -d --build` | 5 healthy services, `minio-init` exits 0 | ✅ |
| `GET /` | 200 | ✅ 200 |
| `/manifest.webmanifest`, `/icon-180.png`, `/favicon.svg`, `/og.jpg` | 200 | ✅ |
| `/api/auth/get-session` without a session | 200 (`null`) | ✅ |
| Removed Grok routes: `/__grok/manifest.webmanifest`, `/auth/popup`, `/__app-env` | 404 | ✅ |
| `_migrations` on an empty database | `0001`–`0005` | ✅ |
| `grafito-docs` index in Elasticsearch | Created | ✅ |

### Access

| Case | Expected | Got |
| --- | --- | --- |
| An empty database shows "Primera vez" (first run) with `admin`/`admin` | Yes | ✅ |
| Create the administrator | Goes to "Cambia la contraseña" (change password) **without reloading** | ✅ (earlier bug already fixed) |
| New password shorter than 8 characters | "necesita al menos 8 caracteres" (needs at least 8 characters) | ✅ |
| Wrong current password | "No se cambió. Revisa la contraseña actual." (not changed, check your current password) | ✅ |
| Valid change | Enters the vault | ✅ |
| Sign-in with a wrong password | "Usuario o contraseña incorrectos." (wrong username or password) | ✅ |
| Sign-in with a nonexistent user | Same message (doesn't reveal whether the user exists) | ✅ |
| Member signs in | Enters the vault | ✅ |
| Sign out | Back to sign-in, 0 rows in `session` | ✅ |

### Vault

| Case | Expected | Got |
| --- | --- | --- |
| "Nueva nota" (new note) | Creates "Sin título" (untitled) | ✅ |
| Title typed on the keyboard, then Enter | Saved and replicated | ✅ "Prueba E2E" in Postgres and Elasticsearch |
| Body with `[[Bienvenida]]`, `#e2e #docker`, `- [ ]` | Link, tags, checkbox, outline and "links in the text" | ✅ |
| Reload | The note persists | ✅ (`localStorage`) |
| Palette "Prueba" | Finds the document | ✅ |
| Palette "docker" | Finds the tag | ✅ |
| Palette "end-to-end" (body text) | — | No results: the palette doesn't search note bodies |
| Graph | Renders | ✅ 14 documents · 31 links |

### Administration

| Case | Expected | Got |
| --- | --- | --- |
| Backends → Check | All three engines respond | ✅ "Elasticsearch 8.15.3", "MinIO listo. Cubo «grafito»" (MinIO ready, bucket «grafito»), Postgres |
| Storage | Size per engine | ✅ with notes (finding 6) |
| System monitor | CPU, memory, load | ✅ |
| New user (Member) | Appears in the list | ✅ |
| System logs | Records the new user | ✅ "Crea a e2e · Usuarios · admin" |
| Session → 15 min → "Aplicar y salir" (apply and sign out) | Saves the length and closes all sessions | ✅ `session_ttl_seconds=900`, no `grafito:lease:*` in Redis, 0 sessions |
| A Member opens `/admin` | Blocked | ✅ "Sin permiso" (no permission) |
| A Member calls `adminState` on the server | No administration data | ✅ returns empty lists and `isAdmin: false` |

The server functions without a role check were reviewed:

- `createInitialAdmin` refuses if an administrator already exists.
- `syncDocuments`, `searchDocuments`, `sessionPulse`, `revokeOwnLease`,
  `accountState` and `updateAccount` filter by `context.userId`.
- All other functions check permissions.

### Account and mobile

| Case | Expected | Got |
| --- | --- | --- |
| Invalid email | Browser validation | ✅ |
| Save name and email | "Guardado" (saved), and the initials change | ✅ "MR" |
| Mobile 375×812 | Bottom bar, no horizontal scroll | ✅ `scrollWidth = 375` |

### Console and logs

- Expected console errors:
  - 401 ×2, from the two intentionally failed sign-ins.
  - 400, from the change with a wrong current password.
- A 504 "Outdated Optimize Dep" and a failed dynamic import on the first visit:
  Vite's dev-mode optimizer reloads the page once (finding 4).
- Container logs show Better Auth warnings about the weak secret (finding 3)
  and TanStack Router `notFoundError` (finding 7). There were no application
  errors.

## Findings

### 1. Lockfile incompatible with the image's npm (fixed)

- **Symptom:** `docker compose build` failed in `npm ci` with "Missing:
  lru-cache@11.5.3 from lock file".
- **Cause:** `package-lock.json` had been regenerated with npm 11 (local Node
  24) while removing dependencies. npm 11 doesn't record `unstorage`'s optional
  peer `lru-cache@^11`, which npm 10 (Node 22, the image's npm) requires.
- **Fix:** regenerated it with the image's npm:

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-bookworm-slim npm install --package-lock-only
```

The resulting lockfile works for `npm ci` with both npm 10 and npm 11.
Recommendation: use Node 22 locally too (for example with `.nvmrc`).

### 2. Users of the same browser shared one vault (**critical, fixed**)

**Problem:**

- The vault was saved in `localStorage` under one global key (`grafito.v2`).
  It was loaded when the store was imported, before the app knew who the user
  was.
- When the administrator signed out and the Member signed in on the same
  browser, the Member saw the administrator's notes.
- `VaultMirror` then replicated them to the Member's index. `doc_index` ended up
  with 14 documents (including the admin's note) under each user.
- This came from the original design, not from the cleanup.

**Fix:**

- `src/app/vault/store.ts`:
  - Each user saves under `grafito.v2:<userId>`.
  - The store starts empty (`owner: null`). `openVaultFor(userId)` loads that
    user's vault, or the sample one if they have none.
  - `closeVault()` saves and unloads it.
  - Only the administrator (`heldAdminId() === userId`) inherits the old shared
    key (`grafito.v2` / `grafito.v1`), once, and the key is then deleted.
- `VaultApp` renders nothing until the loaded vault belongs to the signed-in
  user. `AdminScreen` and the header search open it too.
- `VaultMirror` only replicates when the vault belongs to the current session.
- `leaveApp` and `SessionWatch` close the vault on sign-out or when the session
  expires.

**Verification** (isolated `grafito-e2e` stack, empty database, same browser):

| Step | Expected | Got |
| --- | --- | --- |
| A browser holds the old shared key (note "Nota heredada"); the admin signs in | The admin inherits it and the shared key is deleted | ✅ only `grafito.v2:<adminId>` remains |
| The admin writes `CONTENIDO-SECRETO-ADMIN`, creates a Member and signs out | — | ✅ |
| The Member signs in | Sample vault, without the admin's notes | ✅ doesn't see "Nota heredada" or the secret content |
| The Member writes `CONTENIDO-MIEMBRO` | Own key `grafito.v2:<memberId>` | ✅ |
| `doc_index` on the server | Each user has only their own documents | ✅ admin: 2 docs (inherited and secret); Member: 14 (sample and own); nothing crossed |
| The Member signs out and the admin returns | The admin's vault, without the Member's note | ✅ |
| Header search on `/cuenta` | Lists the current user's notes | ✅ |

`npm run typecheck`, `npm test` and `npm run lint` still pass. The 5 lint
warnings predate this work.

**Data that was already mixed:** an installation where one user replicated
another's notes repairs itself:

- `syncDocuments` deletes and rewrites each user's index on their next sync,
  about 8 seconds after they open their vault.
- In the browser where the administrator signs in first, the administrator
  inherits the old shared vault. Every other account starts with the sample
  vault.

### 3. Weak Better Auth secret in `docker-compose.yml`

`BETTER_AUTH_SECRET: grafito-dev-secret-cambia-esto` triggers length and
entropy warnings. For any real use, generate one (`openssl rand -base64 32`)
and move it out of the compose file, for example into a `.env`.

### 4. The image ran the development server (fixed in round 2)

The `Dockerfile` started `npm run dev`. As a result:

- The first visit reloaded the page (Vite's optimizer).
- The process used about 2.4 GB of memory.
- Code was served unminified.

The right setup is `npm run build` in the image, serving Nitro's output with
the `node-server` preset (it was `vercel` at the time).

### 5. `app` started without its dependencies after a Docker restart (fixed in round 2)

Before this test, the `app` container (from the previous build) was in a
restart loop with `getaddrinfo ENOTFOUND postgres`. Docker Desktop had
restarted, and only `app` had `restart: unless-stopped`, so it came back up
without the other services. Fix: `restart: unless-stopped` on Postgres,
Elasticsearch, Redis and MinIO.

### 6. Incomplete or odd storage panel (partly fixed in round 2)

For Elasticsearch it reported "base 59 GB" when the index takes about 64 kB:
that was the used space on the node's disk. **Fixed:** "base" is now the size
of the index (`/_stats/store`). MinIO still doesn't appear.

### 7. No custom 404 page

A nonexistent URL returns TanStack Router's generic `<p>Not Found</p>` and logs
`notFoundError` warnings. `src/router.tsx` lacks a `defaultNotFoundComponent`.

### 8. Minor notes

- ~~On "Primera vez" the password field is `type="text"`, so the password is
  shown in clear text.~~ Fixed in round 2.
- Users created from administration don't have to change their password on
  first sign-in (the administrator does).
- Elasticsearch stays `yellow`, because the index asks for 1 replica on a
  single node. `number_of_replicas: 0` would fix it.
- The README mentioned "editor" and "reader" roles, but the roles offered are
  Administrator, Anonymous and Member.
- The search palette doesn't search note bodies. Full-text search lives in
  administration.

## Round 2: sign-in, administration and permissions

Tested with the new **production image** on the isolated `grafito-e2e` stack
with an empty database. Afterwards the image was deleted and the normal stack
was recreated with `docker compose up -d --build` (5 healthy services, existing
data intact).

### Slow sign-in, or sign-in that "keeps loading"

**Cause 1, the session lease:**

- `assertLease` (`src/server/lease.ts`) deleted **all** of a user's sessions
  when their previous lease had expired, including the session just created by
  signing in.
- This happened whenever someone closed the browser without signing out and
  their deadline passed.
- The sign-in got in for a moment, then the pulse (12 seconds) kicked it out.
  The second attempt worked because the old lease was gone by then.
- Reproduced: right after signing in, 0 sessions remained.

**Fix:** if there is a session created after the deadline, only older sessions
are deleted and a new lease is granted.

**Cause 2, the image in development mode:**

- Vite dev compiled each module and server function on the first request,
  about 0.8 seconds each.
- It also forced a page reload on the first visit ("Outdated Optimize Dep").

**Fix:** a two-stage `Dockerfile` with a production build (Nitro
`node-server`).

| Measure | Before (dev) | After (production) |
| --- | --- | --- |
| Image | 1.35 GB | 356 MB |
| `app` memory | about 2.4 GB | about 48 MB |
| Sign-in page load | Forced reload on the first visit | 120 ms, no reload |
| Create administrator → "Cambia la contraseña" | 665 ms (warm) | 462 ms |
| Change password → vault | 432 ms | 329 ms |
| Sign-in with an expired lease | Kicked out after about 12 s | 211 ms and stays in (1 session, lease renewed) |

Measured per server function (curl, warm):

- `accessState`: about 10 ms.
- `sign-in`: about 170 ms (password hashing).
- `get-session`: about 20 ms.
- `sessionProfile`: about 15–30 ms.

### Cases tested

| Case | Result |
| --- | --- |
| "Primera vez": initial password hidden | ✅ `type="password"` |
| Storage and monitor: new meter (`ui/UsageMeter`) | ✅ rounded track with the % written; no longer looks like a text field |
| Elasticsearch "base" | ✅ 17 KB, the real index size (previously "59 GB", which was the disk) |
| Roles without a fixed "Nuevo rol" (new role) bar | ✅ the field only appears after clicking "Nuevo rol" |
| Users: search | ✅ "lect" → only "Lector Uno"; doesn't grab focus on open (focus on `BODY`) |
| Users: "Eliminar" (delete) as text | ✅ red text link → "¿Eliminar? Sí · No" → deleted |
| Administrator's role | ✅ the form shows a fixed "Administrador" without a selector (the server already refused changes) |
| Logo from administration, with a note open earlier | ✅ goes back to `/` with no note open |
| Directory: collapse | ✅ the button is on the directory bar (« arrow); the header no longer has it |
| Collapsed directory | ✅ leaves a 36 px rail with a » arrow to expand it |
| Member with only "Notas → Leer" (notes → read) | ✅ details below |
| Shortcuts with that role (Ctrl+N, Ctrl+G, Ctrl+E) | ✅ don't create a note or open the graph or editor |
| Granting "Ver grafo" (view graph) and "Editar" (edit) live | ✅ they appear within 14 s, without reloading |
| Revoking them live while in edit mode | ✅ the editor closes by itself, falls back to read, and the graph disappears |

Details for the Member with only "Notas → Leer":

- No graph, new note, new portfolio, upload, import, link or unlink controls.
- Edit and Split are disabled.
- The title is read-only.
- Task checkboxes are disabled.
- "Más acciones" (more actions) shows "Sin acciones para tu rol." (no actions
  for your role).

## Round 3: sharing (private, shared, public)

Production image on the isolated `grafito-e2e` stack with an empty database.
Afterwards the normal stack was recreated with `docker compose up -d --build`.
The `0006_share.sql` migration applied over the existing data with nothing lost
(1 administrator, 2 users).

Test users: the administrator, Ana and Beto (Member; the role includes
`notes.share`).

| Case | Expected | Got |
| --- | --- | --- |
| Admin: "Más acciones → Compartir…" on «Bienvenida» → shared with Ana | Saved, and the note shows 👥 | ✅ the dialog lists Ana and Beto; "shared" icon visible |
| Admin: right-click the «Atlas» portfolio → Compartir… → public | Generates a `/p/<token>` link | ✅ 32-character link with a «Copiar» (copy) button |
| Published copy | Only what is shared | ✅ «Bienvenida», plus Atlas's 4 notes and file; nothing else |
| Admin edits «Bienvenida» | Republished automatically | ✅ the new text appears in the copy in about 2.5 s |
| Public link **without a session** (0 sessions) | Read-only Atlas index | ✅ details below |
| Made-up link | Notice | ✅ «Este enlace no existe o dejó de ser público.» (this link doesn't exist or is no longer public) |
| `/compartidos` without a session | Asks to sign in | ✅ shows sign-in and, after it, the list |
| Ana: shared with me | Only «Bienvenida» (Atlas is by link) | ✅ «Bienvenida · Nota · de Administrador» |
| Ana opens the note | Latest version, read-only | ✅ «Compartido por Administrador · Solo lectura» (shared by Administrator, read-only); no Edit, Split or Delete |
| Beto opens Ana's note URL | Denied by the server | ✅ «No existe o ya no está compartido contigo.» (doesn't exist or is no longer shared with you); his list is empty |
| Admin sets Atlas to private | The link stops working and the copy is deleted | ✅ 0 published portfolios; the link shows the notice |
| Admin deletes «Bienvenida» (shared) | No longer shared | ✅ 0 items, 0 grants, 0 published documents |

Details for the public link without a session:

- 5 documents.
- The file renders.
- 0 editable fields.
- The title is «Atlas · Grafito».
- «Bienvenida» isn't included.

`npm run typecheck`, `npm test`, `npm run lint` (0 errors, 5 earlier warnings)
and `vite build` pass. The browser bundle contains no server code
(`node:crypto`, sharing SQL).

## Round 4: small fixes

| Case | Result |
| --- | --- |
| Sign-in screen | ✅ the username starts empty (it used to be prefilled with «admin») and focused; "Primera vez" keeps `admin`/`admin` on purpose |
| Role selector (`ui/Select`) | ✅ its own arrow 12 px from the edge; text with a 40 px right margin |
| Sample notes in a new vault | ✅ Atlas, Diario, Inicio, Personal and Taller sit inside «Documentación» |

Vaults that were already saved don't change: the new layout applies to new
vaults or after «Restaurar notas de ejemplo» (restore sample notes).

## Round 5: editor, details panel, Documentación and first run

| Case | Result |
| --- | --- |
| Click on the line under Edit / Split / Read | ✅ details below |
| Split's vertical line | ✅ doesn't fall inside the editor either |
| Details panel | ✅ details below |
| Vault saved before «Documentación» existed (including the administrator's) | ✅ details below |
| «Primera vez» | ✅ details below |

Click on the line under Edit / Split / Read:

- Before, the editor started at that exact pixel, so the click placed the
  cursor.
- Now there is a 6 px non-editable margin.
- Checked with `elementFromPoint` on the line and up to 6 px below it.

Details panel:

- Sections are separated by a line, each with an icon, title, counter and a
  sentence explaining what it holds.
- «Escritos en la nota» became «Enlaces en el texto» (links in the text).
- «Vincular» (link) is an action in the header.
- Links to notes that don't exist say «sin crear» (not created).

Vault saved before «Documentación» existed:

- On opening, Atlas, Diario, Inicio, Personal and Taller move inside
  «Documentación».
- A user's own root portfolio («Mi proyecto») isn't touched.
- It applies only once.

«Primera vez»:

- Username and password start empty.
- With a password of 8+ characters it enters directly (346 ms) without asking
  for a change.
- With a short one, or «admin», it still asks for a change.

## Round 6: icon buttons without a hover background

These buttons no longer show a background box on hover; the icon changes color
instead (the logo and the avatar dim):

- The logo, graph and account buttons.
- Collapse and expand the directory.
- New portfolio.
- Close, pin and more actions on the note.
- The graph controls.

The open graph is marked only with the accent color. List and menu rows keep
their background, because it shows which row is being chosen. Checked in the
browser: none of those buttons has `hover:bg-*`.

## Round 7: organizations and external authentication (LDAP, OAuth, SSO)

Isolated `grafito-e2e` stack with an empty database and the `auth-test` profile
(Keycloak 26 and OpenLDAP with data from `dev/auth-test/`). Afterwards the
normal stack was recreated: `0007_orgs_auth.sql` applied over the existing data
(1 admin, 2 users).

### Authentication

| Case | Result |
| --- | --- |
| «Autenticación» menu with LDAP, OAuth and SSO | ✅ |
| LDAP: «Probar conexión» (test connection) looking up `carla` | ✅ «Encontrado: Carla Directorio (carla@empresa.test) · uid=carla,ou=people,dc=grafito,dc=test» |
| SSO: «Probar emisor» (test issuer) `http://keycloak:8080/realms/grafito` | ✅ issuer and sign-in URL read |
| Save: secrets | ✅ details below |
| Sign-in | ✅ «Cuenta de Grafito / Directorio (LDAP)» tabs and a «Keycloak» button |
| LDAP: `diego` (`otro.test`, a domain that isn't allowed) | ✅ «Tu dominio de correo no tiene acceso.» (your email domain has no access); no account created |
| LDAP: wrong password | ✅ «Usuario o contraseña incorrectos.» |
| LDAP: `carla` | ✅ signs in; account created as Member, `source = ldap`, `ldap` account linked |
| SSO: `sofia` in Keycloak (PKCE, callback `/api/auth/oauth2/callback/sso`) | ✅ returns signed in; account created as Member, `source = sso` |
| SSO: `intruso@otro.test` | ✅ details below |
| OAuth Google/GitHub/Microsoft | ⚠️ configuration and buttons ready; not tested end to end, because each provider needs real credentials |

Saving secrets:

- They are stored in `auth_provider`.
- When the panel reopens, the field comes back empty («guardado; vacío lo
  conserva», saved; empty keeps it).
- The page doesn't contain the secret.

SSO with `intruso@otro.test`:

- Returns to `/login?error=unable_to_create_user`.
- Shows «Tu cuenta no tiene acceso a Grafito (dominio no permitido).» (your
  account has no access, domain not allowed).
- 0 `otro.test` accounts are created.

### Organizations

| Case | Result |
| --- | --- |
| Users and permissions → Organizations | ✅ new card next to Users and Roles |
| Create «Empresa» and its sub-organization «Ventas»; Carla in Ventas | ✅ tree with counters: «1 miembros directos · 1 con sus sub-organizaciones» |
| Share dialog | ✅ «Organizaciones · incluye sus sub-organizaciones» section with paths («Empresa › Ventas»), followed by Users |
| Share «Bienvenida» only with «Empresa» | ✅ `share_org_grant` = Empresa, 0 direct users |
| Carla (member of Ventas, a sub-organization of Empresa) | ✅ sees it under shared with me and opens it read-only |
| Sofía (no organization) | ✅ empty list; the direct URL answers «No existe o ya no está compartido contigo.» |

### Notes

- **Lockfile:** `npm install ldapts` with the local npm 11 broke the lockfile
  for the image's npm 10 again. It was regenerated with the container's npm
  (command in ARCHITECTURE.md → External authentication).
- **Signing out doesn't end the provider session:** after signing out of
  Grafito, Keycloak keeps its session, so the next «Keycloak» sign-in goes
  through without a password. That is normal SSO behavior; global sign-out
  would be a separate improvement.
- **Rate limiting:** Better Auth warns that it can't determine the client IP
  and uses a single counter per route. Behind a reverse proxy, configure
  `advanced.ipAddress.ipAddressHeaders`.

## Round 8: server-side vault, REST API and AI assistant

Isolated `grafito-e2e` stack with an empty database and the `ai-test` profile
(Ollama 0.6.8 with `qwen2.5:1.5b`). Afterwards the normal stack was recreated:
`0008_vault_api_ai.sql` applied over the existing data, with
`GRAFITO_ENCRYPTION_KEY` present.

### Automated tests

`npm test` ran 17 tests:

- The 5 earlier tests.
- 8 adapter tests, using real sample bodies from each API: tools, calls,
  results, URLs and headers for OpenAI, Anthropic, Gemini and Ollama, plus
  readable errors.
- 4 encryption tests: round trip, distinct ciphertexts, tampering detected,
  a different key, and no key.

### Sync

| Case | Result |
| --- | --- |
| First sign-in: the vault uploads itself | ✅ 13 documents and 6 portfolios in `vault_doc` / `vault_portfolio`, revision 1 |
| A note created by the AI appears in the browser | ✅ without reloading (sync after the response) |
| A note created and edited through the API appears in the browser | ✅ browser revision = server revision (4) |
| A browser edit reaches the server | ✅ in about 1.5 s (revision 5) |

### REST API (with a personal token and `curl`)

| Case | Result |
| --- | --- |
| Account → API: create a token | ✅ 47-character `gft_…`, shown only once; the list shows only the prefix |
| `GET /me`, `/portfolios`, `/notes?q=grafo` | ✅ |
| `POST /notes` in a portfolio, then `PATCH` | ✅ |
| `GET /notes/:id/file` (sample SVG) | ✅ 200 `image/svg+xml` (previously 404: data URLs with `;charset=utf-8` weren't decoded; fixed) |
| Invalid token / no authentication | ✅ 401 with a message |
| Cookie from another site | ✅ 403 |
| Malformed JSON | ✅ 400 |

### AI

| Case | Result |
| --- | --- |
| Chat with no allowed providers | ✅ «El administrador todavía no ha activado proveedores de IA.» (no providers enabled yet) |
| Admin → AI: the 8 providers; «Probar» (test) on Ollama and LM Studio | ✅ «Responde. 1 modelos: qwen2.5:1.5b» |
| Chat with allowed but unconnected providers | ✅ «Todavía no has conectado…» (you haven't connected…) with a link to Account |
| Account → AI: fake ChatGPT key | ✅ real call to OpenAI, «respondió 401. La clave no es válida…»; **not saved** |
| Connect Ollama and LM Studio | ✅ |
| Chat with a provider but no model | ✅ «Selecciona un modelo para empezar.» (pick a model to start) and the input disabled |
| Ollama: «¿Qué portafolios tengo?» (what portfolios do I have?) | ✅ uses `list_portfolios` and lists the 6 real ones (15 s, CPU) |
| Ollama: create «Resumen IA» | ✅ details below |
| LM Studio (OpenAI adapter against `ollama:11434/v1`): read «Resumen IA» | ✅ uses `read_note` and quotes the real content |
| Tool chip | ✅ opens the note |
| Ctrl+B / Esc | ✅ open and close; inside the editor Ctrl+B makes text bold and doesn't open the chat |
| Mobile 375×812 | ✅ full-screen panel; button above the bottom bar |
| Conversation after a reload | ✅ kept in the tab |

Creating «Resumen IA» with Ollama, in a new conversation:

- The model calls `create_note`.
- The note appears on the server, with author «Administrador (IA)».
- It also appears in the directory.

### Findings

- **Very small models:** with a long history, `qwen2.5:1.5b` once answered
  «nota creada» (note created) without calling the tool, and nothing was in the
  database. In a new conversation it does use the tool. For real work, use a
  7B+ model or a cloud one.
- **Title instead of id:** the model passed a title to `read_note`. The read
  and edit tools now accept an id or an exact title.
- **Claude, Gemini, Grok, DeepSeek and Kimi** weren't tested end to end,
  because no keys were available. Their formats are covered by the tests, and
  the invalid-key error was tested against the real OpenAI API.

## Round 9: switches, AI panel and per-user local instances

| Case | Result |
| --- | --- |
| Switches in Administration → AI | ✅ details below |
| Provider list | ✅ only the name and the switch (no company line, no «Guardado.»; a notice appears only on failure) |
| Administrator and local providers | ✅ no address field any more: only on/off |
| Account → AI, Ollama | ✅ «Conectar» (connect) asks for your instance's address (suggested `http://host.docker.internal:11434`) and an optional key |
| `http://localhost:11434` | ✅ rejected: «localhost sería el propio servidor de Grafito…» (localhost would be Grafito's own server) |
| `http://postgres:5432` | ✅ rejected: «Esa dirección es un servicio interno de Grafito.» (that address is an internal Grafito service) |
| `file:///etc/passwd` | ✅ rejected |
| Nonexistent host | ✅ «No se pudo conectar…» (couldn't connect); not saved |
| `http://ollama:11434` (the user's instance) | ✅ «Conectado. 1 modelos disponibles.»; saved in that user's `ai_credential.base_url` |
| Chat with the user's own instance | ✅ only Ollama (what's connected) appears; uses `list_portfolios` and lists the 6 portfolios |
| `npm test` | ✅ 20 tests (3 new ones for address validation) |
| Migration `0009` over existing data | ✅ `ai_provider.base_url` dropped, `ai_credential.base_url` created |

Switches in Administration → AI:

- Before, the knob was `absolute` without `left`, so it slid out of the track.
- Now `ui/Switch` (flex) is used in AI, Plugins, Backends and Authentication.
- Checked by measuring the knob and the track on all three screens.

## Round 10: theme-aware switches, sectioned settings

New image (`grafito-app` was deleted and rebuilt), tested on the isolated
`grafito-e2e` stack with an empty database. Afterwards it was torn down with
`down -v`, and the normal stack came back with its data.

| Case | Result |
| --- | --- |
| Switch on, Folleto theme | ✅ `accent` track and a light `accent-fg` knob |
| Switch off, Folleto theme | ✅ `inset` (cream) track, `line` (black) border and a `muted` (dark gray) knob; before, everything looked black |
| Administration → Plugins and the other cards | ✅ no descriptions («Piezas que se pueden pausar», etc.) |
| Raíz | ✅ without «Cuatro miradas, sin manual» |
| Administration sidebar | ✅ collapses to an icon rail and expands (`chrome/SettingsNav`, remembered in `localStorage`) |
| Account by sections | ✅ account details, password, AI connections and API, with the same collapsible sidebar as Administration |
| Account without `ai.use` / `api.use` | ✅ those sections don't appear |
| Account on mobile (375 px) | ✅ cards, «Atrás» (back), no horizontal scroll |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 20 tests |

## Round 11: «Compartidos conmigo» inside the vault

Isolated `grafito-e2e` stack with an empty database: the administrator and a
test user «Lectora» (Member role). The administrator shared the «Atlas»
portfolio and the «Ritual de la mañana» note with her.

| Case | Result |
| --- | --- |
| Lectora's directory | ✅ «Compartidos conmigo» (shared with me) is a second root, below her own notes (no longer a link to another page) |
| Expand «Atlas» | ✅ shows its notes and files (Bitácora de campo, Fuentes, Hipótesis de Atlas, Mapa del proyecto Atlas, Plano del obrador), with the owner alongside |
| Open a shared note | ✅ shown in the main area, read-only («Compartido por Administrador · Solo lectura»), and highlighted in the directory |
| Open an own note, or click Raíz | ✅ the shared view closes and the editor / home page returns |
| A single shared note | ✅ opens with one click |
| Mobile (375 px) | ✅ from «Notas», opens the shared note in the «Nota» tab, no horizontal scroll |
| Raíz size | ✅ 40 px tall (was 56) with a 16 px icon; «Compartidos conmigo» matches |
| Collapsing «Compartidos conmigo» | ✅ remembered in the browser (`grafito.shared-open`) |
| Signing out | ✅ closes the shared view (`leaveApp`) |
| `/compartidos` and `/compartidos/$id` | ✅ still work for direct links |

## Round 12: history, trash, shared editing and operations

New image on the isolated `grafito-e2e` stack with an empty database (its
`backup` service scaled to 0). The test used the administrator and a Member,
«Lectora». The administrator shared the «Atlas» portfolio with her with
**Puede editar** (can edit). Afterwards the stack was torn down with `down -v`
and the normal stack was rebuilt: migration `0010` applied over the existing
data.

### Operations and security

| Case | Result |
| --- | --- |
| Response headers on `/` | ✅ `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` |
| CSP violations in the console (sign-in, vault, admin, history) | ✅ none |
| `GET /no-existe` | ✅ status 404, custom page with «Volver a la bóveda» (back to the vault) |
| Internal service ports | ✅ Postgres, Elasticsearch, Redis and MinIO bound to `127.0.0.1` only |
| `backup` service | ✅ wrote `backups/grafito-<date>.dump` on startup |
| Restore the dump into a scratch database (`pg_restore`) | ✅ 13 documents; the scratch database was then dropped |
| MinIO metrics for the storage panel | ✅ `minio_cluster_capacity_usable_*` readable without credentials inside the stack |
| Encryption key rotation | ✅ unit test: data encrypted with the previous key is read and flagged `stale`; without `GRAFITO_ENCRYPTION_KEY_PREVIOUS` it fails |
| `npm test` | ✅ 26 tests (5 new for the diff, 1 for key rotation) |

### Interface cleanup

| Case | Result |
| --- | --- |
| Help texts | ✅ removed: first-run explanation, AI and API intros, curl example, plugin and permission descriptions, admin AI/auth intros, field hints, details-panel hints, share-dialog descriptions |
| Directory footer | ✅ no «Subir archivo» or «Importar Markdown» buttons; right-click «Subir archivo» accepts several files and imports `.md` as notes |
| Raíz | ✅ «Recientes» (recent): the 12 most recently changed documents, with portfolio and date |

### History

| Case | Result |
| --- | --- |
| Admin edits «Hipótesis de Atlas», then opens «Historial» | ✅ two versions (seed and edit); diff `+3 −1` with the changed line struck through and the new lines highlighted; unchanged runs folded («4 líneas sin cambios») |
| Restore the older version | ✅ the note reverts and the open editor updates through sync |
| A restore within 10 minutes of an edit by the same person | ✅ creates its own version (fixed during the round: it used to merge with the edit) |

### Trash

| Case | Result |
| --- | --- |
| Delete «Ritual de la mañana» | ✅ the dialog says it goes to the trash |
| Papelera | ✅ lists it with its portfolio, date and «30 días» left |
| Recuperar (recover) | ✅ back in «Personal» with its content, and opened |
| Delete «2026-03-18», then delete it for good from the trash | ✅ «La papelera está vacía.» (the trash is empty); in the database the content is gone and its 0 versions remain |

### Shared editing (as Lectora)

| Case | Result |
| --- | --- |
| Share dialog | ✅ «Solo lectura» / «Puede editar»; `share_item.access = edit` |
| Compartidos conmigo → Atlas → Hipótesis de Atlas | ✅ bar shows «Puedes editar» (you can edit) |
| Editar → add a line → Guardar | ✅ «Guardado»; the bar shows «Lectora» as last editor |
| History from the shared view | ✅ Lectora's version with `+2 −0`, then the administrator's versions |
| Owner's note on the server | ✅ versions by Administrador and Lectora on the owner's document |
| Conflict: the note changes on the server while Lectora edits | ✅ «Administrador cambió la nota mientras la editabas.» with «Usar la suya» / «Guardar la mía»; «Guardar la mía» saves on top |
| Lectora restores an older version from the shared view | ✅ new version by Lectora; her previous version stays |

## Round 13: files in object storage

New image on the isolated `grafito-e2e` stack with an empty database (both
backup services scaled to 0), with MinIO. A final pass ran without `S3_*`
against the same database.

| Case | Result |
| --- | --- |
| Sample file «Plano del obrador» on the first sync | ✅ the browser sent it as a data URL; the server stored it in MinIO (719 B), set `file_key`, cleared `file_data`, and the browser pulled the keyed version |
| Image from a signed link | ✅ `/api/files/<id>?o&e&s`, rendered (320 px wide PNG) |
| Tampered signature | ✅ 403 «El enlace caducó…» |
| Upload a PNG and a 20 MB file (old limit: ~700 KB) | ✅ 3 parts of 8 MiB to MinIO in about 2 s; progress shown at the bottom of the directory |
| Download the 20 MB file | ✅ 200, `attachment`, 20,971,520 bytes |
| `Range: bytes=0-99` | ✅ 206 with `content-range` |
| Legacy row with `file_data` (inserted by hand) | ✅ moved to MinIO on the next sync; content readable («Hola desde el formato antiguo.») |
| Public link to «Atlas» without a session | ✅ page 200, image 200 through `?token=`; a file outside the share 404; no token 401 |
| SVG response headers | ✅ `attachment`, CSP with `sandbox`, `X-Frame-Options: SAMEORIGIN` |
| Lectora opens the shared «Plano del obrador» | ✅ image from a link signed for the owner; separate signed download link |
| Lectora deletes her own copy and purges it from the trash | ✅ object removed from MinIO (5 → 4), `file_key` cleared |
| Without MinIO (no `S3_*`): upload a 10.5 MB text file | ✅ 2 parts appended to `file_blob`; download identical byte for byte |
| `npm test` | ✅ 30 tests (4 new for signed links) |

Fixed during the round:

- The sync validator still required `dataUrl`, so new key-only file
  documents were rejected.
- A failed link request was cached for 50 minutes. Now only successful links
  are cached, and the viewer retries while a new upload syncs.

After the round, the normal stack was rebuilt:

- Migration `0011` applied.
- Both backup services running.
- The one older file in your data moves to MinIO the first time its owner
  opens Grafito.

## Round 14: Office editor (Collabora) and English interface

Isolated `grafito-e2e` stack with the `office` profile
(`collabora/code:26.04.4.2.1`, `COLLABORA_URL=http://127.0.0.1:9980`).

### Office

| Case | Result |
| --- | --- |
| Collabora starts and publishes `/hosting/discovery` | ✅ `docx` has `edit` and `view` actions |
| Upload a `.docx` (generated by hand, 916 bytes) → «Abrir en el editor» | ✅ the editor opens inside the vault, in Spanish, in «Editando» (editing) mode |
| Type in the document and save | ✅ `PutFile` stored a new object (5,145 bytes); the history has the original (916) and the saved version (5,145) |
| History of the file | ✅ lists both versions, with the file size instead of a diff |
| Same document with the interface in English | ✅ Collabora opens in English (`lang=en`) |
| Collabora warnings `CLONE_NEWUSER` / `coolmount` | ⚠️ harmless without extra privileges; `mount_jail_tree=false` added |
| Grafito opened as `http://localhost:8080` (reported after the round) | ❌→✅ the browser blocked the editor («127.0.0.1 refused to connect»): Collabora's `frame-ancestors` only allowed `127.0.0.1`. The default is now `localhost:*` (`127.0.0.1` is always allowed); the frame loads from `localhost:8080` |

Editing an Office file through a share (as another user) wasn't run end to
end. The permission path (`editableTarget`, checked again on every save) is
the same one tested for notes.

### English interface

| Case | Result |
| --- | --- |
| Account → «Preferencias de usuario» → English | ✅ the whole interface switches immediately; `<html lang="en">`; the `grafito-locale` cookie is set; saved in `app_profile.locale` |
| Reload in English | ✅ the server renders in English (cookie); no hydration errors |
| Scan of visible text (vault, editor, menus, share dialog, trash, graph, command palette, AI chat, every admin section) | ✅ no Spanish interface text left; only note content and tags (which are content) |
| Server messages (errors, log entries, AI tool chips) | ✅ translated through patterns («Elimina a Lectora» → «Deletes Lectora») |
| Back to Spanish | ✅ |
| `npm test` | ✅ 35 tests (4 for translation, 1 for signed tokens) |

## Round 15: Modern design, Classic option and text selection

Tested on the development server (`.claude/launch.json` → `grafito-design`,
PGLite, port 3100) and then on the production image in the isolated
`grafito-e2e` stack with Collabora.

| Case | Result |
| --- | --- |
| Default design | ✅ the server renders `<html data-design="modern">` (development and production) |
| Administration → Apariencia → Diseño | ✅ two cards (Moderno, Clásico) with miniatures in the current theme's colors; switching applies immediately and survives a reload (stored in `app_setting`) |
| Classic | ✅ identical to the previous interface (the Modern layer is scoped to `data-design="modern"`) |
| Modern: vault, home, note, menus, share dialog, AI chat, graph, admin, forms, account, sign-in | ✅ floating glass panels, pill controls with an accent glow, segmented Edit / Split / Read control, blurred overlays |
| Modern with the light themes (Papel, Folleto) | ✅ readable; one apparent glitch was a color transition caught mid-change while switching themes by hand, and the color transition was removed from directory rows |
| Mobile (375 px), Modern | ✅ floating panel and floating tab bar, no horizontal scroll |
| Switches in all 10 themes × 2 designs, on and off | ✅ the knob stays inside the track; contrast between knob and track ≥ 2:1 at rest |
| Text selection | ✅ paragraphs, headings and panel text are selectable (`user-select: auto`); before, almost nothing could be selected |
| Cursor audit (reading, split view, admin; both designs) | ✅ no element outside an editable field shows the text cursor or a caret |
| Office: selecting a `.docx` | ✅ the editor opens directly, with no button; after closing it from the editor, «Abrir en el editor» reopens it |
| Office with a dark theme (reported after the round) | ❌→✅ Collabora followed the theme's dark mode and the text was dark on a dark page. `color-scheme: light` on the iframe wasn't enough on its own (see Round 16): the editor URL now asks for the light theme. |
| Office right after uploading a document | ❌→✅ the editor opened before the document reached the server («Ese documento no se puede abrir en el editor»). It now retries for a few seconds; a freshly uploaded `.docx` opens directly. |
| Untranslated headings in the command palettes («Notas», «Acciones», «Documentos», «Etiquetas») | ✅ translated |
| `npm run typecheck`, `eslint`, `npm test`, `vite build` | ✅ no errors; 35 tests |

## Round 16: menus, panels, Office versions, sign-in dates and local AI

Production image in the isolated `grafito-e2e` stack with Collabora, Grafito
theme (dark), Modern design unless stated. LM Studio was running on the host
(outside Docker) at `localhost:1235`.

| Case | Result |
| --- | --- |
| Right-click a directory row near the bottom | ❌→✅ the menu was cut off by the directory panel (in Modern, its `backdrop-filter` traps `position: fixed`). It now renders in `<body>`, is measured, and opens upward or leftward when it doesn't fit |
| Right-click on the Raíz page (recent documents, and the empty space) | ✅ same menu as the directory; «Renombrar» opens the rename dialog |
| Profile button | ✅ no hover or dimmed state, with the menu open or closed (opacity 1, no background or shadow) |
| Details panel (outline, links, mentions) | ✅ collapses to a right-hand rail and expands again; works in Modern and Classic |
| Collapse the directory, the account menu or the admin menu, then leave and come back | ✅ they come back expanded (the state is no longer kept in the browser) |
| Administration → Usuarios | ✅ each user shows «Primer ingreso» and «Última conexión» with date and time; migration 0014 fills them from existing sessions |
| Office: good edit, save, random words, save, restore the good version | ❌→✅ before, the second save replaced the first one (10-minute grouping) and the open editor kept showing the random words. Now each manual save is its own version, and the editor reloads with the restored content (7 words, no random words) |
| Office: unsaved changes when restoring | ✅ the editor saves them first (`Host_VersionRestore` → `Pre_Restore_Ack`) as their own version, then the restore is applied; 7 versions in the end, none lost |
| Office with a dark theme, again | ❌→✅ still dark on some loads: Collabora follows the system's dark mode when it has no explicit preference. The editor URL now carries `ui_defaults=UITheme=light` (`{"darkTheme":"false"}` in the page); light on every load, also after a restore |
| Ollama removed from `docker-compose.yml` | ✅ the `ai-test` profile and its volume are gone |
| LM Studio on the host at `http://localhost:1235/v1` | ✅ the container reaches it via `host.docker.internal`; Cuenta → Conexiones de IA connects (2 models), the address is kept as typed, and the chat answered with `google/gemma-4-e4b` |
| `localhost` still rejected without the alias, and internal services always | ✅ `local-url.test.ts` |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 36 tests |

## Round 17: profile button and AI chat

Production image in the isolated `grafito-e2e` stack, LM Studio on the host at
`localhost:1235` with `google/gemma-4-e4b`. The app window was in the
background, so the page couldn't be painted; the checks were driven by script
and read from the page.

| Case | Result |
| --- | --- |
| Profile button opened with the mouse, closed with Esc | ❌→✅ the button kept focus, and the next key drew the accent focus ring around it. It now lets go of focus when its menu closes (only when opened with the mouse; with the keyboard it keeps focus and its ring) |
| Model picker | ✅ a small «Elegir modelo» button under the message box; it opens upward with each connected provider and its models; the chosen model is shown and kept after a reload |
| Two messages in one conversation | ✅ the second answer uses the first («Verde») |
| New conversation, same question | ✅ answers «no lo sé»: each conversation keeps its own context |
| History | ✅ lists both conversations (title and date); opening the first brings back its 4 messages |
| Reload the page | ✅ the open conversation and the model come back |
| Delete a conversation | ✅ asks for confirmation and removes it from the list and the server |
| Click outside the panel | ✅ `data-state="closed"` right away, unmounted after 200 ms, and the chat button reappears; opening animates the other way |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 36 tests |

## Round 18: chat box, history placement, profile menu and drag cursor

Production image in `grafito-e2e`, LM Studio on the host. The app window was in
the background again, so the checks read computed styles and the page by script.

| Case | Result |
| --- | --- |
| Chat message box | ❌→✅ the text field drew its own focus ring inside the box, so it looked like two boxes. Now it's a single box (`data-ui="composer"`): text, model and send inside one border, with focus shown on that border; the field's outline is `none` |
| History placement | ✅ the history list takes the messages area; the message box with the model stays below |
| Profile menu (Administración, Cuenta, Salir) | ✅ no hover highlight on the options (no `hover:` classes and no hover rules left for them) |
| Pointer over notes and files in the directory | ✅ hand pointer (`cursor: pointer`), like Raíz; the grabbing hand only while the mouse button is held to drag (`active:cursor-grabbing`) |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 36 tests |

## Round 19: email (SMTP), one-time access for new users and change notifications

Production image in `grafito-e2e` with Mailpit (`--profile mail-test`). The
app window was in the background, so the pages were driven by script. Test
accounts and passwords only, on the throwaway stack.

| Case | Result |
| --- | --- |
| Administración → Correo electrónico: server `mailpit`, port 1025, security «Ninguna», sender, Grafito address; **Probar** | ✅ «Correo de prueba enviado.»; Mailpit got «Grafito: correo de prueba» from «Grafito <grafito@example.test>»; after saving, «El correo está activo.» |
| New user form | ✅ fields Nombre, Usuario, Correo, Rol (no password) |
| Create «ana» with `ana@example.test` | ✅ «Se envió el acceso a Ana Prueba. Vence …»; the list shows «Acceso enviado: vence …»; Mailpit got «Tu acceso a Grafito» with the username and a `/acceso#…` link |
| Where the note is stored | ✅ one `grafito:note:<hash>` key in Redis, none in `app_secret_note`; `app_temp_access` keeps only the password hash |
| Open the link | ✅ shows the username and a 16-character password; the token is removed from the address bar; the Redis key is gone |
| Reload the note page | ✅ «Esta nota ya no existe» |
| Sign in as ana with the temporary password | ✅ goes straight to «Cambia la contraseña» with the current password filled in |
| Second sign-in with the same temporary password | ✅ refused: 403 `TEMP_ACCESS_USED` |
| Ana sets her own password | ✅ she enters the vault; `app_temp_access` is empty |
| **Reenviar acceso** | ✅ «Tu nuevo acceso a Grafito» (says the previous one no longer works); Ana's own password stops working (401) |
| Temporary password past its expiry | ✅ refused: 403 `TEMP_ACCESS_EXPIRED` |
| Email dates | ❌→✅ they were in the server's zone (UTC) without saying so; they now include the zone, and `TZ` can be set for the `app` service |
| Admin edits a note shared with Ana (edit) | ✅ one pending notice, only for Ana (not for the admin who changed it); after the quiet period, Ana got «Cambios en «Bienvenida»» listing «por Administrador» |
| Admin edits a private note | ✅ a version is recorded; no notice |
| Email off, create «beto» | ✅ «No se envió el correo: El correo no está configurado.» and the one-time link to hand over, with Copy |
| Secret note unit tests | ✅ read once, nothing readable stored, wrong token, expired and cancelled |
| `npm run typecheck`, `eslint`, `npm test`, `vite build` | ✅ no errors; 39 tests |

## Round 20: text fields, dropdowns and dialogs

Development server (`grafito-design`), Modern design, Grafito theme, with the
window visible.

| Case | Result |
| --- | --- |
| Typing in Filtrar, the command palette, a note title and the note body | ❌→✅ an accent outline (and, in Modern, a highlighted border) appeared around the field while typing. Text fields no longer draw a focus ring or change their border; the text cursor is enough. Buttons and switches keep their keyboard focus ring |
| Note body in Modern | ❌→✅ the Modern focus ring still won by specificity; the rule now matches with or without a design (`:is(html, html[data-design])`), computed outline `none` |
| New portfolio dialog: click the dialog's empty space | ❌→✅ the click left a text cursor in the empty space; now it leaves none |
| Filtrar: text cursor next to the magnifier (reported after the round) | ❌→✅ the cursor sat right against the icon and was hard to see; the field now has more room (`gap-2.5` and `pl-1`), also in the admin search fields |
| New portfolio dialog: click the dialog's empty space (reported after the round) | ❌→✅ the blinking cursor stayed in the field. Now an empty-space click takes the focus out of the field (`blur`), the cursor disappears and the typed text stays |
| Dropdowns (e.g. Cuenta → Preferencias → Idioma) | ✅ the list opens with rounded corners, the theme's surface and border, rounded options and the chosen one in the accent color (`appearance: base-select`, Chrome and Edge 135+; other browsers keep the native list) |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 39 tests |

## Round 21: email settings layout, stray cursor, Esc and blank new notes

Development server (`grafito-design`) with the window visible.

| Case | Result |
| --- | --- |
| Administración → Correo electrónico | ❌→✅ the form was a narrow column; it now fills the width like the other settings panels, with two columns per group (server, sender, links, test) |
| Click a blank part of the top bar | ❌→✅ the browser put the text selection inside the Filtrar label (the nearest text spot), so a cursor blinked there. Blank clicks on the app frame (top bar, gaps between panels, directory header) no longer move the selection and release any focused field (`app/blank-click.ts`, shared with dialogs) |
| Select a note, press Esc | ❌→✅ it went to Raíz but the row kept a focus border (Esc is a key press, so the browser drew the focus ring on the clicked row). The row now lets go of focus |
| New note | ✅ starts with an empty body (no «# Sin título» line); the title is «Sin título» |
| New note left blank (Esc) | ✅ removed when leaving it; it never reached the server (not back after a reload, not in the trash) |
| New note with text, then Esc | ✅ kept and synced («Idea guardada» is there after a reload) |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 39 tests |

## Round 22: two new designs, labels, stray cursor and Collabora

Development server (`grafito-design`) with the window visible; production
build checked for the new CSS.

| Case | Result |
| --- | --- |
| Account or Administration → click the Grafito logo | ❌→✅ a cursor blinked in Filtrar: the logo text kept a text caret that the browser carried into the vault. The logo no longer takes a caret, and the vault clears a stray one when it opens; back in the vault there is no selection at all |
| Administration → Correo electrónico (and LDAP, OAuth…): click a field's label or the space beside it | ❌→✅ it focused the field with the cursor at the end of its text. Labels of text fields no longer do that; checkboxes and the search pills still do |
| Design picker | ✅ four cards with miniatures in the current theme: Cristal (was «Moderno»), Empresarial, Amigable, Clásico; each with a one-line description, which also fills the card (it had an empty band) |
| Empresarial, Grafito theme (dark) and Papel (light) | ✅ ruled frame, flat surfaces, 6px corners, 24px sans-serif titles, neutral active row, underline tabs, sentence-case group labels; the primary action in the theme's accent (an ink-coloured version made near-black blocks on light themes and was dropped) |
| Amigable, Grafito, Papel and Terminal | ✅ the top bar in the theme's accent with its contrast text; avatar and «+» as a veil of the bar (they first came out as near-black blocks); the profile menu keeps its own colours inside the bar |
| Switches, 4 designs × 10 themes, on and off | ✅ knob against track at least 2.09:1 everywhere |
| Phone (375 px), Amigable and Empresarial | ✅ no horizontal scroll; bar, tabs and tab bar fit |
| Collabora | ✅ the editor URL now also sends `SavedUIState=false` (the page receives `data-saved-ui-state="false"` and `darkTheme: false`), so the light theme wins over a remembered dark mode |
| Production CSS | ✅ `base-select`, `:is(html, html[data-design])`, `color-mix` and the popover exclusion survive the build |
| `npm run typecheck`, `eslint`, `npm test`, `vite build` | ✅ no errors; 39 tests |

## Round 23: back to two designs, and no cursor beside fields

Development server (`grafito-design`), Papel theme, with the window visible.

| Case | Result |
| --- | --- |
| Designs | ✅ Empresarial and Amigable removed (their CSS files, previews and strings); Cristal (was «Moderno») and Clásico remain. An installation saved with a removed design falls back to Cristal |
| Administración → Correo: type in a field, then click just right of it (where the reported screenshot shows the bar) | ❌→✅ the browser left its caret parked after the field, in its label. Now no selection and no focus remain |
| Same, clicking the label text, or the gap between two fields | ✅ no selection, no focus. The first fix missed label text: a scrollbar check misfired on inline elements; it now applies only to elements that scroll |
| Type in a field, then click «Guardar» | ✅ no caret left parked beside the field |
| Clicks inside a field | ✅ it focuses and the cursor shows as usual |
| Filtrar pill (its magnifier) | ✅ still focuses the field |
| Note text | ✅ still selectable (double-click selects a word); clicks on paragraphs aren't cancelled |
| One guard for the whole app | ✅ replaces the per-screen handlers in the vault, the account and admin frame, and dialogs |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 39 tests |

## Round 24: one highlighted row in the directory

Development server (`grafito-design`).

| Case | Result |
| --- | --- |
| Open a note stored in the root | ❌→✅ Raíz lit up too (opening it also marks the root as the current folder). Now only the note is highlighted |
| Click Raíz | ✅ only Raíz |
| Open a note inside a portfolio | ✅ only the note |
| With that note open, click its portfolio | ✅ only the portfolio; the note stays open in the editor |
| Open another note | ✅ only that note |
| «+» after choosing a portfolio | ✅ the new note is created in that portfolio (the current folder still decides where notes go) and only it is highlighted |
| Esc | ✅ nothing highlighted |
| `npm run typecheck`, `eslint`, `npm test` | ✅ no errors; 39 tests |

## Useful commands

```bash
docker compose build --no-cache app
docker compose up -d
docker compose ps
docker compose logs -f app
# Test stack: all services plus OpenLDAP, Keycloak and Mailpit, in its own
# project and volumes. docker-compose.test.yml is local and not versioned.
docker compose stop
docker compose -f docker-compose.test.yml --profile auth-test --profile mail-test up -d --build
docker compose -f docker-compose.test.yml --profile auth-test --profile mail-test down -v
npm run typecheck
npm test
```
