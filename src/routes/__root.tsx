import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { useSyncExternalStore } from "react";
import { applyLocale, getLocale, LOCALE_COOKIE, localeFromCookie, useLocale } from "@/app/i18n";
import { themeBootScript } from "@/app/theme";
import { SessionWatch } from "@/components/session/SessionWatch";
import type { Locale } from "@/domain/i18n";
import appCss from "../styles.css?url";

const APP_NAME = "Grafito";
const APP_DESCRIPTION = "Bóveda de notas en Markdown con enlaces, menciones y grafo.";
const THEME_BOOT = themeBootScript();

/**
 * Idioma de la petición: la cookie que guarda `setLocale` (en el servidor, de
 * la cabecera; en el navegador, de `document.cookie`). Sin cookie, español.
 */
const requestLocale = createIsomorphicFn()
  .server(async (): Promise<Locale> => {
    const { getCookie } = await import("@tanstack/react-start/server");
    return localeFromCookie(`${LOCALE_COOKIE}=${getCookie(LOCALE_COOKIE) ?? ""}`) ?? "es";
  })
  .client(async (): Promise<Locale> => localeFromCookie(document.cookie) ?? getLocale());

export const Route = createRootRoute({
  beforeLoad: async () => ({ locale: await requestLocale() }),
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
  component: RootDocument,
});

const noop = () => () => undefined;

function RootDocument() {
  const { locale: initial } = Route.useRouteContext();
  // El idioma de la petición se fija antes de pintar, para que el servidor y
  // el navegador hidraten el mismo texto.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  if (!hydrated) applyLocale(initial);
  const locale = useLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <SessionWatch />
        {/* Cambiar de idioma vuelve a montar la aplicación con los textos nuevos. */}
        <Outlet key={locale} />
        <Scripts />
      </body>
    </html>
  );
}
