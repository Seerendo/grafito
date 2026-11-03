/**
 * Qué puede ver y cambiar el asistente. Puro (sin base de datos): las mismas
 * reglas que la bóveda, para poder probarlas solas.
 *
 * - Lo propio se lee con `notes.read` y se cambia con `notes.edit` (y el
 *   perfil de solo lectura lo impide). Un administrador no salta la bóveda
 *   de otra persona: aquí no entra nada que no sea suyo o que le hayan dado.
 * - Un elemento compartido que no es un espacio se lee entero; se cambia
 *   solo si el acceso es de edición o de administración.
 * - En un espacio, quien no lo tiene entero solo ve las carpetas concedidas.
 *   Lectura o edición sale de esa concesión, no del rol. Coincide con
 *   `mayReadInPortfolio` / `mayWriteInPortfolio` (`server/share.ts`) y con
 *   `canEditSharedPortfolio` (`components/share/shared-tree.ts`).
 */

export type ShareLevel = "admin" | "edit" | "read";
export type FolderLevel = "read" | "edit";
export type AiAccess = "lectura" | "edición";
export type AiSource = "propio" | "compartido" | "espacio";

export type ShareFacts = {
  access: ShareLevel;
  /** Espacio de trabajo (la cuenta interna compartida con una organización). */
  workspace?: boolean;
  /**
   * Concesión por carpeta. La trae el árbol cuando la persona no administra
   * el espacio ni lo tiene entero en edición. Sin la clave, la carpeta es
   * solo el camino.
   */
  folderAccess?: Readonly<Record<string, FolderLevel>>;
};

/** Permisos del rol ya resueltos, más el perfil de solo lectura. */
export type VaultCaps = {
  readOnly: boolean;
  editNotes: boolean;
  createNotes: boolean;
  managePortfolios: boolean;
};

export type AiDoc = {
  id: string;
  ownerId: string;
  /** `null` en la bóveda propia. */
  shareId: string | null;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  place: string;
  source: AiSource;
  access: AiAccess;
  fileName: string | null;
};

export type AiFolder = {
  /** `null` es la Carpeta Personal. */
  id: string | null;
  ownerId: string;
  shareId: string | null;
  name: string;
  parentId: string | null;
  path: string;
  place: string;
  source: AiSource;
  access: AiAccess;
};

export type Assembled = { docs: AiDoc[]; folders: AiFolder[] };

type Node = { id: string; name: string; parentId: string | null };
type DocInput = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  fileName: string | null;
};

export type ShareSlice = {
  shareId: string;
  ownerId: string;
  ownerName: string;
  title: string;
  access: ShareLevel;
  workspace: boolean;
  folderAccess?: Readonly<Record<string, FolderLevel>>;
  portfolios: Node[];
  documents: DocInput[];
};

const CHOICES = 8;

/** Si se puede leer un documento de ese portafolio. Fuera de un espacio, el elemento basta. */
export function canReadShare(facts: ShareFacts, portfolioId: string | null): boolean {
  if (facts.access === "admin" || facts.access === "edit") return true;
  if (facts.folderAccess) {
    const level = portfolioId ? facts.folderAccess[portfolioId] : undefined;
    return level === "read" || level === "edit";
  }
  if (facts.workspace) return false;
  return true;
}

/** Si se puede crear o cambiar en ese portafolio. No mira el rol ni el perfil. */
export function canWriteShare(facts: ShareFacts, portfolioId: string | null): boolean {
  if (facts.access === "admin") return true;
  if (facts.folderAccess) return Boolean(portfolioId && facts.folderAccess[portfolioId] === "edit");
  if (facts.workspace && facts.access !== "edit") return false;
  return facts.access === "edit";
}

/** Escritura en la bóveda propia: el rol lo permite y el perfil no es de solo lectura. */
export function canWriteOwn(roleCanEdit: boolean, readOnlyProfile: boolean): boolean {
  return roleCanEdit && !readOnlyProfile;
}

export function writeRefusal(doc: Pick<AiDoc, "title" | "place" | "access">): string | null {
  if (doc.access === "edición") return null;
  return `Puedes ver «${doc.title}» (${doc.place}) pero no editarlo.`;
}

export function createRefusal(folder: Pick<AiFolder, "place" | "access">): string | null {
  if (folder.access === "edición") return null;
  return `Puedes ver «${folder.place}» pero no crear ni modificar nada ahí.`;
}

/** Quita `[[ ]]` y comillas que el modelo suele dejar alrededor de un título. */
export function cleanRef(ref: string): string {
  return ref
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/^[«"']|[»"']$/g, "")
    .trim();
}

export type DocMatch =
  { status: "one"; doc: AiDoc } | { status: "choices"; docs: AiDoc[] } | { status: "none" };

/**
 * Un documento por id exacto, por título exacto o, si solo uno lo contiene,
 * por parte del título. Varios resultados no se colapsan al primero: el
 * modelo tiene que elegir. Un id que no está no se busca en otros títulos.
 */
export function matchDocs(docs: readonly AiDoc[], ref: string): DocMatch {
  const key = cleanRef(ref);
  if (!key) return { status: "none" };
  const byId = docs.filter((doc) => doc.id === key);
  if (byId.length === 1) return { status: "one", doc: byId[0]! };
  if (byId.length > 1) return { status: "choices", docs: byId.slice(0, CHOICES) };
  const lower = key.toLowerCase();
  const exact = docs.filter((doc) => doc.title.toLowerCase() === lower);
  if (exact.length === 1) return { status: "one", doc: exact[0]! };
  if (exact.length > 1) return { status: "choices", docs: exact.slice(0, CHOICES) };
  const partial = docs.filter((doc) => doc.title.toLowerCase().includes(lower));
  if (partial.length === 1) return { status: "one", doc: partial[0]! };
  if (partial.length > 1) return { status: "choices", docs: partial.slice(0, CHOICES) };
  return { status: "none" };
}

const ROOT_WORDS = new Set(["root", "null", "raíz", "raiz", "carpeta personal", "personal"]);

export type FolderMatch =
  | { status: "one"; folder: AiFolder }
  | { status: "choices"; folders: AiFolder[] }
  | { status: "none" }
  | { status: "missing" };

/**
 * Un portafolio por id, por ruta («Proyectos › Atlas» o el sitio completo) o
 * por nombre si no se repite. «root» y «Carpeta Personal» son la raíz propia.
 */
export function matchFolders(folders: readonly AiFolder[], ref: string): FolderMatch {
  const key = cleanRef(ref);
  if (!key) return { status: "missing" };
  const byId = folders.filter((folder) => folder.id === key);
  if (byId.length === 1) return { status: "one", folder: byId[0]! };
  if (byId.length > 1) return { status: "choices", folders: byId.slice(0, CHOICES) };
  const lower = key.toLowerCase();
  const normalized = lower.replace(/\s*[›>/]\s*/g, " › ");
  const byPath = folders.filter(
    (folder) =>
      folder.path.toLowerCase() === normalized || folder.place.toLowerCase() === normalized,
  );
  if (byPath.length === 1) return { status: "one", folder: byPath[0]! };
  if (byPath.length > 1) return { status: "choices", folders: byPath.slice(0, CHOICES) };
  if (ROOT_WORDS.has(lower)) {
    const root = folders.find((folder) => folder.shareId === null && folder.id === null);
    return root ? { status: "one", folder: root } : { status: "none" };
  }
  const byName = folders.filter((folder) => folder.name.toLowerCase() === lower);
  if (byName.length === 1) return { status: "one", folder: byName[0]! };
  if (byName.length > 1) return { status: "choices", folders: byName.slice(0, CHOICES) };
  return { status: "none" };
}

/**
 * De una búsqueda en la bóveda de alguien, solo los documentos que esta
 * persona puede abrir. Lo demás no sale del servidor hacia el modelo.
 */
export function takeVisible(
  hits: readonly { id: string }[],
  visible: readonly AiDoc[],
  ownerId: string,
): AiDoc[] {
  const allowed = new Map<string, AiDoc>();
  for (const doc of visible) {
    if (doc.ownerId === ownerId && !allowed.has(doc.id)) allowed.set(doc.id, doc);
  }
  const out: AiDoc[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const doc = allowed.get(hit.id);
    if (!doc || seen.has(doc.id)) continue;
    seen.add(doc.id);
    out.push(doc);
  }
  return out;
}

function folderPath(nodes: readonly Node[], id: string | null): string {
  if (!id) return "";
  const names: string[] = [];
  let current = nodes.find((node) => node.id === id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? nodes.find((node) => node.id === current!.parentId) : undefined;
  }
  return names.join(" › ");
}

function factsOf(share: ShareSlice): ShareFacts {
  return {
    access: share.access,
    workspace: share.workspace,
    ...(share.folderAccess ? { folderAccess: share.folderAccess } : {}),
  };
}

function sourceOf(share: ShareSlice | null): AiSource {
  if (!share) return "propio";
  return share.workspace ? "espacio" : "compartido";
}

function shareLabel(share: ShareSlice): string {
  return share.workspace ? `Espacio · ${share.title}` : `Compartido · ${share.ownerName}`;
}

/** Una nota propia que no venía en el lote cargado (la búsqueda la encontró). */
export function describeOwnDoc(
  userId: string,
  caps: VaultCaps,
  folders: readonly AiFolder[],
  doc: DocInput,
): AiDoc {
  const path = doc.portfolioId
    ? (folders.find((folder) => folder.shareId === null && folder.id === doc.portfolioId)?.path ??
      "")
    : "";
  return {
    id: doc.id,
    ownerId: userId,
    shareId: null,
    title: doc.title,
    kind: doc.kind,
    portfolioId: doc.portfolioId,
    place: path || "Carpeta Personal",
    source: "propio",
    access: canWriteOwn(caps.editNotes, caps.readOnly) ? "edición" : "lectura",
    fileName: doc.fileName,
  };
}

function ownFolderAccess(caps: VaultCaps): AiAccess {
  if (caps.readOnly || !(caps.createNotes || caps.managePortfolios)) return "lectura";
  return "edición";
}

function sharedFolderAccess(
  caps: VaultCaps,
  facts: ShareFacts,
  portfolioId: string | null,
): AiAccess {
  if (caps.readOnly || !(caps.createNotes || caps.managePortfolios)) return "lectura";
  return canWriteShare(facts, portfolioId) ? "edición" : "lectura";
}

function sharedDocAccess(caps: VaultCaps, facts: ShareFacts, portfolioId: string | null): AiAccess {
  if (!canWriteOwn(caps.editNotes, caps.readOnly)) return "lectura";
  return canWriteShare(facts, portfolioId) ? "edición" : "lectura";
}

/**
 * Arma lo que el asistente puede nombrar. Un documento de un espacio que no
 * está concedido no entra, aunque el árbol lo trajera. Si el mismo documento
 * llega por dos elementos, se queda el que permite editar.
 */
export function assembleView(input: {
  userId: string;
  caps: VaultCaps;
  ownPortfolios: Node[];
  ownDocs: DocInput[];
  shares: ShareSlice[];
}): Assembled {
  const folders: AiFolder[] = [
    {
      id: null,
      ownerId: input.userId,
      shareId: null,
      name: "Carpeta Personal",
      parentId: null,
      path: "Carpeta Personal",
      place: "Carpeta Personal",
      source: "propio",
      access: ownFolderAccess(input.caps),
    },
  ];
  for (const portfolio of input.ownPortfolios) {
    const path = folderPath(input.ownPortfolios, portfolio.id);
    folders.push({
      id: portfolio.id,
      ownerId: input.userId,
      shareId: null,
      name: portfolio.name,
      parentId: portfolio.parentId,
      path,
      place: path,
      source: "propio",
      access: ownFolderAccess(input.caps),
    });
  }

  const docs = new Map<string, AiDoc>();
  for (const doc of input.ownDocs) {
    docs.set(`${input.userId}:${doc.id}`, describeOwnDoc(input.userId, input.caps, folders, doc));
  }

  for (const share of input.shares) {
    const facts = factsOf(share);
    const source = sourceOf(share);
    const label = shareLabel(share);
    for (const portfolio of share.portfolios) {
      const path = folderPath(share.portfolios, portfolio.id);
      folders.push({
        id: portfolio.id,
        ownerId: share.ownerId,
        shareId: share.shareId,
        name: portfolio.name,
        parentId: portfolio.parentId,
        path,
        place: path ? `${label} · ${path}` : label,
        source,
        access: sharedFolderAccess(input.caps, facts, portfolio.id),
      });
    }
    for (const doc of share.documents) {
      if (!canReadShare(facts, doc.portfolioId)) continue;
      const path = folderPath(share.portfolios, doc.portfolioId);
      const next: AiDoc = {
        id: doc.id,
        ownerId: share.ownerId,
        shareId: share.shareId,
        title: doc.title,
        kind: doc.kind,
        portfolioId: doc.portfolioId,
        place: path ? `${label} · ${path}` : label,
        source,
        access: sharedDocAccess(input.caps, facts, doc.portfolioId),
        fileName: doc.fileName,
      };
      const key = `${next.ownerId}:${next.id}`;
      const prev = docs.get(key);
      if (!prev || (prev.access !== "edición" && next.access === "edición")) docs.set(key, next);
    }
  }

  return { docs: [...docs.values()], folders };
}
