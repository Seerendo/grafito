import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { TextAction } from "@/components/ui/TextAction";
import { createApiToken, myApiTokens, revokeApiToken } from "@/server/api-tokens.functions";

/**
 * Cuenta → API: tokens personales para usar la API REST (`/api/v1`) desde
 * scripts u otras herramientas. El token se muestra una sola vez.
 */

type Token = Extract<Awaited<ReturnType<typeof myApiTokens>>, { ok: true }>["tokens"][number];

export function ApiTokens() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = () =>
    myApiTokens()
      .then((result) => {
        if (!result.ok) setHidden(true);
        else setTokens(result.tokens);
      })
      .catch(() => setHidden(true));

  useEffect(() => {
    void load();
  }, []);

  if (hidden) return null;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <section>
      <p className="text-sm text-muted">
        Tokens personales para la API REST de tu bóveda. Úsalos con la cabecera{" "}
        <code className="text-xs">Authorization: Bearer gft_…</code>. Tienen tus mismos permisos.
      </p>
      <form
        className="mt-4 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void createApiToken({ data: { name } }).then(async (result) => {
            if (!result.ok) return;
            setFresh(result.token);
            setCopied(false);
            setName("");
            await load();
          });
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Nombre del token"
          placeholder="Nombre (p. ej. «Script de respaldo»)"
          className="h-10 min-w-0 flex-1 rounded-md border border-line bg-inset px-3 text-sm"
        />
        <button type="submit" className="h-10 rounded-md border border-line px-4 text-sm hover:bg-elevated">
          Crear token
        </button>
      </form>
      {fresh ? (
        <div className="mt-3 rounded-md border border-accent/50 bg-elevated p-3 text-sm">
          <p className="text-xs text-muted">Cópialo ahora: no se volverá a mostrar.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs">{fresh}</code>
            <button
              type="button"
              aria-label="Copiar token"
              onClick={() => {
                void navigator.clipboard?.writeText(fresh).then(() => setCopied(true));
              }}
              className="shrink-0 text-faint hover:text-fg"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
          <p className="mt-2 text-xs text-faint break-all">
            Prueba: <code>curl -H "Authorization: Bearer {fresh.slice(0, 10)}…" {origin}/api/v1/notes</code>
          </p>
        </div>
      ) : null}
      {tokens && tokens.length > 0 ? (
        <ul className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
          {tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-sm last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{token.name}</span>
                <span className="block text-xs text-muted">
                  {token.prefix}… · creado {new Date(token.createdAt).toLocaleDateString("es")}
                  {token.lastUsedAt ? ` · usado ${new Date(token.lastUsedAt).toLocaleString("es")}` : " · sin usar"}
                </span>
              </span>
              {confirming === token.id ? (
                <span className="flex items-center gap-3">
                  <span className="text-muted">¿Revocar?</span>
                  <TextAction
                    tone="danger"
                    onClick={() => {
                      setConfirming(null);
                      void revokeApiToken({ data: { id: token.id } }).then(load);
                    }}
                  >
                    Sí
                  </TextAction>
                  <TextAction onClick={() => setConfirming(null)}>No</TextAction>
                </span>
              ) : (
                <TextAction tone="danger" onClick={() => setConfirming(token.id)}>
                  Revocar
                </TextAction>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
