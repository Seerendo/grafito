/** Vault permission keys must match app_permission migrations. Roles are configured in administration. */
export const PERMISSION = {
  notesRead: "notes.read",
  notesCreate: "notes.create",
  notesEdit: "notes.edit",
  notesDelete: "notes.delete",
  notesExport: "notes.export",
  notesShare: "notes.share",
  filesUpload: "files.upload",
  filesDownload: "files.download",
  filesDelete: "files.delete",
  portfoliosManage: "portfolios.manage",
  gitSync: "git.sync",
  linksManage: "links.manage",
  graphView: "graph.view",
  aiUse: "ai.use",
  apiUse: "api.use",
} as const;

export type PermissionKey = (typeof PERMISSION)[keyof typeof PERMISSION];

/** Required deletion permission by document kind. */
export function deletePermission(kind: "markdown" | "file"): PermissionKey {
  return kind === "file" ? PERMISSION.filesDelete : PERMISSION.notesDelete;
}

/** Required download/export permission by document kind. */
export function exportPermission(kind: "markdown" | "file"): PermissionKey {
  return kind === "file" ? PERMISSION.filesDownload : PERMISSION.notesExport;
}
