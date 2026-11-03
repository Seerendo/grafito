import {
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  History,
  Search,
  Loader2,
  MessageCircle,
  Minus,
  Pencil,
  Plus,
  SquarePen,
  Square,
  Trash2,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAiChat, type AiProfile, type ChatTurn } from "@/app/ai-chat";
import { useVault } from "@/app/vault/store";
import { MarkdownView } from "@/components/vault/MarkdownView";
import { Switch } from "@/components/ui/Switch";
import { findByTitle } from "@/domain/vault/links";
import type { AiProviderId } from "@/domain/ai";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { aiChatState, aiModels } from "@/server/ai.functions";
import { intl, t } from "@/app/i18n";
import { uuid } from "@/lib/uuid";

/**
 * Vault AI chat opens from the floating button or Ctrl+B. Conversations are saved; clicking
 * outside minimizes the panel. Users select a model and an optional custom persona with their
 * own instructions.
 */

type ChatInfo = Awaited<ReturnType<typeof aiChatState>>;
type Provider = { id: AiProviderId; label: string };

/** Open/minimize animation duration, matching CSS. */
const MOTION_MS = 200;

export function AiChat({
  mobile,
  onOpenNote,
}: {
  mobile: boolean;
  onOpenNote: (id: string) => void;
}) {
  const userId = useCurrentUser()?.id;
  const open = useAiChat((state) => state.open);
  const bind = useAiChat((state) => state.bind);
  const setOpen = useAiChat((state) => state.setOpen);
  const [info, setInfo] = useState<ChatInfo | null>(null);
  // Keep the panel mounted during its minimize animation.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (userId) bind(userId);
  }, [userId, bind]);

  // Refresh on opening so newly connected providers appear immediately.
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

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Wait briefly after mounting so the browser paints the closed state before animating open.
      const timer = window.setTimeout(() => setShown(true), 20);
      return () => window.clearTimeout(timer);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (info && !info.ok) return null;

  return (
    <>
      <button
        type="button"
        aria-label={t("Abrir chat de IA (Ctrl+B)")}
        title={t("Chat de IA (Ctrl+B)")}
        onClick={() => setOpen(true)}
        data-ui="fab"
        data-state={mounted ? "hidden" : "shown"}
        tabIndex={mounted ? -1 : 0}
        className={`ai-fab fixed right-4 z-30 grid size-12 place-items-center rounded-full bg-accent text-accent-fg shadow-lg ${
          mobile ? "bottom-20" : "bottom-5"
        }`}
      >
        <MessageCircle className="size-5" />
      </button>
      {mounted ? (
        <ChatPanel
          mobile={mobile}
          shown={shown}
          info={info}
          onOpenNote={onOpenNote}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ChatPanel({
  mobile,
  shown,
  info,
  onOpenNote,
  onClose,
}: {
  mobile: boolean;
  shown: boolean;
  info: ChatInfo | null;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const turns = useAiChat((state) => state.turns);
  const busy = useAiChat((state) => state.busy);
  const model = useAiChat((state) => state.model);
  const send = useAiChat((state) => state.send);
  const stop = useAiChat((state) => state.stop);
  const newChat = useAiChat((state) => state.newChat);
  const draft = useAiChat((state) => state.draft);
  const setDraft = useAiChat((state) => state.setDraft);
  const [view, setView] = useState<"chat" | "history" | "profiles">("chat");
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const providers: Provider[] = info?.ok ? info.providers : [];
  const modelReady = Boolean(model && providers.some((provider) => provider.id === model.provider));
  const title =
    turns
      .find((turn) => turn.role === "user")
      ?.content.replace(/\s+/g, " ")
      .trim() || t("Nueva conversación");

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, view]);

  useEffect(() => {
    if (modelReady && view === "chat") inputRef.current?.focus();
  }, [modelReady, view]);

  // Outside clicks minimize desktop chat; mobile chat fills the screen.
  useEffect(() => {
    if (mobile) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panelRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [mobile, onClose]);

  // Grow the composer with its content up to a height limit.
  useEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
  }, [draft]);

  const submit = () => {
    if (!draft.trim() || busy || !modelReady) return;
    void send(draft);
    setDraft("");
    // Show responses in the conversation instead of behind the history panel.
    setView("chat");
  };

  return (
    <aside
      ref={panelRef}
      data-ui="chat"
      data-state={shown ? "open" : "closed"}
      role="dialog"
      aria-label={t("Chat de IA")}
      className={`ai-panel fixed z-40 flex flex-col border border-line bg-surface shadow-2xl ${
        mobile
          ? "inset-0"
          : "right-4 bottom-4 h-[min(640px,calc(100dvh-6rem))] w-[min(420px,calc(100vw-2rem))] rounded-lg"
      }`}
    >
      <header className="flex items-center gap-2 border-b border-line py-1.5 pr-1.5 pl-3">
        <Bot className="size-4 shrink-0 text-accent" />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          title={view === "chat" ? title : undefined}
        >
          {view === "history" ? t("Historial") : view === "profiles" ? t("Perfiles") : title}
        </span>
        <HeaderButton
          label={t("Historial de conversaciones")}
          pressed={view === "history"}
          onClick={() => setView((value) => (value === "history" ? "chat" : "history"))}
        >
          <History className="size-4" />
        </HeaderButton>
        <HeaderButton
          label={t("Nueva conversación")}
          onClick={() => {
            newChat();
            setView("chat");
            setDraft("");
          }}
        >
          <SquarePen className="size-4" />
        </HeaderButton>
        <HeaderButton label={t("Minimizar (Ctrl+B)")} onClick={onClose}>
          <Minus className="size-4" />
        </HeaderButton>
      </header>

      {info === null ? (
        <Centered>
          <Loader2 className="size-4 animate-spin" /> {t("Cargando…")}
        </Centered>
      ) : (
        <>
          {/* History occupies the message area; the composer remains below. */}
          {view === "history" ? (
            <HistoryList onPick={() => setView("chat")} />
          ) : view === "profiles" ? (
            <ProfilesView onDone={() => setView("chat")} />
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
            <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
              {!modelReady ? (
                <Hint>{t("Elige un modelo abajo para empezar.")}</Hint>
              ) : turns.length === 0 ? (
                <Hint>
                  {t(
                    "Pregunta sobre tus notas, pide un resumen de un portafolio o que cree una nota. Ej.: «¿Qué hay en el portafolio Atlas?»",
                  )}
                </Hint>
              ) : null}
              {turns.map((turn) => (
                <Turn key={turn.id} turn={turn} onOpenNote={onOpenNote} />
              ))}
            </div>
          )}
          {providers.length > 0 && view !== "profiles" ? (
            // One composer contains text, persona, model selection and send action.
            <form
              data-ui="composer"
              className="m-2 flex shrink-0 flex-col rounded-lg border border-line bg-inset"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              onClick={(event) => {
                if (event.target === event.currentTarget) inputRef.current?.focus();
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
                rows={1}
                aria-label={t("Mensaje para la IA")}
                placeholder={modelReady ? t("Escribe un mensaje…") : t("Elige un modelo abajo")}
                className="block max-h-40 min-h-9 w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-0.5 text-sm text-fg outline-none placeholder:text-faint disabled:opacity-60"
              />
              <span className="flex items-center gap-1 px-1.5 pb-1.5">
                <ProfilePicker onManage={() => setView("profiles")} />
                <ModelPicker providers={providers} />
                {busy ? (
                  <button
                    type="button"
                    onClick={stop}
                    aria-label={t("Detener")}
                    title={t("Detener")}
                    className="ml-auto grid size-7 shrink-0 place-items-center rounded-md border border-line text-fg"
                  >
                    <Square className="size-3" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!modelReady || !draft.trim()}
                    aria-label={t("Enviar")}
                    title={t("Enviar (Enter)")}
                    className="ml-auto grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-40"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                )}
              </span>
            </form>
          ) : null}
        </>
      )}
    </aside>
  );
}

function HeaderButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`grid size-8 shrink-0 place-items-center rounded-md ${pressed ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

/** Saved conversations, newest first. */
function HistoryList({ onPick }: { onPick: () => void }) {
  const conversations = useAiChat((state) => state.conversations);
  const current = useAiChat((state) => state.conversationId);
  const load = useAiChat((state) => state.loadConversations);
  const openChat = useAiChat((state) => state.openChat);
  const deleteChat = useAiChat((state) => state.deleteChat);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  if (conversations === null) {
    return (
      <Centered>
        <Loader2 className="size-4 animate-spin" /> {t("Cargando…")}
      </Centered>
    );
  }
  if (conversations.length === 0) return <Centered>{t("Todavía no hay conversaciones.")}</Centered>;
  const when = (ms: number) =>
    new Intl.DateTimeFormat(intl(), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {conversations.map((item) => (
        <li key={item.id} className="group flex items-center gap-1 rounded-md hover:bg-elevated">
          <button
            type="button"
            onClick={() => {
              void openChat(item.id);
              onPick();
            }}
            className="flex min-w-0 flex-1 flex-col px-2.5 py-2 text-left"
          >
            <span className={`truncate text-sm ${item.id === current ? "text-accent" : "text-fg"}`}>
              {item.title || t("Sin título")}
            </span>
            <span className="text-[11px] text-faint">{when(item.updatedAt)}</span>
          </button>
          {confirming === item.id ? (
            <span className="flex shrink-0 items-center gap-2 pr-2 text-xs">
              <button
                type="button"
                onClick={() => void deleteChat(item.id)}
                className="text-danger"
              >
                {t("Eliminar")}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="text-muted hover:text-fg"
              >
                {t("No")}
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(item.id)}
              aria-label={t("Eliminar conversación")}
              title={t("Eliminar conversación")}
              className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

type ModelEntry = { list: string[]; error: string };

/**
 * The composer first lists connected providers, then searchable models for the chosen provider.
 * Recheck connections when opening the selector and report those that stopped responding.
 */
function ModelPicker({ providers }: { providers: Provider[] }) {
  const model = useAiChat((state) => state.model);
  const setModel = useAiChat((state) => state.setModel);
  const [picked, setPicked] = useState<AiProviderId | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<Partial<Record<AiProviderId, ModelEntry | null>>>({});
  const started = useRef(new Set<AiProviderId>());
  const rootRef = useRef<HTMLDivElement>(null);

  const savedId =
    model && providers.some((provider) => provider.id === model.provider) ? model.provider : null;
  const activeId =
    picked && providers.some((provider) => provider.id === picked) ? picked : savedId;
  const active = providers.find((provider) => provider.id === activeId) ?? null;
  const entry = activeId ? models[activeId] : undefined;
  const activeError = entry?.error ?? "";
  const modelReady = Boolean(model && model.provider === activeId);

  // Reuse fetched lists; retry explicitly after failure.
  const load = useCallback((id: AiProviderId) => {
    if (started.current.has(id)) return;
    started.current.add(id);
    setModels((state) => ({ ...state, [id]: null }));
    void aiModels({ data: { provider: id } })
      .then((result) =>
        setModels((state) => ({
          ...state,
          [id]: { list: result.models, error: result.ok ? "" : result.error },
        })),
      )
      .catch(() =>
        setModels((state) => ({
          ...state,
          [id]: { list: [], error: "No se pudieron leer los modelos." },
        })),
      );
  }, []);

  const retry = (id: AiProviderId) => {
    started.current.delete(id);
    load(id);
  };

  useEffect(() => {
    if (activeId) load(activeId);
  }, [activeId, load]);

  // Check each connection when opening the menu, but display models only for the selected provider.
  useEffect(() => {
    if (!providerOpen) return;
    for (const provider of providers) load(provider.id);
  }, [providerOpen, providers, load]);

  useEffect(() => {
    if (!providerOpen && !modelOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setProviderOpen(false);
        setModelOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setProviderOpen(false);
      setModelOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [providerOpen, modelOpen]);

  const chooseProvider = (id: AiProviderId) => {
    setPicked(id);
    if (model?.provider !== id) setModel(null);
    if (models[id]?.error) retry(id);
    setQuery("");
    setProviderOpen(false);
    setModelOpen(true);
  };

  const needle = query.trim().toLowerCase();
  const visible =
    !entry || entry.error ? [] : entry.list.filter((name) => name.toLowerCase().includes(needle));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {active && activeError ? (
        <p className="line-clamp-2 px-1 pb-0.5 text-[11px] leading-snug text-danger">
          {active.label}: {t(activeError)}
        </p>
      ) : null}
      <div ref={rootRef} className="flex min-w-0 items-center">
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={() => {
              setModelOpen(false);
              setProviderOpen((value) => !value);
            }}
            aria-haspopup="menu"
            aria-expanded={providerOpen}
            aria-label={t("Proveedor")}
            title={
              activeError
                ? `${active?.label ?? ""}: ${activeError}`
                : (active?.label ?? t("Elegir proveedor"))
            }
            className={`flex h-7 max-w-32 min-w-0 items-center gap-1 rounded-md px-2 text-xs hover:bg-elevated ${
              activeError ? "text-danger" : active ? "text-muted hover:text-fg" : "text-accent"
            }`}
          >
            {activeError ? <CircleAlert className="size-3 shrink-0" /> : null}
            <span className="truncate">{active ? active.label : t("Elegir proveedor")}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
          {providerOpen ? (
            <div
              role="menu"
              data-ui="popover"
              className="absolute bottom-full left-0 z-10 mb-1 max-h-72 w-60 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-2xl"
            >
              {providers.map((provider) => {
                const row = models[provider.id];
                const on = provider.id === activeId;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => chooseProvider(provider.id)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg hover:bg-elevated"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{provider.label}</span>
                      {row === null || row === undefined ? (
                        <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                          <Loader2 className="size-3 animate-spin" />
                          {t("Cargando…")}
                        </span>
                      ) : row.error ? (
                        <span className="mt-0.5 block text-[11px] leading-snug text-danger">
                          {t(row.error)}
                        </span>
                      ) : null}
                    </span>
                    {on ? <Check className="mt-0.5 size-3.5 shrink-0 text-accent" /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => {
              setProviderOpen(false);
              setModelOpen((value) => !value);
              setQuery("");
            }}
            aria-haspopup="menu"
            aria-expanded={modelOpen}
            aria-label={t("Modelo")}
            title={modelReady && model ? model.model : t("Elegir modelo")}
            className={`flex h-7 w-full min-w-0 items-center gap-1 rounded-md px-2 text-xs hover:bg-elevated ${
              modelReady ? "text-muted hover:text-fg" : "text-accent"
            }`}
          >
            <span className="truncate">
              {modelReady && model ? model.model : t("Elegir modelo")}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
          {modelOpen ? (
            <div
              role="menu"
              data-ui="popover"
              className="absolute bottom-full right-0 z-10 mb-1 flex max-h-80 w-72 max-w-[min(18rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-2xl"
            >
              {!active ? (
                <p className="px-2 py-1.5 text-xs text-muted">{t("Elige un proveedor primero.")}</p>
              ) : (
                <>
                  <label className="flex h-8 shrink-0 items-center gap-2.5 rounded-md border border-line bg-inset px-2.5">
                    <Search className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      placeholder={t("Buscar modelo")}
                      aria-label={t("Buscar modelo")}
                      autoComplete="off"
                      className="min-w-0 flex-1 appearance-none bg-transparent pl-1.5 text-xs text-fg outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden [&::-webkit-search-results-button]:hidden"
                    />
                  </label>
                  <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
                    {entry === null || entry === undefined ? (
                      <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted">
                        <Loader2 className="size-3 animate-spin" />
                        {t("Cargando…")}
                      </p>
                    ) : entry.error ? (
                      <p className="px-2 py-1.5 text-xs text-danger">{t(entry.error)}</p>
                    ) : entry.list.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted">{t("Sin modelos")}</p>
                    ) : visible.length === 0 ? (
                      <p className="px-2 py-1.5 text-xs text-muted">
                        {t("Ningún modelo coincide")}
                      </p>
                    ) : (
                      visible.map((name) => {
                        const on = model?.provider === active.id && model.model === name;
                        return (
                          <button
                            key={name}
                            type="button"
                            role="menuitemradio"
                            aria-checked={on}
                            onClick={() => {
                              setModel({ provider: active.id, model: name });
                              setPicked(active.id);
                              setModelOpen(false);
                            }}
                            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-fg hover:bg-elevated"
                          >
                            <span className="min-w-0 flex-1 truncate">{name}</span>
                            {on ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Persona selector beside the model: general assistant or a custom persona, with management actions. */
function ProfilePicker({ onManage }: { onManage: () => void }) {
  const profiles = useAiChat((state) => state.profiles);
  const profileId = useAiChat((state) => state.profileId);
  const setProfile = useAiChat((state) => state.setProfile);
  const load = useAiChat((state) => state.loadProfiles);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = profiles?.find((profile) => profile.id === profileId) ?? null;

  useEffect(() => {
    if (profiles === null) void load();
  }, [profiles, load]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (id: string | null) => {
    setProfile(id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Perfil")}
        title={current ? current.name : t("General")}
        className={`flex h-7 max-w-36 min-w-0 items-center gap-1 rounded-md px-2 text-xs hover:bg-elevated ${
          current ? "text-accent" : "text-muted hover:text-fg"
        }`}
      >
        <UserRound className="size-3 shrink-0" />
        <span className="truncate">{current ? current.name : t("General")}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {open ? (
        <div
          role="menu"
          data-ui="popover"
          className="absolute bottom-full left-0 z-10 mb-1 max-h-72 w-60 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-2xl"
        >
          <ProfileOption on={!current} onClick={() => pick(null)}>
            {t("General")}
          </ProfileOption>
          {(profiles ?? []).map((profile) => (
            <ProfileOption
              key={profile.id}
              on={profile.id === current?.id}
              onClick={() => pick(profile.id)}
            >
              {profile.name}
            </ProfileOption>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted hover:bg-elevated hover:text-fg"
          >
            <Pencil className="size-3.5 shrink-0" />
            {t("Gestionar perfiles")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ProfileOption({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-fg hover:bg-elevated"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {on ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
    </button>
  );
}

/** Persona list supports selection, creation, editing and deletion. */
function ProfilesView({ onDone }: { onDone: () => void }) {
  const profiles = useAiChat((state) => state.profiles);
  const profileId = useAiChat((state) => state.profileId);
  const setProfile = useAiChat((state) => state.setProfile);
  const load = useAiChat((state) => state.loadProfiles);
  const remove = useAiChat((state) => state.deleteProfile);
  const [editing, setEditing] = useState<AiProfile | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  if (editing) return <ProfileForm profile={editing} onDone={() => setEditing(null)} />;
  if (profiles === null) {
    return (
      <Centered>
        <Loader2 className="size-4 animate-spin" /> {t("Cargando…")}
      </Centered>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {profiles.length === 0 ? <Centered>{t("Todavía no tienes perfiles.")}</Centered> : null}
        <ul>
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="group flex items-center gap-1 rounded-md hover:bg-elevated"
            >
              <button
                type="button"
                onClick={() => {
                  setProfile(profile.id);
                  onDone();
                }}
                className="flex min-w-0 flex-1 flex-col px-2.5 py-2 text-left"
              >
                <span
                  className={`flex items-center gap-2 text-sm ${profile.id === profileId ? "text-accent" : "text-fg"}`}
                >
                  <span className="truncate">{profile.name}</span>
                  {profile.readOnly ? (
                    <span className="shrink-0 rounded-full border border-line px-1.5 text-[10px] text-muted">
                      {t("Solo lectura")}
                    </span>
                  ) : null}
                </span>
                {profile.instructions ? (
                  <span className="truncate text-[11px] text-faint">
                    {profile.instructions.replace(/\s+/g, " ")}
                  </span>
                ) : null}
              </button>
              {confirming === profile.id ? (
                <span className="flex shrink-0 items-center gap-2 pr-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      void remove(profile.id);
                    }}
                    className="text-danger"
                  >
                    {t("Eliminar")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="text-muted hover:text-fg"
                  >
                    {t("No")}
                  </button>
                </span>
              ) : (
                <span className="mr-1 flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={() => setEditing(profile)}
                    aria-label={t("Editar perfil")}
                    title={t("Editar perfil")}
                    className="grid size-7 place-items-center rounded-md text-faint hover:text-fg"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(profile.id)}
                    aria-label={t("Eliminar perfil")}
                    title={t("Eliminar perfil")}
                    className="grid size-7 place-items-center rounded-md text-faint hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 justify-between gap-2 border-t border-line p-2">
        <button
          type="button"
          onClick={onDone}
          className="h-8 rounded-md px-3 text-sm text-muted hover:text-fg"
        >
          {t("Volver al chat")}
        </button>
        <button
          type="button"
          onClick={() => setEditing({ id: uuid(), name: "", instructions: "", readOnly: false })}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-sm text-accent-fg"
        >
          <Plus className="size-4" />
          {t("Nuevo perfil")}
        </button>
      </div>
    </div>
  );
}

function ProfileForm({ profile, onDone }: { profile: AiProfile; onDone: () => void }) {
  const save = useAiChat((state) => state.saveProfile);
  const [name, setName] = useState(profile.name);
  const [instructions, setInstructions] = useState(profile.instructions);
  const [readOnly, setReadOnly] = useState(profile.readOnly);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const problem = await save({
        id: profile.id,
        name: name.trim(),
        instructions: instructions.trim(),
        readOnly,
      });
      if (problem) setError(problem);
      else onDone();
    } catch {
      setError("No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <label className="block text-sm">
          <span className="text-muted">{t("Nombre")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            autoFocus
            autoComplete="off"
            className="mt-1 h-10 w-full rounded-md border border-line bg-inset px-3 text-fg"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted">{t("Instrucciones")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            maxLength={4000}
            rows={8}
            className="mt-1 block w-full resize-y rounded-md border border-line bg-inset px-3 py-2 text-sm text-fg"
          />
        </label>
        <Switch checked={readOnly} onChange={setReadOnly} label={t("Solo lectura")} />
        {error ? <p className="text-xs text-danger">{t(error)}</p> : null}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line p-2">
        <button
          type="button"
          onClick={onDone}
          className="h-8 rounded-md px-3 text-sm text-muted hover:text-fg"
        >
          {t("Cancelar")}
        </button>
        <button
          type="submit"
          disabled={!name.trim() || saving}
          className="h-8 rounded-md bg-accent px-3 text-sm text-accent-fg disabled:opacity-40"
        >
          {t("Guardar")}
        </button>
      </div>
    </form>
  );
}

function Turn({ turn, onOpenNote }: { turn: ChatTurn; onOpenNote: (id: string) => void }) {
  const documents = useVault((state) => state.documents);
  if (turn.role === "user") {
    return (
      <div className="ml-8 rounded-lg bg-elevated px-3 py-2 text-sm whitespace-pre-wrap text-fg">
        {turn.content}
      </div>
    );
  }
  return (
    <div className="mr-4 space-y-2">
      {turn.tools && turn.tools.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {turn.tools.map((tool, index) => (
            // Wrap long labels within their chip instead of overflowing the chat.
            <li key={index} className="max-w-full min-w-0">
              <button
                type="button"
                disabled={!tool.docId}
                onClick={() => tool.docId && onOpenNote(tool.docId)}
                className={`inline-flex max-w-full items-start gap-1 rounded-xl border px-2 py-0.5 text-left text-[11px] ${
                  tool.ok
                    ? "border-line text-muted enabled:hover:text-fg"
                    : "border-danger/40 text-danger"
                }`}
              >
                {tool.ok ? (
                  <CheckCircle2 className="mt-px size-3 shrink-0" />
                ) : (
                  <CircleAlert className="mt-px size-3 shrink-0" />
                )}
                <span className="min-w-0 [overflow-wrap:anywhere]">{t(tool.label)}</span>
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
          <Loader2 className="size-3.5 animate-spin" /> {t("Pensando…")}
        </p>
      ) : null}
      {turn.error ? <p className="text-xs text-danger">{t(turn.error)}</p> : null}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted">
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-line px-3 py-3 text-center text-sm text-muted">
      {children}
    </p>
  );
}
