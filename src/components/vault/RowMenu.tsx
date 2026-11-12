import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useVault } from "@/app/vault/store";
import { ingestExternalFiles } from "./ingest-files";
import { RowContextMenu, type RowMenu, type RowMenuTarget } from "./RowContextMenu";

export type { RowMenuTarget };

/**
 * Vault context menu shared by directory and workspace pages. Return openMenu for row handlers
 * and the rendered menu element.
 */
export function useRowMenu(
  onOpenNote: (id: string) => void,
  onSelect?: (target: { kind: "document" | "portfolio"; id: string }) => void,
) {
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTo = useRef<string | null>(null);

  const openMenu = (event: MouseEvent, target: RowMenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ ...target, x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const element = (
    <>
      <input
        ref={uploadRef}
        type="file"
        tabIndex={-1}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void ingestExternalFiles(files, uploadTo.current);
        }}
      />
      {menu ? (
        <RowContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onOpenNote={onOpenNote}
          onSelect={onSelect}
          onUpload={(portfolioId, folder) => {
            uploadTo.current = portfolioId;
            useVault.getState().setSelectedPortfolio(portfolioId);
            setMenu(null);
            const input = uploadRef.current;
            if (!input) return;
            if (folder) {
              input.setAttribute("webkitdirectory", "");
              input.setAttribute("directory", "");
            } else {
              input.removeAttribute("webkitdirectory");
              input.removeAttribute("directory");
            }
            input.click();
          }}
        />
      ) : null}
    </>
  );

  return { openMenu, closeMenu: () => setMenu(null), element };
}
