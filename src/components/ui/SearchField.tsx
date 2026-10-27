import { Search, X } from "lucide-react";
import { t } from "@/app/i18n";

/**
 * Campo de búsqueda compacto con lupa. No toma el foco al aparecer: el cursor
 * de texto solo se ve cuando la persona hace clic para escribir.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-line bg-inset px-3 text-sm">
      <Search className="size-4 shrink-0 text-faint" aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent pl-1 text-fg outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("Limpiar búsqueda")}
          className="grid size-6 shrink-0 place-items-center rounded text-faint hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </label>
  );
}
