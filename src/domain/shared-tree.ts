import type { ManualLink } from "./vault/types.ts";
import type { ShareKind } from "./share.ts";

export type ShareAccess = "read" | "edit" | "admin";

export type PublishedDoc = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolioId: string | null;
  content: string;
  file: { name: string; mime: string; url: string; downloadUrl: string | null } | null;
  updatedBy: string;
  updatedAt: string;
  /** Manual links to shared documents or portfolios, used by the graph and details panel. */
  links?: ManualLink[];
  /**
   * When content is empty, fetch it on opening through sharedDocContent or publicDocContent.
   * Graphs and mentions only need wikiLinks.
   */
  lazy?: boolean;
  /** Referenced [[titles]] when document content is loaded lazily. */
  wikiLinks?: string[];
};

export type PublishedPortfolio = { id: string; name: string; parentId: string | null };

/** A shared item and the content visible to its reader. */
export type SharedTree = {
  share: {
    id: string;
    kind: ShareKind;
    title: string;
    ownerName: string;
    visibility: "shared" | "public";
    access: ShareAccess;
    /** Workspace members can see the workspace; grants control access to its contents. */
    workspace?: boolean;
    /**
     * Per-portfolio grants for members without workspace administration or full edit access. A
     * missing key marks a navigation-only folder.
     */
    folderAccess?: Record<string, "read" | "edit">;
    /** Fingerprint of folderAccess, included in the ETag so permission changes invalidate cached views. */
    view?: string;
    /** Public-link token used to request each document's content. */
    token?: string;
  };
  portfolios: PublishedPortfolio[];
  documents: PublishedDoc[];
};
