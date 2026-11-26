import { useEffect, useMemo, useRef, useState } from "react";
import { intl, t } from "@/app/i18n";
import { mailFrameDocument, sanitizeMailHtml } from "@/app/mail/sanitize";
import { mailMessage } from "@/server/mailbox.functions";

/**
 * The message being answered or forwarded, below what the person writes, as Outlook and Zimbra
 * show it: a header block (De, Enviado, Para, CC, Asunto) and the original with its formatting
 * (cleaned and in a frame without scripts). It is read only; the server adds it after the text
 * when the message goes out.
 */

type Detail = Extract<Awaited<ReturnType<typeof mailMessage>>, { ok: true }>["message"];

export function QuotedOriginal({
  messageId,
  kind,
}: {
  messageId: string;
  kind: "reply" | "forward";
}) {
  const [message, setMessage] = useState<Detail | null>(null);
  const [height, setHeight] = useState(200);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let alive = true;
    void mailMessage({ data: { id: messageId } })
      .then((answer) => alive && answer.ok && setMessage(answer.message))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [messageId]);

  const doc = useMemo(() => {
    if (!message?.html) return null;
    const clean = sanitizeMailHtml(message.html, { remote: false, cid: new Map() });
    return mailFrameDocument(clean.html, {
      remote: false,
      origin: typeof window === "undefined" ? "" : window.location.origin,
    });
  }, [message]);

  if (!message) return null;
  const person = (item: { name: string; address: string }) =>
    item.name ? `${item.name} <${item.address}>` : item.address;
  const rows: [string, string][] = [
    ["De", person(message.from)],
    [
      "Enviado",
      new Date(message.sentAt ?? message.receivedAt).toLocaleString(intl(), {
        dateStyle: "full",
        timeStyle: "short",
      }),
    ],
    ["Para", message.to.map(person).join("; ")],
    ...(message.cc.length
      ? ([["CC", message.cc.map(person).join("; ")]] as [string, string][])
      : []),
    ["Asunto", message.subject],
  ];
  const fit = () => {
    const inner = frame.current?.contentDocument?.documentElement;
    if (inner) setHeight(Math.max(60, inner.scrollHeight + 2));
  };

  return (
    <section data-ui="mail-quoted" className="flex flex-col gap-2 text-sm">
      {kind === "forward" ? (
        <p className="text-xs text-faint">---------- {t("Mensaje reenviado")} ----------</p>
      ) : null}
      <div className="border-t border-line pt-2 text-xs leading-relaxed">
        {rows.map(([label, value]) => (
          <p key={label}>
            <span className="font-semibold">{t(label)}:</span> {value}
          </p>
        ))}
      </div>
      {doc ? (
        <iframe
          ref={frame}
          title={t("Mensaje original")}
          // Same origin only to measure it; never scripts.
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          onLoad={fit}
          style={{ height }}
          className="block w-full rounded-md border border-line bg-white"
        />
      ) : (
        <pre className="rounded-md border border-line p-3 font-sans whitespace-pre-wrap break-words text-muted">
          {message.text}
        </pre>
      )}
    </section>
  );
}
