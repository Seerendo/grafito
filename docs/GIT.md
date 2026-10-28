# Git sync (GitHub, GitLab)

A portfolio, or the whole vault, can be kept in sync with a folder of a Git
repository on GitHub or GitLab, including GitHub Enterprise Server and a
self-hosted GitLab (a university's or a company's). It is optional and off by
default.

- Each portfolio is a folder, each note a `.md` file and each file goes as is.
- Changes made in Grafito are committed to the repository; changes pushed to
  the repository show up in Grafito, with their history.
- Grafito uses the provider's REST API. It needs no `git` program and never
  clones the repository.

## Turning it on

1. **Administración → Plugins**: turn on **Git**.
2. **Administración → Roles**: the **Git** permission (`git.sync`, under
   Portafolios) is given to the administrator only. Give it to other roles if
   they should use it.
3. Only github.com and gitlab.com are allowed out of the box. For any other
   server, the administrator lists it in `GRAFITO_GIT_HOSTS` (see
   [Self-hosted servers](#self-hosted-servers-an-institutional-gitlab)).

## Linking a portfolio

Right-click a portfolio, **Sincronizar con Git…** (or the branch button on the
portfolio's page). For the whole vault: right-click the root, **Sincronizar
todo con Git…**.

| Field | What to put |
| --- | --- |
| GitHub / GitLab | The provider. |
| Sentido | **En ambos sentidos** (both ways), **Solo subir a Git** (Grafito is the source: changes in the repository are overwritten by the next change in Grafito and nothing is brought back) or **Solo traer de Git** (the repository is the source: Grafito follows it and its own changes are not committed). |
| Servidor | Empty for github.com or gitlab.com. For your own server, its address, e.g. `https://gitlab.university.edu`. |
| Repositorio | `owner/repository` on GitHub, `group/project` on GitLab (subgroups too: `faculty/research/notes`). You can also paste the repository's address; the server is taken from it. |
| Rama | The branch, e.g. `main`. On GitHub it must exist (an empty repository needs a first commit, such as a README). On GitLab, an empty project gets it on the first sync. |
| Carpeta | The folder inside the repository. Empty is the root. |
| Token | An access token (see below). It is stored encrypted with `GRAFITO_ENCRYPTION_KEY`. Leave it empty when editing to keep the saved one. |

**Conectar** checks the repository, the branch and the token's access before
saving, then runs the first sync. **Sincronizar ahora** syncs at once.
**Desconectar** removes the link. Nothing is deleted in Grafito or in the
repository.

Changing the repository, branch or folder starts over: the first sync then
links files with the same path and content, and keeps both copies of anything
that differs.

### Tokens

| Provider | Token | Access it needs |
| --- | --- | --- |
| GitHub | Fine-grained personal access token, limited to the repository | **Contents: Read and write** (read-only for **Solo traer**) |
| GitHub | Classic personal access token | `repo` (or `public_repo` for a public repository) |
| GitLab | Project access token (recommended: it isn't tied to a person) | Scope `api`, role **Developer** or higher |
| GitLab | Personal or group access token | Scope `api` (`read_api` for **Solo traer**), role **Developer** or higher in the project |

GitLab deploy tokens don't work: they can't use the API. A protected branch
that Developers can't push to rejects the commits. Use another branch, or
allow the token's role to push.

## How a sync works

Every `GRAFITO_GIT_SYNC_MINUTES` (2 by default), and on **Sincronizar ahora**
or a webhook:

- If neither side changed since the last sync, it costs a single API call.
- **Changed only in Grafito:** one commit with all the changes, by the token's
  account, with the message `Grafito: N actualizado(s)…`. Renaming or moving
  a note is a delete plus a new path.
- **Changed only in the repository:** the note or file is updated in Grafito,
  as a new version in its history (author «Git»). New files become notes
  (`.md`, `.markdown`) or files, in portfolios named after their folders
  (created if missing).
- **Changed on both sides:** for a note, the changes are merged line by line,
  as when two people edit at once. If they touch the same lines, or for a
  file, Grafito's version is committed and the repository's is kept as a
  copy named «… (Git)».
- **Deleted on one side:** deleted on the other (in Grafito it goes to the
  trash), unless the other side changed it meanwhile; then it is kept.
- Files and folders whose name starts with a dot (`.github/`, `.gitignore`)
  are left alone.

Safeguards:

- If the branch disappears, or the folder is empty in the repository after it
  had files, the sync stops with an error and nothing is deleted in Grafito.
- Files larger than the upload limit (`GRAFITO_MAX_UPLOAD_MB`) are not brought
  into Grafito, and files over 90 MB are not committed (GitHub rejects files
  over 100 MB). They are counted as «omitido(s)» in the status.
- A repository renamed or moved on the provider gives an error instead of
  following the redirect. Update the link.

Limitations:

- A file renamed in the repository arrives as a deleted file plus a new one:
  the links and comments of the old one stay with it in the trash.
- Links between notes (`[[Title]]`) are plain text in the `.md` files, so they
  work on both sides. Links from a phrase of a PDF, comments and history live
  only in Grafito.
- On GitHub, a repository with too many files to list at once (about 100,000)
  is not supported. Link a subfolder's portfolio instead.

## Webhook (optional)

Without it, changes pushed to the repository arrive within
`GRAFITO_GIT_SYNC_MINUTES`. With it, they arrive right away. It needs the Git
server to reach Grafito's address.

The dialog shows **Webhook (opcional)** with its address
(`https://your-grafito/api/git/hook/<id>`) and secret.

- **GitHub:** repository → Settings → Webhooks → Add webhook. Payload URL:
  the address. Content type: `application/json`. Secret: the secret. Events:
  just the push event.
- **GitLab:** project → Settings → Webhooks. URL: the address. Secret token:
  the secret. Trigger: **Push events**.

## Self-hosted servers (an institutional GitLab)

A university's or company's GitLab, or GitHub Enterprise Server, works the
same way. A few things differ:

- **Allow the server.** Add its host to `GRAFITO_GIT_HOSTS` in `.env`,
  separated by commas, and restart (`docker compose up -d`):

  ```bash
  GRAFITO_GIT_HOSTS=gitlab.university.edu,git.lab.example.org:8443
  ```

  This list exists so that users can't make Grafito's server call arbitrary
  internal addresses. A host listed there may also use `http://`.
- **Server address.** Put it in **Servidor** (`https://gitlab.university.edu`),
  or paste the repository's address in **Repositorio**. GitLab under a path
  (`https://example.org/gitlab`) works too. GitHub Enterprise's API is taken
  from `/api/v3`.
- **A certificate from your own authority.** If the server's certificate is
  signed by the institution's CA, Grafito says the certificate isn't trusted.
  Mount the CA file (PEM) into the app container and point
  `NODE_EXTRA_CA_CERTS` at it, e.g. in a `docker-compose.override.yml`:

  ```yaml
  services:
    app:
      volumes:
        - ./certs/university-ca.pem:/app/certs/ca.pem:ro
      environment:
        NODE_EXTRA_CA_CERTS: /app/certs/ca.pem
  ```

- **Single sign-on.** Signing in to GitLab with the institution's SSO doesn't
  matter here: Grafito uses an access token. If personal tokens are disabled
  by policy, ask for a project access token.
- **Proxy.** If the server can only reach GitLab through an HTTP proxy, set
  `HTTPS_PROXY` (and `NO_PROXY` for internal hosts) together with
  `NODE_USE_ENV_PROXY=1` for the app container.
- **Webhooks to a private network.** A GitLab instance blocks webhooks to
  local or private addresses unless its administrator allows them (Admin →
  Settings → Network → Outbound requests). Without the webhook, the periodic
  sync is enough.
- **Firewall.** Grafito's server needs outbound HTTPS to the GitLab server.
  GitLab only needs to reach Grafito for the optional webhook.
