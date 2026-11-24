/**
 * HTML of a mail message is untrusted. This cleans it with the browser's parser (never as
 * markup in the page): no scripts, frames, forms, SVG or event handlers; links only http, https
 * and mailto, opened outside; images only embedded (data:, cid: through a signed link) unless the
 * person chooses to load remote ones, which also blocks tracking pixels. The result is shown in an
 * iframe sandboxed without scripts and without the app's origin, with its own CSP: two layers, so
 * a gap in one is caught by the other.
 */

const DROP = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "link",
  "meta",
  "base",
  "svg",
  "math",
  "template",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "canvas",
  "dialog",
  "slot",
  "isindex",
  "keygen",
]);

const URL_ATTRS = [
  "href",
  "src",
  "background",
  "poster",
  "action",
  "formaction",
  "xlink:href",
  "cite",
  "longdesc",
  "lowsrc",
  "dynsrc",
];

const DATA_IMAGE = /^data:image\/(png|gif|jpeg|jpg|webp|bmp);base64,[a-z0-9+/=\s]+$/i;

export type SanitizeOptions = {
  /** Load images from the internet (off by default). */
  remote: boolean;
  /** Content-ID → signed URL of an embedded image already downloaded. */
  cid: Map<string, string>;
};

export type Sanitized = { html: string; blockedRemote: number; missingCid: string[] };

function cleanStyle(value: string, remote: boolean): string {
  let out = value.replace(/expression\s*\(|javascript:|behaviou?r\s*:|-moz-binding/gi, "");
  if (!remote) out = out.replace(/url\s*\(\s*(['"]?)\s*(?!data:image\/)[^)]*\1\s*\)/gi, "none");
  return out.replace(/@import[^;]*;?/gi, "");
}

export function sanitizeMailHtml(html: string, options: SanitizeOptions): Sanitized {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let blockedRemote = 0;
  const missingCid: string[] = [];
  for (const element of [...doc.querySelectorAll("*")]) {
    const tag = element.tagName.toLowerCase();
    if (DROP.has(tag)) {
      element.remove();
      continue;
    }
    if (tag === "style") {
      element.textContent = cleanStyle(element.textContent ?? "", options.remote);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "srcset" ||
        name === "ping" ||
        name === "formaction" ||
        name === "action"
      )
        element.removeAttribute(attribute.name);
      else if (name === "style")
        element.setAttribute("style", cleanStyle(attribute.value, options.remote));
      else if (URL_ATTRS.includes(name) && name !== "href" && name !== "src")
        element.removeAttribute(attribute.name);
    }
    if (tag === "a" || tag === "area") {
      const href = (element.getAttribute("href") ?? "").trim();
      if (!/^(https?:|mailto:)/i.test(href)) element.removeAttribute("href");
      else {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer nofollow");
      }
    } else if (element.hasAttribute("href")) element.removeAttribute("href");
    if (tag === "img") {
      const src = (element.getAttribute("src") ?? "").trim();
      if (/^cid:/i.test(src)) {
        const id = decodeURIComponent(src.slice(4)).replace(/^<|>$/g, "");
        const url = options.cid.get(id);
        if (url) element.setAttribute("src", url);
        else {
          element.removeAttribute("src");
          missingCid.push(id);
        }
      } else if (DATA_IMAGE.test(src)) {
        /* embedded: allowed */
      } else if (/^https?:/i.test(src) && options.remote) {
        element.setAttribute("referrerpolicy", "no-referrer");
      } else {
        if (/^https?:/i.test(src)) blockedRemote += 1;
        element.removeAttribute("src");
        element.setAttribute("data-blocked", "1");
      }
    } else if (element.hasAttribute("src")) element.removeAttribute("src");
  }
  return { html: doc.body.innerHTML, blockedRemote, missingCid };
}

/** The document the sandboxed iframe shows: its own CSP, no scripts, links open outside. */
export function mailFrameDocument(
  body: string,
  options: { remote: boolean; origin: string },
): string {
  const images = ["data:", options.origin, ...(options.remote ? ["https:", "http:"] : [])].join(
    " ",
  );
  const csp = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;padding:12px;background:#fff;color:#111;font:14px/1.5 system-ui,sans-serif;word-wrap:break-word}img{max-width:100%;height:auto}img[data-blocked]{display:none}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`;
}
