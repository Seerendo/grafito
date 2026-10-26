import { CheckCircle2, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { TextAction } from "@/components/ui/TextAction";
import { aiAccountState, removeAiKey, saveAiKey } from "@/server/ai.functions";
import { t } from "@/app/i18n";

/**
 * Cuenta → IA: cada persona conecta los proveedores que el administrador
 * permite con su propia clave. La clave se prueba antes de guardarse y se
 * guarda cifrada; aquí solo se ven sus 4 últimos caracteres.
 */

type State = Extract<Awaited<ReturnType<typeof aiAccountState>>, { ok: true }>;
type Provider = State["providers"][number];

export function AiSettings() {
  const [state, setState] = useState<State | null>(null);
  const [hidden, setHidden] = useState(false);

  const load = () =>
    aiAccountState()
      .then((next) => {
        if (!next.ok) setHidden(true);
        else setState(next);
      })
      .catch(() => setHidden(true));

  useEffect(() => {
    void load();
  }, []);

  if (hidden) return null;
  return (
    <section>
      {!state ? <p className="mt-4 text-sm text-muted">{t("Cargando…")}</p> : null}
      {state && state.providers.length === 0 ? (
        <p className="mt-4 text-sm text-muted">{t("El administrador todavía no ha activado ningún proveedor de IA.")}</p>
      ) : null}
      {state && !state.encryption && state.providers.some((provider) => !provider.local) ? (
        <p className="mt-4 text-sm text-danger">
          {t("El servidor no tiene configurada la clave de cifrado: por ahora no se pueden guardar claves de la nube.")}
        </p>
      ) : null}
      {state ? (
        <ul className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
          {state.providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} canSave={state.encryption} reload={load} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ProviderRow({ provider, canSave, reload }: { provider: Provider; canSave: boolean; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(provider.credential?.baseUrl || provider.suggestedUrl);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = Boolean(provider.credential);

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await saveAiKey({ data: { provider: provider.id, apiKey: key, baseUrl: url } });
      if (!result.ok) {
        setNote({ ok: false, text: result.error });
        return;
      }
      setKey("");
      setEditing(false);
      setNote({ ok: true, text: t("Conectado. {0} modelos disponibles.", { 0: result.models.length }) });
      await reload();
    } catch {
      setNote({ ok: false, text: t("No se pudo guardar.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm">
            {provider.label}
            {connected ? <CheckCircle2 className="size-3.5 text-accent" aria-label={t("Conectado")} /> : null}
          </span>
          <span className="block truncate text-xs text-muted">
            {connected
              ? provider.local
                ? provider.credential?.baseUrl
                : t("Clave guardada {0}", { 0: provider.credential?.hint ?? "" })
              : t("Sin conectar")}
          </span>
        </span>
        {!editing ? (
          <span className="flex items-center gap-4">
            <TextAction onClick={() => setEditing(true)}>
              {provider.local ? (connected ? t("Cambiar dirección") : t("Conectar")) : connected ? t("Cambiar clave") : t("Añadir clave")}
            </TextAction>
            {connected ? (
              <TextAction
                tone="danger"
                onClick={() => {
                  void removeAiKey({ data: { provider: provider.id } }).then(reload);
                }}
              >
                {t("Quitar")}
              </TextAction>
            ) : null}
          </span>
        ) : null}
      </div>
      {editing ? (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {provider.local ? (
            <>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-label={t("Dirección de tu {0}", { 0: provider.label })}
                placeholder={provider.suggestedUrl}
                autoFocus
                spellCheck={false}
                className="h-10 w-full rounded-md border border-line bg-inset px-3 text-sm"
              />
            </>
          ) : null}
          <input
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-label={t("Clave de {0}", { 0: provider.label })}
            placeholder={provider.local ? t("Clave (opcional, si tu servidor la pide)") : provider.keyPlaceholder}
            autoComplete="off"
            autoFocus={!provider.local}
            spellCheck={false}
            className="h-10 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-sm"
          />
          <button
            type="submit"
            disabled={busy || (!canSave && Boolean(key))}
            className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-60"
          >
            {busy ? t("Probando…") : provider.local ? t("Probar y conectar") : t("Probar y guardar")}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setKey("");
            }}
            className="h-10 rounded-md px-3 text-sm text-muted hover:text-fg"
          >
            {t("Cancelar")}
          </button>
          {provider.local ? null : (
          <a
            href={provider.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-full items-center gap-1 text-xs text-muted hover:text-fg"
          >
            {t("¿Dónde consigo la clave?")}{" "}<ExternalLink className="size-3" />
          </a>
          )}
        </form>
      ) : null}
      {note ? <p className={`mt-2 text-xs ${note.ok ? "text-muted" : "text-danger"}`}>{note.text}</p> : null}
    </li>
  );
}
