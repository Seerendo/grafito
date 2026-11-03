import type { ReactNode } from "react";
import { ChromeHeader } from "./ChromeHeader";

/** Full-page account and administration layout with the application header. */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div data-ui="shell" className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <ChromeHeader />
      {children}
    </div>
  );
}
