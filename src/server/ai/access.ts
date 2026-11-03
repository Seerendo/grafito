/**
 * Pure assistant visibility/write rules mirror the vault. Owned content requires role
 * permissions and respects read-only personas. Shared non-workspace content requires share
 * access. Workspace members see only granted folders unless they have full access.
 * Administrator status cannot bypass ownership or grants. Keep consistent with server/share.ts
 * and components/share/shared-tree.ts.
 */

export type ShareLevel = "admin" | "edit" | "read";
export type FolderLevel = "read" | "edit";
export type AiAccess = "lectura" | "edición";
export type AiSource = "propio" | "compartido" | "espacio";

export type ShareFacts = {
  access: ShareLevel;
  /** Organization workspace backed by an internal account. */
  workspace?: boolean;
  /**
   * Per-folder grants for users without full workspace edit/admin access. Missing keys denote
   * navigation-only folders.
   */
  folderAccess?: Readonly<Record<string, FolderLevel>>;
};

/** Resolved role capabilities plus the read-only persona flag. */
export type VaultCaps = {
  readOnly: boolean;
  editNotes: boolean;
  createNotes: boolean;
  managePortfolios: boolean;
};

export type AiDoc = {
  id: string;
  ownerId: string;
  /** null for the owned vault. */
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
  /** null denotes the personal root. */
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

/** Whether documents in this portfolio are readable; ordinary shares require only share access. */
export function canReadShare(facts: ShareFacts, portfolioId: string | null): boolean {
  if (facts.access === "admin" || facts.access === "edit") return true;
  if (facts.folderAccess) {
    const level = portfolioId ? facts.folderAccess[portfolioId] : undefined;
    return level === "read" || level === "edit";
  }
  if (facts.workspace) return false;
  return true;
}

/** Portfolio write/create access, excluding role and persona checks. */
export function canWriteShare(facts: ShareFacts, portfolioId: string | null): boolean {
  if (facts.access === "admin") return true;
  if (facts.folderAccess) return Boolean(portfolioId && facts.folderAccess[portfolioId] === "edit");
  if (facts.workspace && facts.access !== "edit") return false;
  return facts.access === "edit";
}

/** Owned-vault writes require the role capability and a writable persona. */
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

/** Strip wiki brackets and quotes that models often wrap around titles. */
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
 * Resolve exact IDs or titles, or unique title substrings. Preserve ambiguity for the model to
 * resolve. Missing IDs must not fall back to title search.
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
 * Resolve portfolios by ID, path or unique name. root and the localized personal-root name
 * denote the owned root.
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
 * Filter another vault's search results to documents the caller may open before exposing
 * anything to the model.
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

/** Owned note found by search but absent from the preloaded batch. */
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
 * Build the assistant's visible corpus, excluding ungranted workspace documents even if
 * supplied in a tree. Prefer writable access when the same document appears through multiple
 * shares.
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
