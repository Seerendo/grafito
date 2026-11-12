# Graph (Grafeno)

Grafito uses **Grafeno**, a graph engine, for the graph, the links between
documents and the mentions of a document. Postgres stays the source of truth
for notes, files and portfolios; Grafeno holds their links, resolved, so
neither the browser nor the server has to read every document to draw the
graph or to list who links to a note.

## Turn it on or off

With Docker Compose the `grafeno` service starts with everything else and
Grafito uses it; nothing else is needed. Change its token in `.env`:

```dotenv
GRAFENO_TOKEN=a-long-random-value
```

The graph is on when all of these hold:

- **Administración → Plugins → Grafo** is on.
- `GRAFENO_URL` is set (`http://grafeno:7810` in `docker-compose.yml`).
- Grafeno answers (checked every 10 s).
- The person's role has **Ver el grafo**.

Otherwise the graph button, **Ctrl+G**, the graph of a share or public link
and the **Menciones** section hide, and the rest of Grafito works as usual.
Links written in a note and the links panel of the open document do not
depend on Grafeno.

| Variable                   | Purpose                                               | Default                       |
| -------------------------- | ----------------------------------------------------- | ----------------------------- |
| `GRAFENO_URL`              | The engine's address. Empty turns the graph off       | `http://grafeno:7810`         |
| `GRAFENO_TOKEN`            | Token shared by Grafito and the engine                | `grafito-grafeno-cambia-esto` |
| `GRAFENO_NAMESPACE_PREFIX` | Prefix of each vault's namespace, to share one engine | `grafito-`                    |

Without Docker (`npm run dev`), run an engine on this machine and point
`GRAFENO_URL` at it, for example `GRAFENO_URL=http://127.0.0.1:7810`.

The image (`docker/grafeno/Dockerfile`) installs the official static Linux
build of a Grafeno release and checks it against the checksums written in the
Dockerfile. To move to another release, change `GRAFENO_VERSION` and both
checksums there (the `.sha256` files of that release).

## How vaults get there

- Each vault is one namespace in Grafeno (`grafito-<owner id>`).
- Every vault write takes a new revision (`vault_state`). A background pass
  (`src/server/graph/sync.ts`) writes the notes, files and portfolios whose
  revision is newer than what `graph_sync` says Grafeno holds, and records the
  new revision. A write shows in the graph about a second later.
- One replica copies at a time (`claimJob`), so several app instances can
  run.
- A vault Grafeno does not hold yet is copied whole. While that runs, its
  graph fills in by itself.
- If the engine loses its data (a new volume, a restore), the pass notices the
  missing namespaces within five minutes and copies those vaults again.
  Namespaces of deleted accounts are dropped.

Grafeno's data can always be rebuilt from Postgres, so it is not part of the
backups. **Administración → Monitorización y logs → Grafo** shows how many
vaults are up to date, whether the engine answers and its version, and
**Reconstruir** copies every vault again.

## The model

Grafito ids are not UUIDs, so each record has a UUID derived from its kind
and id, and keeps its own id in the `gid` property.

| Node        | What it is                                          |
| ----------- | --------------------------------------------------- |
| `Note`      | A Markdown note                                     |
| `File`      | A file or a table                                   |
| `Portfolio` | A portfolio                                         |
| `Title`     | A title as `[[links]]` name it (lower case)         |
| `Ref`       | A link target: a record of the vault, or of a share |

| Edge                  | From → to            | Meaning                                    |
| --------------------- | -------------------- | ------------------------------------------ |
| `titled`              | Note or File → Title | Its own title                              |
| `is`                  | any record → Ref     | Its own link target                        |
| `wiki`                | Note → Title         | A `[[link]]` in its text                   |
| `referencia`, `llama` | any record → Ref     | A manual link; `anchor` holds a PDF phrase |

Links point at a `Title` or a `Ref`, not at the target itself. A link to a
note written before that note exists, renamed or restored from the trash
resolves without rewriting the note that links to it:

```text
MATCH (a)-[:wiki]->(:Title)<-[:titled]-(b) RETURN a.gid, b.gid
```

A link to something in another person's share points at a `Ref` with the
`share` property; the browser resolves it with the shared trees it already
has, as before.

## What reads it

| Where                               | Server function             |
| ----------------------------------- | --------------------------- |
| Graph of the vault                  | `graphEdges`                |
| Graph of a share or workspace       | `graphEdges` with `shareId` |
| Graph and mentions of a public link | `publicGraph`               |
| Menciones of the open document      | `graphIncoming`             |

Access is checked before any read: a share answers only with links between
records the caller can see, and a workspace member sees only the folders
granted to them.
