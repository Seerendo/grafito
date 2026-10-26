import { Link } from "@tanstack/react-router";
import { FileText, FolderOpen } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Mark } from "@/components/brand/Mark";
import { AppFrame } from "@/components/chrome/AppFrame";
import { openPublic, openShared, sharedWithMe } from "@/server/share.functions";
import type { SharedTree } from "@/server/share";
import { SharedViewer } from "./SharedViewer";
import { t } from "@/app/i18n";

type Inbox = Awaited<ReturnType<typeof sharedWithMe>>;

/** `/compartidos`: lo que otros usuarios compartieron conmigo. */
export function SharedWithMeScreen() {
  const [items, setItems] = useState<Inbox | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void sharedWithMe()
      .then(setItems)
      .catch(() => setError(t("No se pudo leer lo compartido.")));
  }, []);

  return (
    <AppFrame>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 py-8">
          <h1 className="font-serif text-3xl tracking-tight">{t("Compartidos conmigo")}</h1>
          {error ? <p className="mt-6 text-sm text-danger">{t(error)}</p> : null}
          {!items && !error ? <p className="mt-6 text-sm text-muted">{t("Cargando…")}</p> : null}
          {items && items.length === 0 ? (
            <p className="mt-6 text-sm text-muted">{t("Nadie ha compartido nada contigo todavía.")}</p>
          ) : null}
          {items && items.length > 0 ? (
            <ul className="mt-6 overflow-hidden rounded-lg border border-line bg-surface">
              {items.map((item) => {
                const Icon = item.kind === "portfolio" ? FolderOpen : FileText;
                return (
                  <li key={item.id} className="border-b border-line last:border-b-0">
                    <Link
                      to="/compartidos/$shareId"
                      params={{ shareId: item.id }}
                      className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-elevated"
                    >
                      <Icon className="size-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{item.title || t("Sin título")}</span>
                        <span className="block text-xs text-muted">
                          {item.kind === "portfolio" ? t("Portafolio") : t("Nota")}{" "}{t("· de")}{" "}{item.ownerName}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </AppFrame>
  );
}

/** `/compartidos/$shareId`: un elemento compartido conmigo. */
export function SharedItemScreen({ shareId }: { shareId: string }) {
  const tree = useTree(() => openShared({ data: { shareId } }), shareId);
  return (
    <AppFrame>
      <TreeState tree={tree} missing={t("No existe o ya no está compartido contigo.")} />
    </AppFrame>
  );
}

/** `/p/$token`: vista pública por enlace, sin sesión. */
export function PublicShareScreen({ token }: { token: string }) {
  const tree = useTree(() => openPublic({ data: { token } }), token);
  const title = tree && tree !== "loading" && tree !== "error" ? tree.share.title : "";
  useEffect(() => {
    if (title) document.title = t("{0} · Grafito", { 0: title });
  }, [title]);
  return (
    <div data-ui="shell" className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <header data-ui="topbar" className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span className="flex items-center gap-0.5">
          <Mark />
          <span className="select-none font-semibold tracking-tight">{t("Grafito")}</span>
        </span>
        {title ? <span className="min-w-0 truncate text-sm text-muted">· {title}</span> : null}
        <Link to="/" className="ml-auto text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
          {t("Entrar")}
        </Link>
      </header>
      <TreeState tree={tree} missing={t("Este enlace no existe o dejó de ser público.")} />
    </div>
  );
}

type TreeLoad = SharedTree | null | "loading" | "error";

function useTree(load: () => Promise<SharedTree | null>, key: string): TreeLoad {
  const [tree, setTree] = useState<TreeLoad>("loading");
  useEffect(() => {
    let cancelled = false;
    setTree("loading");
    void load()
      .then((next) => {
        if (!cancelled) setTree(next);
      })
      .catch(() => {
        if (!cancelled) setTree("error");
      });
    return () => {
      cancelled = true;
    };
    // `load` cambia en cada render; la clave identifica qué abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return tree;
}

function TreeState({ tree, missing }: { tree: TreeLoad; missing: string }) {
  if (tree === "loading") return <Centered>{t("Cargando…")}</Centered>;
  if (tree === "error") return <Centered>{t("No se pudo abrir.")}</Centered>;
  if (!tree) return <Centered>{missing}</Centered>;
  return <SharedViewer tree={tree} />;
}

function Centered({ children }: { children: ReactNode }) {
  return <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted">{children}</p>;
}
