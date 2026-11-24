import { intl } from "@/app/i18n";

/** How an account's sync state reads: every state named, none left as an endless spinner. */
export function statusLabel(account: {
  status: string;
  phase: string;
  statusDetail: string;
  lastSyncAt: number | null;
  adminPaused: boolean;
  syncEnabled: boolean;
}): { text: string; args?: Record<string, string>; tone: "ok" | "busy" | "danger" | "muted" } {
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(intl(), { hour: "2-digit", minute: "2-digit" });
  if (account.adminPaused) return { text: "Pausada por el administrador", tone: "muted" };
  switch (account.status) {
    case "auth_error":
      return { text: "Error de autenticación: revisa la contraseña", tone: "danger" };
    case "expired":
      return { text: "Autorización caducada: vuelve a autorizar", tone: "danger" };
    case "connection_error":
      return { text: "Error de conexión: se reintentará", tone: "danger" };
    case "error":
      return { text: "No se puede sincronizar", tone: "danger" };
    case "retrying": {
      const at = Number(account.statusDetail);
      return Number.isFinite(at) && at > 0
        ? { text: "Reintento programado a las {0}", args: { 0: time(at) }, tone: "danger" }
        : { text: "Reintento programado", tone: "danger" };
    }
    case "disconnected":
      return { text: "Desconectada", tone: "muted" };
    case "deleting":
      return { text: "Borrando la copia local…", tone: "busy" };
    case "paused":
      return { text: "Sincronización pausada", tone: "muted" };
    case "syncing":
      return account.phase === "initial"
        ? { text: "Sincronización inicial en curso", tone: "busy" }
        : { text: "Sincronizando cambios", tone: "busy" };
    case "ok":
      if (!account.syncEnabled) return { text: "Sincronización pausada", tone: "muted" };
      if (account.phase === "initial")
        return { text: "Sincronización inicial en curso", tone: "busy" };
      return account.lastSyncAt
        ? { text: "Sincronizada a las {0}", args: { 0: time(account.lastSyncAt) }, tone: "ok" }
        : { text: "Sincronizada", tone: "ok" };
    default:
      return { text: "Conectada, esperando la primera sincronización", tone: "busy" };
  }
}
