/**
 * Claves de permiso que usa la bóveda. Deben coincidir con `app_permission`
 * (migraciones); los roles se configuran en Administración → Roles.
 */
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

/** Permiso para borrar un documento según su tipo. */
export function deletePermission(kind: "markdown" | "file"): PermissionKey {
  return kind === "file" ? PERMISSION.filesDelete : PERMISSION.notesDelete;
}

/** Permiso para descargar o exportar un documento según su tipo. */
export function exportPermission(kind: "markdown" | "file"): PermissionKey {
  return kind === "file" ? PERMISSION.filesDownload : PERMISSION.notesExport;
}
