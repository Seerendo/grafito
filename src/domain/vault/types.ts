export type ViewMode = "edit" | "split" | "read";

export type ManualKind = "referencia" | "llama";

export type ManualLink = {
  targetId: string;
  kind: ManualKind;
};

export type Portfolio = {
  id: string;
  name: string;
  parentId: string | null;
};

export type VaultFile = {
  name: string;
  mime: string;
  dataUrl: string;
};

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
  | { type: "delete-portfolio"; id: string }
  | { type: "rename-document"; id: string }
  | { type: "rename-portfolio"; id: string }
  | { type: "move-conflict"; id: string; portfolioId: string | null; existingId: string }
  | { type: "link"; sourceId: string }
  | { type: "share"; kind: "document" | "portfolio"; id: string }
  | { type: "upload-error"; message: string }
  | { type: "reset" }
  | null;

export const MAX_UPLOAD_BYTES = 700_000;
