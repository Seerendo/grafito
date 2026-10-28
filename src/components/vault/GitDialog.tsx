import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { gitLinkState, removeGitLink, saveGitLink, syncGitNow } from "@/server/git.functions";
import { syncVault } from "@/app/vault/sync";
import { useVault } from "@/app/vault/store";
import { intl, t } from "@/app/i18n";

type Provider = "github" | "gitlab";
type Direction = "both" | "push" | "pull";
type Link = {
  provider: Provider;
  baseUrl: string;
  repo: string;
  branch: string;
  folder: string;
  direction: Direction;
  lastError: string;
  lastSyncAt: number | null;
  lastSummary: string;
  hookPath: string;
  hookSecret: string;
};

const DEFAULT_URL: Record<Provider, string> = { github: "https://github.com", gitlab: "https://gitlab.com" };

/**
 * Enlace de un portafolio (o de toda la bóveda, `all`) con una carpeta de un
 * repositorio de GitHub o GitLab. Ver `server/git/sync.ts` y `docs/GIT.md`.
 */
export function GitDialog({ portfolioId, onClose }: { portfolioId: string; onClose: () => void }) {
  const name = useVault((state) =>
    portfolioId === "all" ? t("Toda la bóveda") : (state.portfolios.find((item) => item.id === portfolioId)?.name ?? ""),
  );
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(true);
  const [link, setLink] = useState<Link | null>(null);
  const [provider, setProvider] = useState<Provider>("github");
  const [baseUrl, setBaseUrl] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [folder, setFolder] = useState("");
  const [direction, setDirection] = useState<Direction>("both");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "sync" | "remove">("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState("");

  const fill = (next: Link | null) => {
    setLink(next);
    if (!next) return;
    setProvider(next.provider);
    setBaseUrl(next.baseUrl === DEFAULT_URL[next.provider] ? "" : next.baseUrl);
    setRepo(next.repo);
    setBranch(next.branch);
    setFolder(next.folder);
    setDirection(next.direction);
  };

  useEffect(() => {
    void gitLinkState({ data: { portfolioId } })
      .then((state) => {
        setAvailable(state.available);
        if (state.available) fill(state.link);
      })
      .catch(() => setError("No se pudo leer la configuración."))
      .finally(() => setLoaded(true));
  }, [portfolioId]);

  // Lo traído del repositorio baja a la bóveda del navegador.
  const pull = () => {
    const owner = useVault.getState().owner;
    if (owner) void syncVault(owner);
  };

  const save = async () => {
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const result = await saveGitLink({
        data: { portfolioId, provider, baseUrl: baseUrl.trim() || DEFAULT_URL[provider], repo, branch, folder, direction, token },
      });
      if (!result.ok) setError(result.error);
      else {
        setToken("");
        fill(result.link);
        setMessage(result.message);
        pull();
      }
    } catch {
      setError("No se pudo guardar.");
    } finally {
      setBusy("");
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    setError("");
    setMessage("");
    try {
      const result = await syncGitNow({ data: { portfolioId } });
      if (!result.ok) setError(result.error);
      else {
        fill(result.link);
        if (result.synced) setMessage(result.message);
        pull();
      }
    } catch {
      setError("No se pudo sincronizar.");
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError("");
    try {
      await removeGitLink({ data: { portfolioId } });
      setLink(null);
      setMessage("");
      setToken("");
    } catch {
      setError("No se pudo desconectar.");
    } finally {
      setBusy("");
    }
  };

  const copy = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied(""), 1500);
    });
  };

  const when = (ms: number) =>
    new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  const field = "h-11 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg placeholder:text-faint";
  const hookUrl = link && typeof window !== "undefined" ? `${window.location.origin}${link.hookPath}` : "";

  return (
    <Modal title={t("Sincronizar con Git")} onClose={onClose}>
      <p data-ui="git-target" className="-mt-1 mb-3 truncate text-sm text-muted">
        {name}
      </p>
      {!loaded ? (
        <p className="text-sm text-faint">{t("Cargando…")}</p>
      ) : !available ? (
        <p className="text-sm text-muted">{t("La sincronización con Git no está disponible.")}</p>
      ) : (
        <form
          className="space-y-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <Select value={provider} onChange={(value) => setProvider(value as Provider)}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </Select>
            <Select value={direction} onChange={(value) => setDirection(value as Direction)}>
              <option value="both">{t("En ambos sentidos")}</option>
              <option value="push">{t("Solo subir a Git")}</option>
              <option value="pull">{t("Solo traer de Git")}</option>
            </Select>
          </div>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            aria-label={t("Servidor")}
            placeholder={DEFAULT_URL[provider]}
            spellCheck={false}
            className={field}
          />
          <input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            aria-label={t("Repositorio")}
            placeholder={provider === "gitlab" ? t("grupo/proyecto o su dirección") : t("dueño/repositorio o su dirección")}
            spellCheck={false}
            required
            className={field}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              aria-label={t("Rama")}
              placeholder="main"
              spellCheck={false}
              required
              className={field}
            />
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              aria-label={t("Carpeta en el repositorio")}
              placeholder={t("Carpeta (raíz)")}
              spellCheck={false}
              className={field}
            />
          </div>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-label={t("Token de acceso")}
            placeholder={link ? t("Token guardado (vacío para mantenerlo)") : t("Token de acceso")}
            autoComplete="off"
            spellCheck={false}
            required={!link}
            className={field}
          />

          {link ? (
            <div data-ui="git-status" className="rounded-md bg-inset px-3 py-2 text-xs">
              {link.lastError ? (
                <p className="text-danger">{t(link.lastError)}</p>
              ) : (
                <p className="text-muted">
                  {link.lastSyncAt ? `${when(link.lastSyncAt)} · ` : ""}
                  {link.lastSummary ? t(link.lastSummary) : t("Pendiente")}
                </p>
              )}
            </div>
          ) : null}
          {message && !error && message !== link?.lastSummary ? <p className="text-xs text-muted">{t(message)}</p> : null}
          {error ? <p className="text-sm text-danger">{t(error)}</p> : null}

          {link ? (
            <details className="rounded-md border border-line px-3 py-2 text-xs">
              <summary className="cursor-pointer text-muted">{t("Webhook (opcional)")}</summary>
              <div className="mt-2 space-y-1.5">
                {[
                  { key: "url", label: t("Dirección"), value: hookUrl },
                  { key: "secret", label: t("Secreto"), value: link.hookSecret },
                ].map((item) => (
                  <div key={item.key} className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-faint">{item.label}</span>
                    <code className="min-w-0 flex-1 truncate rounded bg-inset px-2 py-1 text-fg">{item.value}</code>
                    <button
                      type="button"
                      aria-label={t("Copiar")}
                      title={t("Copiar")}
                      onClick={() => copy(item.key, item.value)}
                      className="grid size-7 shrink-0 place-items-center rounded text-faint hover:bg-elevated hover:text-fg"
                    >
                      {copied === item.key ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </button>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {link ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void remove()}
                className="mr-auto h-11 rounded-md px-3 text-sm text-danger hover:bg-elevated disabled:opacity-60"
              >
                {busy === "remove" ? t("Desconectando…") : t("Desconectar")}
              </button>
            ) : null}
            {link ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void syncNow()}
                className="h-11 rounded-md border border-line px-3 text-sm text-fg hover:bg-elevated disabled:opacity-60"
              >
                {busy === "sync" ? t("Sincronizando…") : t("Sincronizar ahora")}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={Boolean(busy)}
              className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
            >
              {busy === "save" ? t("Comprobando…") : link ? t("Guardar") : t("Conectar")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
