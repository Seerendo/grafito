import { Bot, CheckCircle2, CircleAlert, Loader2, MessageCircle, Send, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAiChat, type ChatTurn } from "@/app/ai-chat";
import { useVault } from "@/app/vault/store";
import { MarkdownView } from "@/components/vault/MarkdownView";
import { Select } from "@/components/ui/Select";
import { findByTitle } from "@/domain/vault/links";
import type { AiProviderId } from "@/domain/ai";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { aiChatState, aiModels } from "@/server/ai.functions";
import { t } from "@/app/i18n";

/**
 * Chat de IA de la bóveda: botón flotante (o Ctrl+B) que abre un panel para
 * hablar con el modelo elegido sobre las notas, portafolios y archivos.
 */

type ChatInfo = Awaited<ReturnType<typeof aiChatState>>;

export function AiChat({ mobile, onOpenNote }: { mobile: boolean; onOpenNote: (id: string) => void }) {
  const userId = useCurrentUser()?.id;
  const open = useAiChat((state) => state.open);
  const bind = useAiChat((state) => state.bind);
  const setOpen = useAiChat((state) => state.setOpen);
  const [info, setInfo] = useState<ChatInfo | null>(null);

  useEffect(() => {
    if (userId) bind(userId);
  }, [userId, bind]);

  // Se consulta al abrir: si la persona acaba de conectar un proveedor, ya aparece.
  useEffect(() => {
    if (!open) return;
    void aiChatState()
      .then(setInfo)
      .catch(() => setInfo({ ok: false, providers: [] }));
  }, [open]);

  useEffect(() => {
    void aiChatState()
      .then(setInfo)
      .catch(() => setInfo({ ok: false, providers: [] }));
  }, []);

  if (info && !info.ok) return null;

  return (
    <>
      {!open ? (
        <button
          type="button"
          aria-label={t("Abrir chat de IA (Ctrl+B)")}
          title={t("Chat de IA (Ctrl+B)")}
          onClick={() => setOpen(true)}
          data-ui="fab"
          className={`fixed right-4 z-30 grid size-12 place-items-center rounded-full bg-accent text-accent-fg shadow-lg transition-transform hover:scale-105 ${
            mobile ? "bottom-20" : "bottom-5"
          }`}
        >
          <MessageCircle className="size-5" />
        </button>
      ) : (
        <ChatPanel mobile={mobile} info={info} onOpenNote={onOpenNote} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function ChatPanel({
  mobile,
  info,
  onOpenNote,
  onClose,
}: {
  mobile: boolean;
  info: ChatInfo | null;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const turns = useAiChat((state) => state.turns);
  const busy = useAiChat((state) => state.busy);
  const model = useAiChat((state) => state.model);
  const send = useAiChat((state) => state.send);
  const stop = useAiChat((state) => state.stop);
  const clear = useAiChat((state) => state.clear);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const providers = info?.ok ? info.providers : [];
  const modelReady = Boolean(model && providers.some((provider) => provider.id === model.provider));

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  useEffect(() => {
    if (modelReady) inputRef.current?.focus();
  }, [modelReady]);

  const submit = () => {
    if (!draft.trim() || busy || !modelReady) return;
    void send(draft);
    setDraft("");
  };

  return (
    <aside
      data-ui="chat"
      role="dialog"
      aria-label={t("Chat de IA")}
      className={`fixed z-40 flex flex-col border border-line bg-surface shadow-2xl ${
        mobile ? "inset-0" : "right-4 bottom-4 h-[min(640px,calc(100dvh-6rem))] w-[min(420px,calc(100vw-2rem))] rounded-lg"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Bot className="size-4 text-accent" />
        <span className="text-sm font-medium">{t("Asistente")}</span>
        <span className="ml-auto flex items-center">
          {turns.length > 0 ? (
            <button type="button" onClick={clear} aria-label={t("Nueva conversación")} title={t("Nueva conversación")} className="grid size-9 place-items-center text-muted hover:text-fg">
              <Trash2 className="size-4" />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label={t("Cerrar chat (Ctrl+B)")} title={t("Cerrar (Ctrl+B)")} className="grid size-9 place-items-center text-muted hover:text-fg">
            <X className="size-4" />
          </button>
        </span>
      </header>

      {info === null ? (
        <Centered>
          <Loader2 className="size-4 animate-spin" />{" "}{t("Cargando…")}
        </Centered>
      ) : providers.length === 0 ? (
        <Centered>
          <span>
            {info.ok && info.anyAllowed
              ? t("Todavía no has conectado ningún proveedor de IA.")
              : t("El administrador todavía no ha activado proveedores de IA.")}
          </span>
          {info.ok && info.anyAllowed ? (
            <Link to="/cuenta" className="text-accent underline-offset-4 hover:underline">
              {t("Conectar uno en Cuenta → IA")}
            </Link>
          ) : null}
        </Centered>
      ) : (
        <>
          <ModelPicker providers={providers} />
          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {!modelReady ? (
              <Hint>{t("Selecciona un modelo para empezar.")}</Hint>
            ) : turns.length === 0 ? (
              <Hint>
                {t("Pregunta sobre tus notas, pide un resumen de un portafolio o que cree una nota. Ej.: «¿Qué hay en el portafolio Atlas?»")}
              </Hint>
            ) : null}
            {turns.map((turn) => (
              <Turn key={turn.id} turn={turn} onOpenNote={onOpenNote} />
            ))}
          </div>
          <form
            className="flex items-end gap-2 border-t border-line p-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              disabled={!modelReady}
              rows={2}
              aria-label={t("Mensaje para la IA")}
              placeholder={modelReady ? t("Escribe… (Enter envía, Mayús+Enter salta de línea)") : t("Selecciona un modelo")}
              className="max-h-40 min-h-11 flex-1 resize-none rounded-md border border-line bg-inset px-3 py-2 text-sm text-fg outline-none disabled:opacity-60"
            />
            {busy ? (
              <button type="button" onClick={stop} aria-label={t("Detener")} className="grid size-11 shrink-0 place-items-center rounded-md border border-line text-fg">
                <Square className="size-4" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!modelReady || !draft.trim()}
                aria-label={t("Enviar")}
                className="grid size-11 shrink-0 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
              >
                <Send className="size-4" />
              </button>
            )}
          </form>
        </>
      )}
    </aside>
  );
}

function ModelPicker({ providers }: { providers: { id: AiProviderId; label: string }[] }) {
  const model = useAiChat((state) => state.model);
  const setModel = useAiChat((state) => state.setModel);
  const [provider, setProvider] = useState<AiProviderId | "">(
    model && providers.some((item) => item.id === model.provider) ? model.provider : "",
  );
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!provider) return;
    setModels(null);
    setError("");
    void aiModels({ data: { provider } })
      .then((result) => {
        if (!result.ok) setError(result.error);
        setModels(result.models);
      })
      .catch(() => setError(t("No se pudieron leer los modelos.")));
  }, [provider]);

  const current = model?.provider === provider ? model.model : "";
  const options = useMemo(() => (models && current && !models.includes(current) ? [current, ...models] : (models ?? [])), [models, current]);

  return (
    <div className="grid grid-cols-2 gap-2 border-b border-line px-3 py-2">
      <Select
        value={provider}
        onChange={(value) => {
          setProvider(value as AiProviderId);
          setModel(null);
        }}
      >
        <option value="" disabled>
          {t("Proveedor")}
        </option>
        {providers.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </Select>
      <Select
        value={current}
        onChange={(value) => provider && setModel(value ? { provider, model: value } : null)}
      >
        <option value="" disabled>
          {!provider ? t("Modelo") : models === null && !error ? t("Cargando…") : options.length ? t("Modelo") : t("Sin modelos")}
        </option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </Select>
      {error ? <p className="col-span-2 text-xs text-danger">{t(error)}</p> : null}
    </div>
  );
}

function Turn({ turn, onOpenNote }: { turn: ChatTurn; onOpenNote: (id: string) => void }) {
  const documents = useVault((state) => state.documents);
  if (turn.role === "user") {
    return (
      <div className="ml-8 rounded-lg bg-elevated px-3 py-2 text-sm whitespace-pre-wrap text-fg">{turn.content}</div>
    );
  }
  return (
    <div className="mr-4 space-y-2">
      {turn.tools && turn.tools.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {turn.tools.map((tool, index) => (
            <li key={index}>
              <button
                type="button"
                disabled={!tool.docId}
                onClick={() => tool.docId && onOpenNote(tool.docId)}
                className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                  tool.ok ? "border-line text-muted enabled:hover:text-fg" : "border-danger/40 text-danger"
                }`}
              >
                {tool.ok ? <CheckCircle2 className="size-3 shrink-0" /> : <CircleAlert className="size-3 shrink-0" />}
                <span className="truncate">{t(tool.label)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {turn.content ? (
        <div className="-mx-4 -my-3 text-sm [&_article]:max-w-none">
          <MarkdownView
            source={turn.content}
            title=""
            noteExists={(name) => Boolean(findByTitle(documents, name))}
            onWiki={(name) => {
              const target = findByTitle(documents, name);
              if (target) onOpenNote(target.id);
            }}
            onTag={() => undefined}
          />
        </div>
      ) : null}
      {turn.pending && !turn.content ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="size-3.5 animate-spin" />{" "}{t("Pensando…")}
        </p>
      ) : null}
      {turn.error ? <p className="text-xs text-danger">{t(turn.error)}</p> : null}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-sm text-muted">{children}</p>;
}
