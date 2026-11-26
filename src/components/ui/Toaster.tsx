import { CheckCircle2, CircleAlert } from "lucide-react";
import { createPortal } from "react-dom";
import { t } from "@/app/i18n";
import { useToasts } from "@/app/toast";

/** Where toast() notices show: bottom right, fading in and out. */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  if (typeof document === "undefined" || toasts.length === 0) return null;
  return createPortal(
    <div
      aria-live="polite"
      data-ui="toaster"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex max-w-sm flex-col gap-2"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          role="status"
          data-ui="toast"
          className="grafito-toast flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-2xl"
        >
          {item.tone === "danger" ? (
            <CircleAlert className="size-4 shrink-0 text-danger" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-accent" />
          )}
          {t(item.text)}
        </div>
      ))}
    </div>,
    document.body,
  );
}
