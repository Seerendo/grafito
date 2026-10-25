import type { ReactNode } from "react";
import { ChromeHeader } from "./ChromeHeader";

/** Pantalla completa con la cabecera de la app, para cuenta y administración. */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <ChromeHeader />
      {children}
    </div>
  );
}
