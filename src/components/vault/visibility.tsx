import { Globe, Users } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMyShares, visibilityMap } from "@/app/shares";
import { useVault } from "@/app/vault/store";
import { t } from "@/app/i18n";

type Marks = ReadonlyMap<string, "shared" | "public">;

const VisibilityContext = createContext<Marks>(new Map());

/** Calcula una vez qué documentos y portafolios están compartidos o son públicos. */
export function VisibilityProvider({ children }: { children: ReactNode }) {
  const shares = useMyShares();
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const marks = useMemo(() => visibilityMap(shares, portfolios, documents), [shares, portfolios, documents]);
  return <VisibilityContext.Provider value={marks}>{children}</VisibilityContext.Provider>;
}

function useVisibility(id: string): "private" | "shared" | "public" {
  return useContext(VisibilityContext).get(id) ?? "private";
}

/** Icono discreto para lo compartido (👥) o público (🌐); nada si es privado. */
export function VisibilityMark({ id, className = "" }: { id: string; className?: string }) {
  const visibility = useVisibility(id);
  if (visibility === "private") return null;
  const Icon = visibility === "public" ? Globe : Users;
  const label = visibility === "public" ? t("Pública") : t("Compartida");
  return (
    <span title={label} aria-label={label} className={`inline-flex shrink-0 text-faint ${className}`}>
      <Icon className="size-3.5" />
    </span>
  );
}
