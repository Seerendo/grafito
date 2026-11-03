import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/** Native select with a custom arrow that preserves consistent field padding across platforms. */
export function Select({
  value,
  onChange,
  children,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full cursor-pointer appearance-none rounded-md border border-line bg-inset pr-10 pl-3 text-fg"
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-faint"
      />
    </div>
  );
}
