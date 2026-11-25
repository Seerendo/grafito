# Security

How Grafito defends itself, and what was checked by attacking a running copy
(October 2026, the test stack with two users).

## Report

| Area                  | Attack tried                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signing secrets**   | Forge a file link and an Office editor (WOPI) token with the example `BETTER_AUTH_SECRET` from `docker-compose.yml`, which was public in the repository                                                                       | ❌→✅ **Fixed.** With nothing but that value, someone with no account downloaded another user's file and got an editor token with write access. They also needed the owner and document ids, which appear in links of anything shared with them. Now a missing or public example value is replaced by a random secret for each installation (`server/install-secrets.ts`). The same forgery then gets 403 and 401 |
| Stored XSS in notes   | `<script>`, `<img onerror>`, `<svg onload>`, `javascript:` links (any case), payloads in `[[…]]`, code, tables, tags and the note title                                                                                       | ✅ nothing runs: the Markdown renderer emits no raw HTML, links only allow `http(s)` and `mailto`, and React escapes text                                                                                                                                                                                                                                                                                         |
| XSS in Mermaid        | HTML labels with `onerror`, `click … "javascript:…"`                                                                                                                                                                          | ✅ nothing runs (`securityLevel: "strict"`). An `<img>` in a label still loaded an outside image, a tracking pixel in a shared note: ❌→✅ images are now forbidden in labels                                                                                                                                                                                                                                     |
| XSS in comments       | HTML, `javascript:` links and `<script>` in a comment, seen by the owner and the guest                                                                                                                                        | ✅ shown as plain text                                                                                                                                                                                                                                                                                                                                                                                            |
| Malicious uploads     | An SVG with a script and a filename made of HTML; an HTML page; an HTML page renamed `.png` with type `image/png`                                                                                                             | ✅ only images, video, audio and PDF are shown inline. Everything else is a download with `default-src 'none'` and, for HTML, SVG, XML and JS, `sandbox`. `nosniff` stops the fake PNG from being read as HTML                                                                                                                                                                                                    |
| Access control (IDOR) | From another user's session: read, edit and delete a note through `/api/v1/notes/:id`; fetch a file without a signature or with a forged one; save a drawing that isn't theirs; reuse a valid share for a document outside it | ✅ 404, 403 or refused every time. `grantedDocOwner` and `editableTarget` check that the document belongs to the share                                                                                                                                                                                                                                                                                            |
| SQL injection         | `' OR 1=1--`, `UNION SELECT …`, `%` and `_` in search                                                                                                                                                                         | ✅ every query is parameterized (tagged templates or `$1`). `LIKE` patterns escape their wildcards, and Elasticsearch gets a `multi_match`, not query syntax                                                                                                                                                                                                                                                      |
| CSRF                  | A cross-site POST, as a browser sends it                                                                                                                                                                                      | ✅ 403 «Petición de otro sitio» (`Sec-Fetch-Site`). Cookies are `SameSite=Lax` too                                                                                                                                                                                                                                                                                                                                |
| Login brute force     | 12 wrong passwords in a row                                                                                                                                                                                                   | ✅ Better Auth answers 429 from the 4th                                                                                                                                                                                                                                                                                                                                                                           |
| SSRF                  | SSO and LDAP test addresses pointing to Grafito's services or link-local addresses                                                                                                                                            | ✅ refused (`server/internal-host.ts`, with its tests)                                                                                                                                                                                                                                                                                                                                                            |
| Path traversal        | Storage keys outside the user's prefix or with `..`                                                                                                                                                                           | ✅ refused (`ownsKey`)                                                                                                                                                                                                                                                                                                                                                                                            |

## November 2026 review

A source review listed 23 findings (GRAF-01 to GRAF-23). Each one below was
reproduced on the test stack where it could be, fixed, and checked again by
`tests/e2e/security.e2e.mjs`. The same test was also run against a build
without the fixes. It failed there, so it catches each flaw.

| Finding                            | What could happen                                                                                                                                                                                                                         | Now                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GRAF-01                            | Before the first administrator existed, anyone reaching the address could create it, and two forms sent together made **two** administrators (reproduced)                                                                                 | «Primera vez» asks for the installation code written in the app log (or `GRAFITO_SETUP_CODE`); creation is serialized                                                                                                                                                        |
| GRAF-02                            | Any anonymous page load deleted an administrator row left `chosen = false` by an old migration (reproduced)                                                                                                                               | The deletion is gone; migration `0041` marks every administrator chosen                                                                                                                                                                                                      |
| GRAF-03                            | A share of one folder let a crafted search read the owner's whole vault (reproduced: a private note's text came back)                                                                                                                     | Search covers only the caller's own vault                                                                                                                                                                                                                                    |
| GRAF-08                            | The anonymous Git webhook read any body size before checking anything                                                                                                                                                                     | It needs a signature header and the link first, and reads at most 1 MB (413)                                                                                                                                                                                                 |
| GRAF-09                            | Office saves, drawings, embedded data, Git imports and form attachments were stored without the antivirus                                                                                                                                 | They are scanned like uploads                                                                                                                                                                                                                                                |
| GRAF-10                            | A signed file link kept working for an hour after the share was withdrawn (reproduced)                                                                                                                                                    | Links issued through a share carry it, and the file is served only while the share still covers it                                                                                                                                                                           |
| GRAF-11                            | The Office editor kept reading a shared file for up to ten hours after the share was withdrawn                                                                                                                                            | Every read checks the share again                                                                                                                                                                                                                                            |
| GRAF-12                            | WebDAV lockouts counted the first `X-Forwarded-For` hop, which the client writes (rotating it avoided the lockout)                                                                                                                        | The last hop, the one the gateway adds                                                                                                                                                                                                                                       |
| GRAF-13                            | A forged `Host`/`X-Forwarded-Host` let sign-in store a callback to another site, an open redirect after the provider (reproduced: accepted)                                                                                               | Redirect fields must be paths on this site (`lib/auth/redirect-guard.ts`)                                                                                                                                                                                                    |
| GRAF-14                            | Changing the password left the other sessions open (the client asked for that)                                                                                                                                                            | The other sessions end; this device stays signed in                                                                                                                                                                                                                          |
| GRAF-15, GRAF-17                   | The AI address check let through Compose services (Grafeno, Collabora, ClamAV, gateway, backup), link-local addresses such as `169.254.169.254` and the IPv6 form of loopback; the SSO and LDAP tests had no check and followed redirects | All refused for the AI; the SSO/LDAP tests refuse Grafito's services and link-local addresses (LAN providers and the test Keycloak/OpenLDAP still work) and do not follow redirects                                                                                          |
| GRAF-05                            | A secret sealed with the public example key stayed readable with it                                                                                                                                                                       | On start, such secrets are sealed again with the installation key and the example stops being accepted                                                                                                                                                                       |
| GRAF-19, GRAF-20                   | CI actions by movable tag; pull requests wrote the Docker build cache                                                                                                                                                                     | Actions pinned to commits; pull requests only read the cache                                                                                                                                                                                                                 |
| GRAF-21                            | Dependency advisories were never checked                                                                                                                                                                                                  | `npm audit`: better-auth 1.7.26 (an OAuth state could sign in as another user, critical), PDF.js 6.5 (JavaScript from a malicious PDF), nodemailer 10.6, node-forge 1.4.3, zod 4.6.7, unpdf 2.2. Remaining advisories are in Excalidraw's bundled Mermaid and in build tools |
| GRAF-22                            | Someone administering a child folder through a share could change the access of a share of a parent folder                                                                                                                                | Only shares of that folder or below                                                                                                                                                                                                                                          |
| GRAF-23                            | An editor of one shared folder could file **any** object of the owner into that folder and read it (reproduced: the owner's private file showed up there)                                                                                 | An upload into someone else's share is tied to the person and the folder it was started for (`upload_claim`)                                                                                                                                                                 |
| GRAF-04, GRAF-06, GRAF-07, GRAF-16 | Postgres, MinIO, Elasticsearch, Redis and Collabora's console listen on the server's loopback with example or no credentials                                                                                                              | Open: see Known limits                                                                                                                                                                                                                                                       |

## Defenses in place

- **Sessions:** Better Auth with `__Host-` cookies (`Secure`, `SameSite=Lax`),
  or a bearer token where the cookie isn't kept. Server functions and the REST
  API refuse cross-site requests (`isolation.server.ts`, `sameSite` in
  `server/api.ts`). Sign-in is rate limited.
- **Files:** read through short-lived HMAC-signed links
  (`server/file-links.ts`). The Office editor gets a signed token for one
  document and one person. Storage headers are passed through from a closed
  list.
- **Secrets:** `BETTER_AUTH_SECRET` and `GRAFITO_ENCRYPTION_KEY` come from the
  environment or, when missing or set to a public example value, from
  `GRAFITO_SECRETS_DIR` (the `grafito_secrets` volume in Docker). They're kept
  out of the database, so a database dump doesn't include the key that
  decrypts its Git tokens and SMTP password.
- **MCP** (`/api/mcp`): only a personal `gft_` token signs in, never a
  browser session, so another site can't use someone's cookies against it.
  The role needs `api.use`; each tool needs its own permission and is not
  even listed without it, and every call goes through the same access checks
  as the app (no other person's private vault, read-only shares stay
  read-only). Deleting needs `confirm` with the exact name, on top of the
  client asking the person. The request body is limited to 1 MB.
- **Git sync** (optional, docs/GIT.md): access tokens are encrypted with
  `GRAFITO_ENCRYPTION_KEY`. The server only calls github.com, gitlab.com and
  the hosts the administrator lists in `GRAFITO_GIT_HOSTS`, and doesn't follow
  redirects, so a user can't use it to reach internal addresses. Webhooks are
  checked against the link's secret in constant time.
- **Headers:** a Content Security Policy on every page
  (`lib/security-headers.ts`), `X-Frame-Options: DENY`, `nosniff` and a strict
  referrer policy.
- **WebDAV** (`/dav`, `server/dav/`): HTTP Basic with the local password, or
  a personal API token (`gft_…`). A wrong password is a generic 401: the
  answer does not say whether that account uses LDAP or has no local
  password. Twenty failures from one address in ten minutes get 429. A
  session cookie from another site is still 403. The tree is the caller's
  vault plus what was shared with them. An administrator's role does not
  open another person's private documents, and a read-only share stays
  read-only. `Depth: infinity` is refused. Locks are per process.
- **Antivirus:** Compose always starts ClamAV. Scanning is on by default at
  `clamav` port `3310`. Administración → Seguridad (permission
  `security.manage`) can change the server, the port and the timeout, or
  turn scanning off. A finished upload is sent to clamd when scanning is on.
  So are Office saves, drawings, Git imports and form attachments. A
  detection deletes the object and returns 422. If clamd does not answer in
  time, the upload is refused (503) and the object is deleted. With scanning off,
  nothing is scanned. Note text is not sent to the scanner.
- **Audit:** successful sign-ins, administration changes, uploads, WebDAV
  changes and rejected files are stored in `audit_event`. Passwords and file
  bodies are not. Reading and exporting it needs `monitor.view`. Rows older
  than the retention setting are deleted.

## LaTeX service

- `latex` runs `pdflatex` (or `xelatex`) with `-no-shell-escape` and
  `openin_any`/`openout_any` set to paranoid, in a fresh folder per
  compilation, as a non-root user, with a time and size limit. `\write18` and
  `\input{/etc/passwd}` are refused with both engines (checked). LuaLaTeX is
  not offered, because its Lua code can read files outside those limits.
  BibTeX and biber only see the compilation folder's files and the
  container's own. It holds no Grafito data and has no published port; the
  app only sends it the source of a document the caller can read, one
  compilation per person at a time.

## Email accounts

- Account passwords and OAuth tokens are sealed with
  `GRAFITO_ENCRYPTION_KEY`, never sent back to the browser or logged; OAuth
  uses PKCE and a single-use state that the person's own session completes.
- Every mail query filters by the signed-in person; attachment links are
  signed for their owner and expire in ten minutes; administrators have no
  view of anyone's accounts or messages.
- IMAP hosts are resolved once and the connection goes to the checked
  address: loopback, link-local, cloud metadata and Grafito's own services
  are refused, private addresses only for hosts in `MAIL_TRUSTED_HOSTS`,
  ports 993 and 143 only, certificates always validated.
- HTML mail is cleaned and shown in a sandboxed iframe without scripts or the
  app's origin, with its own CSP; remote images wait for the person.
- Downloaded attachments pass ClamAV (a scanner failure refuses the file).
- MCP sees an account only when its owner allows it, and returns mail text
  as untrusted content. Details: [MAILBOX.md](MAILBOX.md).

## Known limits

- The CSP allows inline scripts, because of the server-rendered state
  (moving to nonces is in ROADMAP.md).
- The secrets volume isn't part of `./backups`. Copy it, or set your own
  secrets in `.env` (see docs/OPERATIONS.md).
- Collabora's admin console is blocked at the gateway, and its port only
  listens on the server. Still change `COLLABORA_ADMIN_PASSWORD`.
- Postgres, MinIO, Elasticsearch and Redis publish their ports on the server's
  loopback (127.0.0.1), with the example passwords unless `.env` sets others,
  and Elasticsearch and Redis without any. Anything running on the server can
  reach them (GRAF-04, GRAF-06, GRAF-07, GRAF-16). Set `POSTGRES_PASSWORD`,
  `S3_SECRET_KEY` and `COLLABORA_ADMIN_PASSWORD` in `.env` before the first
  start; changing them later needs the services' own procedure.
- A signed file link reaches anyone who holds it while the share lasts; one
  person removed from a share with several people keeps a link they already
  have for up to an hour.
- WebDAV locks live in one process. Several app instances do not share them,
  and a restart drops them.
- Failed browser sign-ins are rate-limited by Better Auth and are not written
  to `audit_event`. A failed WebDAV password is.
