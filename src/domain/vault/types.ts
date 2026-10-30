import type { TextAnchor } from "./anchor";

export type ViewMode = "edit" | "split" | "read";

export type ManualKind = "referencia" | "llama";

export type ManualLink = {
  targetId: string;
  kind: ManualKind;
  /** Desde una frase del archivo (un PDF), no desde todo el archivo. */
  anchor?: TextAnchor;
  /** El destino es un portafolio (por defecto, una nota o un archivo). */
  target?: "portfolio";
  /**
   * El destino es de otra persona y llega por lo compartido conmigo (este
   * elemento). Si pierdo el acceso o deja de estar compartido, el vínculo se
   * quita (`app/shared-links.ts`).
   */
  shareId?: string;
};

export type Portfolio = {
  id: string;
  name: string;
  parentId: string | null;
  /** Sus vínculos, como los de una nota. */
  links?: ManualLink[];
};

/**
 * Un archivo de la bóveda. Los bytes viven en el servidor (MinIO / S3 o
 * Postgres) bajo `key`; `dataUrl` solo lo traen los archivos antiguos o las
 * notas de ejemplo hasta que el servidor los guarda y les da clave.
 */
export type VaultFile = {
  name: string;
  mime: string;
  key?: string;
  size?: number;
  dataUrl?: string;
};

/**
 * La versión del servidor de la que parte una edición hecha en este navegador
 * y aún no subida. Con ella el servidor junta los cambios de otra persona
 * (`domain/vault/merge.ts`) en vez de que gane el último.
 */
export type SyncBase = { content: string; title: string; updatedAt: number };

export type Document = {
  id: string;
  title: string;
  portfolioId: string | null;
  kind: "markdown" | "file";
  content: string;
  file: VaultFile | null;
  links: ManualLink[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
  pinned: boolean;
  /** Solo en el navegador, mientras hay cambios sin subir (ver `SyncBase`). */
  base?: SyncBase;
};

export type GraphKind = "wiki" | ManualKind;

export type GraphEdge = {
  from: string;
  to: string;
  kind: GraphKind;
};

export type DialogState =
  | { type: "portfolio"; parentId: string | null }
  | { type: "delete-document"; id: string }
  /** Con `shareId`, uno de lo compartido conmigo (un espacio de trabajo): `name` es su nombre. */
  | { type: "delete-portfolio"; id: string; shareId?: string; name?: string }
  /** Varios elegidos con Ctrl o Mayús (`doc:<id>`, `port:<id>`). */
  | { type: "delete-many"; keys: string[] }
  /** Seguimiento de firmas de un documento (propio, o compartido con `shareId`). */
  | { type: "signatures"; docId: string; shareId?: string }
  | { type: "rename-document"; id: string }
  | { type: "rename-portfolio"; id: string }
  | { type: "move-conflict"; id: string; portfolioId: string | null; existingId: string }
  /** Con `shareId`, el origen es un documento de un espacio o de lo compartido: el vínculo se guarda en la bóveda del dueño. */
  | { type: "link"; sourceId: string; anchor?: TextAnchor; shareId?: string }
  | { type: "share"; kind: "document" | "portfolio"; id: string }
  /** `portfolioId` = "all": toda la bóveda. */
  | { type: "git"; portfolioId: string }
  /** Espacio y permisos de un portafolio propio o (con `shareId`) compartido conmigo. */
  | { type: "space"; portfolioId: string; shareId?: string }
  /** Nuevo portafolio dentro de uno compartido conmigo (en `parentId`). */
  | { type: "shared-portfolio"; shareId: string; parentId: string | null }
  | { type: "upload-error"; message: string; title?: string }
  | { type: "reset" }
  | null;

