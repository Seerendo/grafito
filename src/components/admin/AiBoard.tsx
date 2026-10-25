import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { aiAdminState, saveAiPolicy } from "@/server/ai.functions";

/**
 * Administración → IA: qué proveedores pueden usar las personas. Cada una los
 * conecta en Cuenta → IA con su propia clave o, en Ollama y LM Studio, con la
 * dirección de su propia instancia.
 */

type State = Extract<Awaited<ReturnType<typeof aiAdminState>>, { ok: true }>;
type Provider = State["providers"][number];

export function AiBoard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void aiAdminState()
      .then((next) => {
        if (!next.ok) setError("Sin permiso para configurar la IA.");
        else setState(next);
      })
      .catch(() => setError("No se pudo leer la configuración."));
  }, []);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!state) return <p className="text-sm text-muted">Cargando…</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Activa los proveedores que se pueden usar. Cada persona conecta el suyo en Cuenta → IA: con su propia clave, o
        con la dirección de su propia instancia en Ollama y LM Studio.
      </p>
      {!state.encryption ? (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          Falta <code>GRAFITO_ENCRYPTION_KEY</code> (32 caracteres o más) en el servidor: nadie podrá guardar claves hasta
          que la definas.
        </p>
      ) : null}
      <ul className="overflow-hidden rounded-lg border border-line bg-surface">
        {state.providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} />
        ))}
      </ul>
    </div>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <li className="flex items-center gap-4 border-b border-line px-4 py-1 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-sm">{provider.label}</span>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
      <Switch
        checked={enabled}
        ariaLabel={`Permitir ${provider.label}`}
        disabled={busy}
        onChange={(next) => {
          setBusy(true);
          setError("");
          void saveAiPolicy({ data: { id: provider.id, enabled: next } })
            .then((result) => {
              if (result.ok) setEnabled(next);
              else setError(result.error);
            })
            .catch(() => setError("No se pudo guardar."))
            .finally(() => setBusy(false));
        }}
      />
    </li>
  );
}
