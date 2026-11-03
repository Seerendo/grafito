import type { TextAnchor } from "./anchor";

export type ViewMode = "edit" | "split" | "read";

export type ManualKind = "referencia" | "llama";

export type ManualLink = {
  targetId: string;
  kind: ManualKind;
  /** Link originates from a PDF phrase rather than the entire file. */
  anchor?: TextAnchor;
  /** Destination is a portfolio; defaults to a note or file. */
  target?: "portfolio";
  /**
   * Target belongs to another user's shared item. Remove the link after access loss or
   * unsharing; see app/shared-links.ts.
   */
  shareId?: string;
};

export type Portfolio = {
  id: string;
  name: string;
  parentId: string | null;
  /** Portfolio links, like note links. */
  links?: ManualLink[];
};

/**
 * Vault file bytes live in MinIO/S3 or Postgres under key. Legacy files and samples may retain
 * dataUrl until uploaded and assigned a key.
 */
export type VaultFile = {
  name: string;
  mime: string;
  key?: string;
  size?: number;
  dataUrl?: string;
};

/**
 * Server base for an unuploaded browser edit, enabling concurrent merging through
 * domain/vault/merge.ts instead of last-writer-wins.
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
  /** Browser-only metadata while local changes remain unuploaded; see SyncBase. */
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
  /** With shareId, identifies shared/workspace content and its name. */
  | { type: "delete-portfolio"; id: string; shareId?: string; name?: string }
  /** Ctrl/Shift multiselection keys: doc:<id> and port:<id>. */
  | { type: "delete-many"; keys: string[] }
  /** Signature tracking for owned or shared documents. */
  | { type: "signatures"; docId: string; shareId?: string }
  | { type: "rename-document"; id: string }
  | { type: "rename-portfolio"; id: string }
  | { type: "move-conflict"; id: string; portfolioId: string | null; existingId: string }
  /** With shareId, the source is a shared/workspace document and links persist in its owner's vault. */
  | { type: "link"; sourceId: string; anchor?: TextAnchor; shareId?: string }
  | { type: "share"; kind: "document" | "portfolio"; id: string }
  /** portfolioId=all denotes the entire vault. */
  | { type: "git"; portfolioId: string }
  /** Storage and permissions for an owned or shareId-scoped portfolio. */
  | { type: "space"; portfolioId: string; shareId?: string }
  /** Create a portfolio beneath a shared parentId. */
  | { type: "shared-portfolio"; shareId: string; parentId: string | null }
  | { type: "upload-error"; message: string; title?: string }
  | { type: "reset" }
  | null;
