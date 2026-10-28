import { intl, t } from "@/app/i18n";

/** «Ana está editando esta nota»: quién más la edita ahora (ver `app/presence.ts`). */
export function EditingNow({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const who = new Intl.ListFormat(intl(), { type: "conjunction" }).format(names);
  return (
    <p data-ui="editing-now" className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-xs text-muted">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
      <span className="min-w-0 truncate">
        {names.length === 1 ? t("{0} está editando esta nota.", { 0: who }) : t("{0} están editando esta nota.", { 0: who })}
      </span>
    </p>
  );
}
