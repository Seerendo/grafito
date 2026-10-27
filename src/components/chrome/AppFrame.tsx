import type { ReactNode } from "react";
import { releaseOnBlankFrame } from "@/app/blank-click";
import { ChromeHeader } from "./ChromeHeader";

/** Pantalla completa con la cabecera de la app, para cuenta y administración. */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div data-ui="shell" className="flex h-dvh flex-col overflow-hidden bg-bg text-fg" onMouseDown={releaseOnBlankFrame}>
      <ChromeHeader />
      {children}
    </div>
  );
}
