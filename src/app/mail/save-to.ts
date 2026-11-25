import { useEffect, useState } from "react";
import { intl } from "@/app/i18n";
import { mailArchiveTargets } from "@/server/mailbox.functions";

/**
 * Where files kept from a message go («Guardar en»): the Carpeta Personal or one of the person's
 * portfolios, remembered in this browser.
 */

const SAVE_KEY = "grafito.mail.save-to";

/** Where files kept from a message go, remembered in this browser (empty: Carpeta Personal). */
export function readSaveTo(): string {
  try {
    return window.localStorage.getItem(SAVE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeSaveTo(value: string): void {
  try {
    window.localStorage.setItem(SAVE_KEY, value);
  } catch {
    /* Only a convenience. */
  }
}

/** The person's portfolios with their paths, for «Guardar en». */
export function useSaveFolders(): { id: string; path: string }[] {
  const [folders, setFolders] = useState<{ id: string; path: string }[]>([]);
  useEffect(() => {
    void mailArchiveTargets()
      .then((answer) => {
        const byId = new Map(answer.portfolios.map((item) => [item.id, item]));
        const path = (id: string, seen = 0): string => {
          const item = byId.get(id);
          if (!item || seen > 20) return "";
          const parent = item.parentId ? path(item.parentId, seen + 1) : "";
          return parent ? `${parent} › ${item.name}` : item.name;
        };
        setFolders(
          answer.portfolios
            .map((item) => ({ id: item.id, path: path(item.id) }))
            .sort((a, b) => a.path.localeCompare(b.path, intl())),
        );
      })
      .catch(() => undefined);
  }, []);
  return folders;
}
