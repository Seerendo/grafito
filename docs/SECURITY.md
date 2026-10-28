# Security

How Grafito defends itself, and what was checked by attacking a running copy
(October 2026, the test stack with two users).

## Report

| Area | Attack tried | Result |
| --- | --- | --- |
| **Signing secrets** | Forge a file link and an Office editor (WOPI) token with the example `BETTER_AUTH_SECRET` from `docker-compose.yml`, which was public in the repository | ❌→✅ **Fixed.** With nothing but that value, someone with no account downloaded another user's file and got an editor token with write access. They also needed the owner and document ids, which appear in links of anything shared with them. Now a missing or public example value is replaced by a random secret for each installation (`server/install-secrets.ts`). The same forgery then gets 403 and 401 |
| Stored XSS in notes | `<script>`, `<img onerror>`, `<svg onload>`, `javascript:` links (any case), payloads in `[[…]]`, code, tables, tags and the note title | ✅ nothing runs: the Markdown renderer emits no raw HTML, links only allow `http(s)` and `mailto`, and React escapes text |
| XSS in Mermaid | HTML labels with `onerror`, `click … "javascript:…"` | ✅ nothing runs (`securityLevel: "strict"`). An `<img>` in a label still loaded an outside image, a tracking pixel in a shared note: ❌→✅ images are now forbidden in labels |
| XSS in comments | HTML, `javascript:` links and `<script>` in a comment, seen by the owner and the guest | ✅ shown as plain text |
| Malicious uploads | An SVG with a script and a filename made of HTML; an HTML page; an HTML page renamed `.png` with type `image/png` | ✅ only images, video, audio and PDF are shown inline. Everything else is a download with `default-src 'none'` and, for HTML, SVG, XML and JS, `sandbox`. `nosniff` stops the fake PNG from being read as HTML |
| Access control (IDOR) | From another user's session: read, edit and delete a note through `/api/v1/notes/:id`; fetch a file without a signature or with a forged one; save a drawing that isn't theirs; reuse a valid share for a document outside it | ✅ 404, 403 or refused every time. `grantedDocOwner` and `editableTarget` check that the document belongs to the share |
| SQL injection | `' OR 1=1--`, `UNION SELECT …`, `%` and `_` in search | ✅ every query is parameterized (tagged templates or `$1`). `LIKE` patterns escape their wildcards, and Elasticsearch gets a `multi_match`, not query syntax |
| CSRF | A cross-site POST, as a browser sends it | ✅ 403 «Petición de otro sitio» (`Sec-Fetch-Site`). Cookies are `SameSite=Lax` too |
| Login brute force | 12 wrong passwords in a row | ✅ Better Auth answers 429 from the 4th |
| SSRF | Self-hosted AI addresses pointing to Grafito or its services | ✅ refused (`server/ai/local-url.ts`, with its tests) |
| Path traversal | Storage keys outside the user's prefix or with `..` | ✅ refused (`ownsKey`) |

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
  decrypts its AI keys.
- **Git sync** (optional, docs/GIT.md): access tokens are encrypted with
  `GRAFITO_ENCRYPTION_KEY`. The server only calls github.com, gitlab.com and
  the hosts the administrator lists in `GRAFITO_GIT_HOSTS`, and doesn't follow
  redirects, so a user can't use it to reach internal addresses. Webhooks are
  checked against the link's secret in constant time.
- **Headers:** a Content Security Policy on every page
  (`lib/security-headers.ts`), `X-Frame-Options: DENY`, `nosniff` and a strict
  referrer policy.

## Known limits

- The CSP allows inline scripts, because of the server-rendered state
  (moving to nonces is in ROADMAP.md).
- The secrets volume isn't part of `./backups`. Copy it, or set your own
  secrets in `.env` (see docs/OPERATIONS.md).
- Collabora's admin console is blocked at the gateway, and its port only
  listens on the server. Still change `COLLABORA_ADMIN_PASSWORD`.
