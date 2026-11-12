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

### The SDK

Grafito talks to Grafeno through its TypeScript SDK, `@grafenodb/client`. It
follows the SDK's latest release without anyone changing the code:
`package.json` asks for `latest`, and the app image and CI install the latest
published version at every build (the lockfile only fixes it for local
development). At runtime Grafito checks with `connect()` that the SDK and the
engine share an API version. If a future SDK no longer speaks the running
engine's API, the graph turns off and **Monitorización y logs → Grafo** says
why, with the SDK version in this build; the rest of Grafito keeps working.
The engine image itself stays on the release pinned in its Dockerfile.

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

## Communities and importance

Grafeno also analyses each vault (`src/server/graph/analysis.ts`):

- **Communities:** Louvain finds groups of documents linked more among
  themselves than with the rest. The twelve largest each get a colour in the
  graph, and the layout pulls each group together.
- **Importance:** PageRank scores each document by the links it receives and
  by how important their sources are. More important documents are drawn
  larger.

Links go through `Title` and `Ref` nodes, so PageRank on them would score
those nodes instead of the documents. Each analysis first writes direct
`linked` edges between documents (as resolved at that moment), then runs
Louvain and PageRank on them in Grafeno and stores the result on the nodes.
Grafito keeps the result in `graph_analysis` (migration 0039), so every app
instance shows the same one and a document written since keeps its colour
until the next analysis.

A vault is analysed again only when it changed and at most every 30 s,
during the background pass. On 8,000 documents and 25,000 links an analysis
takes about five seconds, most of it writing the `linked` edges. A share or
public link only receives the communities of the documents it shows.

**Comunidades** in the graph's toolbar turns the colours and sizes off or on
in that browser. **Administración → Monitorización y logs → Grafo** shows how
many vaults have been analysed; **Reconstruir** also analyses them again.
The 2D canvas used without WebGL2 draws every node alike.

## Orphans, bridges and related documents

- **Huérfanas** in the graph's toolbar highlights the notes and files with
  no link at all, in or out, and dims the rest. They are counted in the
  browser from the links it already has.
- **Puentes** highlights the documents that join groups most: Grafeno's
  betweenness (how many shortest paths between documents cross each one),
  computed in the background analysis with a sample of 1,024 starting
  documents so it stays fast on large vaults. The top 2 % are shown, from 3
  to 50.
- **Relacionadas**, in the details panel under **Menciones**, lists up to
  five documents worth linking to the open one: they share neighbours with
  it and are not linked to it yet (Grafeno's link prediction, Adamic-Adar,
  on the links of the last analysis). It comes with the mentions, in the
  same request, and in a share lists only what the reader can see. A vault
  not analysed yet has no suggestions.

Migration 0040 steps every stored analysis one revision back, so vaults
analysed before bridges existed are analysed again while their colours keep
showing.

## The assistant

The AI assistant has four read-only graph tools (`server/ai/tools/graph.ts`),
offered with the role's **Ver el grafo**:

| Tool              | Answers                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `graph_overview`  | The main communities with their most important documents, the top bridges and the orphans, of the Carpeta Personal or of a share |
| `graph_neighbors` | What is 1 to 3 links from a document, and for the direct ones who links to whom and how                                          |
| `graph_path`      | The shortest chain of links between two documents, each step with its kind and direction                                         |
| `graph_related`   | Documents worth linking to one (link prediction)                                                                                 |

They go through the assistant's corpus, so a document is found by id or title
and a share or workspace only shows what that person sees. Without the graph
they say it is unavailable, and the assistant falls back to search.

Grafeno also ships an MCP server, but it is not wired to the assistant: it
runs over stdin and opens the database file itself, which the running
`grafeno` service already holds; its tools write agent memories, while here
Grafeno is a copy rebuilt from Postgres; and it knows namespaces, not
Grafito's shares and workspace grants.

## Neighbourhood and paths

- **Entorno** shows the selected document and what is 1, 2 or 3 links away
  from it, following links in either direction.
- **Camino** finds the shortest chain of links from the selected document to
  another one, chosen by title or with Shift+click in the graph. The chain is
  listed above the graph (each step opens its document) and highlighted in
  the graph, with the rest dimmed. In **Entorno** the whole chain stays shown,
  however far it goes.

Both work in the browser on the links the graph already received from
Grafeno, so they answer at once and always match what is drawn. Asking the
engine instead would cost a round trip and, through the `Title` nodes, find
false shortcuts between notes that only link to the same title.

## Drawing

The browser draws the graph on the GPU with cosmos.gl (WebGL2,
`components/vault/GraphGpu.tsx`): the force layout and the drawing of points
and links run in shaders, so a graph of tens of thousands of documents stays
fluid. On an RTX 4060 laptop, 8,000 documents and 25,000 links draw at
60 frames per second once laid out, where the former 2D canvas drew 2.

- Notes are circles, files and tables squares, portfolios diamonds; a shared
  target has a fainter border. **referencia** links are dashed and **invoca**
  links dotted.
- Labels are drawn on a 2D canvas on top, only for the points cosmos.gl
  samples on screen, plus the selected document and its neighbours.
- While the layout settles the view follows the selected document and its
  neighbours, as before, until you zoom or pan.
- The library loads only when the graph opens. The first opening in a
  browser compiles its shaders (about a second); the browser keeps them.
- Without WebGL2 (some virtual machines or remote desktops), the former 2D
  canvas draws the graph.

## 3D

**3D** in the graph's toolbar shows the same graph in three dimensions
(`components/vault/Graph3d.tsx`, three.js). Drag to orbit, right-drag or
Shift+drag to pan, the wheel to zoom. The choice is remembered in that
browser.

- The force layout runs in a Web Worker (`graph3d.worker.ts`, d3-force-3d):
  documents repel, links pull, and the documents of one community pull
  towards their group's centre, so each community takes its own region of
  space.
- Notes are spheres, files and tables cubes, portfolios octahedra; each kind
  is one instanced mesh, and all links are one line geometry, so a large
  vault is a handful of draw calls. On an RTX 4060 laptop, 8,000 documents
  and 23,000 links draw at about 58 frames per second, settling in about 20 s
  without slowing the page.
- Communities, importance, the selected document, Camino, Huérfanas,
  Puentes, Entorno, clicks, Shift+click and the camera buttons work as in 2D.
- three.js and the worker load only when 3D is turned on. If a new version
  was deployed while the tab stayed open, the view says to reload the page.

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
