import { useEffect, useRef, useState } from "react";
import { Copy, Check, KeyRound } from "lucide-react";
import { revealAccessNote } from "@/server/mail.functions";
import { intl, t } from "@/app/i18n";

/**
 * La nota secreta del correo de acceso: muestra una sola vez el usuario y la
 * contraseña temporal. El token va en el fragmento de la URL (`#`), que el
 * navegador no manda al servidor; se quita de la barra de direcciones en
 * cuanto se lee, y el servidor destruye la nota al abrirla. Lo que se ve solo
 * vive en esta página: al recargarla o cerrarla, ya no está.
 */

type Note = { login: string; password: string; expiresAt: number };

export function AccessNoteScreen() {
  const [state, setState] = useState<"loading" | "gone" | Note>("loading");
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    // Fuera de la barra y del historial: recargar no vuelve a pedir la nota.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState("gone");
      return;
    }
    void revealAccessNote({ data: { token } })
      .then((result) => setState(result.ok ? { login: result.login, password: result.password, expiresAt: result.expiresAt } : "gone"))
      .catch(() => setState("gone"));
  }, []);

  return (
    <main data-ui="auth" className="grid min-h-dvh place-items-center bg-bg px-4 py-8 text-fg">
      <div data-ui="auth-card" className="w-full max-w-sm border border-line bg-surface p-6">
        <p className="text-xs font-medium tracking-widest text-faint uppercase">{t("Grafito")}</p>
        {state === "loading" ? (
          <p className="mt-4 text-sm text-muted">{t("Cargando…")}</p>
        ) : state === "gone" ? (
          <>
            <h1 className="mt-2 font-serif text-3xl">{t("Esta nota ya no existe")}</h1>
            <p className="mt-4 text-sm text-muted">
              {t("Ya se abrió una vez o venció. Si no guardaste la contraseña, pide al administrador que te envíe un acceso nuevo.")}
            </p>
            <a href="/" className="mt-5 inline-flex h-11 items-center rounded-md border border-line px-4 text-sm hover:bg-elevated">
              {t("Ir a Grafito")}
            </a>
          </>
        ) : (
          <>
            <h1 className="mt-2 font-serif text-3xl">{t("Tu acceso")}</h1>
            <p className="mt-4 text-sm text-danger">
              {t("Esta nota se destruyó al abrirla: cópiala ahora. Si recargas o cierras la página, ya no podrás verla.")}
            </p>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-muted">{t("Usuario")}</dt>
                <dd className="mt-1 font-medium select-all">{state.login}</dd>
              </div>
              <div>
                <dt className="text-muted">{t("Contraseña temporal")}</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 rounded-md border border-line bg-inset px-3 py-2 font-mono text-base break-all select-all">
                    {state.password}
                  </code>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(state.password).then(() => setCopied(true))}
                    aria-label={t("Copiar")}
                    title={t("Copiar")}
                    className="grid size-10 shrink-0 place-items-center rounded-md border border-line hover:bg-elevated"
                  >
                    {copied ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}
                  </button>
                </dd>
              </div>
            </dl>
            {state.expiresAt ? (
              <p className="mt-4 text-sm text-muted">
                {t("Sirve para entrar una sola vez, hasta el {0}. Al entrar elegirás tu propia contraseña.", {
                  0: new Intl.DateTimeFormat(intl(), { dateStyle: "long", timeStyle: "short" }).format(new Date(state.expiresAt)),
                })}
              </p>
            ) : null}
            <a
              href="/login"
              target="_blank"
              rel="noopener"
              className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent text-sm font-medium text-accent-fg"
            >
              <KeyRound className="size-4" />
              {t("Entrar en Grafito")}
            </a>
          </>
        )}
      </div>
    </main>
  );
}
