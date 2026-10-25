import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { themeBootScript } from "@/app/theme";
import { SessionWatch } from "@/components/session/SessionWatch";
import appCss from "../styles.css?url";

const APP_NAME = "Grafito";
const APP_DESCRIPTION = "Bóveda de notas en Markdown con enlaces, menciones y grafo.";
const THEME_BOOT = themeBootScript();

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "description", content: APP_DESCRIPTION },
      { name: "theme-color", content: "#12110e" },
      { property: "og:title", content: APP_NAME },
      { property: "og:description", content: APP_DESCRIPTION },
      { property: "og:image", content: "/og.jpg" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icon-180.png" },
    ],
  }),
  component: () => (
    <html lang="es" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <SessionWatch />
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
