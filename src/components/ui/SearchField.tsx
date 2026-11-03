import { Search, X } from "lucide-react";
import { t } from "@/app/i18n";

/** Compact search field with icon; does not autofocus when mounted. */
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
    <label
      data-field
      className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-line bg-inset px-3 text-sm"
    >
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
