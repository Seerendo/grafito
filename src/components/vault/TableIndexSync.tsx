import { useEffect } from "react";
import { useTableIndex } from "@/app/table-index";
import { tableSearchTexts } from "@/server/table.functions";

/** Baja el texto indexado de las tablas para buscarlas desde la bóveda. */
export function TableIndexSync({ ownerId }: { ownerId: string | null }) {
  useEffect(() => {
    if (!ownerId) return;
    let alive = true;
    const load = () => {
      void tableSearchTexts()
        .then((result) => {
          if (alive && result.ok) useTableIndex.setState({ text: result.text });
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ownerId]);
  return null;
}
