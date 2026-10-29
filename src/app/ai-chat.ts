import { uuid } from "@/lib/uuid";
import { create } from "zustand";
import type { AiProviderId } from "@/domain/ai";
import { bearerHeader } from "@/lib/auth/bearer";
import { syncVault } from "@/app/vault/sync";
import { t } from "@/app/i18n";
import {
  aiConversation,
  aiConversations,
  aiProfiles,
  removeAiConversation,
  removeAiProfile,
  saveAiConversation,
  saveAiProfile,
} from "@/server/ai.functions";

/**
 * Estado del chat de IA (cliente): abierto o cerrado, modelo elegido, la
 * conversación abierta y el historial. Las conversaciones se guardan en el
 * servidor (`ai_conversation`); la pestaña recuerda cuál estaba abierta y el
 * navegador, el modelo y el perfil elegidos por usuario. Los perfiles
 * («Documentación», «Análisis»…) los crea cada persona (`ai_profile`).
 */

export type ToolChip = { label: string; ok: boolean; docId?: string };

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolChip[];
  error?: string;
  pending?: boolean;
};

export type ModelRef = { provider: AiProviderId; model: string };

export type ConversationSummary = { id: string; title: string; updatedAt: number };

export type AiProfile = { id: string; name: string; instructions: string; readOnly: boolean };

type ChatState = {
  userId: string | null;
  open: boolean;
  /** Conversación abierta (no se guarda mientras no tenga turnos). */
  conversationId: string;
  turns: ChatTurn[];
  /** Historial de conversaciones; `null` mientras no se ha leído. */
  conversations: ConversationSummary[] | null;
  model: ModelRef | null;
  busy: boolean;
  controller: AbortController | null;
  /** Lo escrito y aún no enviado: sigue ahí al minimizar y volver a abrir. */
  draft: string;
  setDraft: (draft: string) => void;
  /** Perfiles de la persona; `null` mientras no se han leído. */
  profiles: AiProfile[] | null;
  /** Perfil elegido; `null` es el asistente general. */
  profileId: string | null;
  setProfile: (id: string | null) => void;
  loadProfiles: () => Promise<void>;
  saveProfile: (profile: AiProfile) => Promise<string>;
  deleteProfile: (id: string) => Promise<void>;
  bind: (userId: string) => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setModel: (model: ModelRef | null) => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  newChat: () => void;
  openChat: (id: string) => Promise<void>;
  deleteChat: (id: string) => Promise<void>;
  loadConversations: () => Promise<void>;
};

const MODEL_KEY = "grafito.ai.model:";
const CURRENT_KEY = "grafito.ai.current:";
const PROFILE_KEY = "grafito.ai.profile:";

/**
 * Contexto que se manda al modelo: los últimos turnos de la conversación
 * abierta, hasta `CONTEXT_TURNS` y unos `CONTEXT_CHARS` caracteres (lo más
 * antiguo se deja fuera). Cada conversación tiene el suyo.
 */
const CONTEXT_TURNS = 30;
const CONTEXT_CHARS = 24_000;

/** Título de una conversación: el comienzo de la primera pregunta. */
function titleOf(turns: ChatTurn[]): string {
  const first = turns.find((turn) => turn.role === "user")?.content.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

function contextOf(turns: ChatTurn[]): { role: "user" | "assistant"; content: string }[] {
  const usable = turns.filter((turn) => !turn.error && turn.content).slice(-CONTEXT_TURNS);
  const picked: { role: "user" | "assistant"; content: string }[] = [];
  let size = 0;
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const turn = usable[index]!;
    // Lo que de verdad hizo en esa respuesta (no solo lo que dijo): sin esto,
    // el modelo veía «creé la nota» sin rastro de la herramienta y a veces lo
    // imitaba después sin llamarla.
    const actions =
      turn.role === "assistant" && turn.tools?.length ? `\n\n[Acciones: ${turn.tools.map((tool) => tool.label).join(" · ")}]` : "";
    const content = `${turn.content}${actions}`;
    size += content.length;
    if (picked.length > 0 && size > CONTEXT_CHARS) break;
    picked.unshift({ role: turn.role, content });
  }
  // La conversación que recibe el modelo empieza por la persona.
  while (picked[0]?.role === "assistant") picked.shift();
  return picked;
}

function stored(turns: ChatTurn[]): ChatTurn[] {
  return turns.map(({ pending: _pending, ...turn }) => turn);
}

function load<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(storage: () => Storage, key: string, value: unknown): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible */
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

export const useAiChat = create<ChatState>((set, get) => {
  /** Guarda la conversación en el servidor y la pone primera en el historial. */
  const persist = async (id: string, turns: ChatTurn[]) => {
    if (turns.length === 0) return;
    const title = titleOf(turns);
    try {
      const result = await saveAiConversation({ data: { id, title, turns: stored(turns) } });
      if (!result.ok) return;
      const list = get().conversations;
      if (list) set({ conversations: [{ id, title, updatedAt: result.updatedAt }, ...list.filter((item) => item.id !== id)] });
    } catch {
      /* sin conexión: queda en la pestaña */
    }
  };

  const select = (id: string, turns: ChatTurn[]) => {
    const userId = get().userId;
    if (userId) save(session, CURRENT_KEY + userId, id);
    set({ conversationId: id, turns });
  };

  return {
    userId: null,
    open: false,
    conversationId: "",
    turns: [],
    conversations: null,
    model: null,
    busy: false,
    controller: null,
    draft: "",
    profiles: null,
    profileId: null,

    setDraft: (draft) => set({ draft }),

    setProfile: (id) => {
      const userId = get().userId;
      if (userId) save(local, PROFILE_KEY + userId, id);
      set({ profileId: id });
    },

    loadProfiles: async () => {
      try {
        const result = await aiProfiles();
        const profiles = result.profiles;
        set({ profiles });
        // El elegido se borró (en otra pestaña o equipo): vuelve el general.
        const current = get().profileId;
        if (current && !profiles.some((profile) => profile.id === current)) get().setProfile(null);
      } catch {
        set({ profiles: get().profiles ?? [] });
      }
    },

    saveProfile: async (profile) => {
      const result = await saveAiProfile({ data: profile });
      if (!result.ok) return result.error;
      set({ profiles: result.profiles });
      return "";
    },

    deleteProfile: async (id) => {
      set({ profiles: (get().profiles ?? []).filter((profile) => profile.id !== id) });
      if (get().profileId === id) get().setProfile(null);
      try {
        const result = await removeAiProfile({ data: { id } });
        set({ profiles: result.profiles });
      } catch {
        /* reaparece al volver a leer los perfiles */
      }
    },

    bind: (userId) => {
      if (get().userId === userId) return;
      const current = load<string | null>(session, CURRENT_KEY + userId, null);
      set({
        userId,
        conversationId: current ?? uuid(),
        turns: [],
        conversations: null,
        model: load<ModelRef | null>(local, MODEL_KEY + userId, null),
        draft: "",
        profiles: null,
        profileId: load<string | null>(local, PROFILE_KEY + userId, null),
      });
      if (current) void get().openChat(current);
    },

    setOpen: (open) => set({ open }),
    toggle: () => set({ open: !get().open }),

    setModel: (model) => {
      const userId = get().userId;
      if (userId) save(local, MODEL_KEY + userId, model);
      set({ model });
    },

    stop: () => get().controller?.abort(),

    newChat: () => {
      get().controller?.abort();
      select(uuid(), []);
    },

    openChat: async (id) => {
      get().controller?.abort();
      select(id, []);
      try {
        const result = await aiConversation({ data: { id } });
        if (get().conversationId !== id) return;
        if (result.ok) set({ turns: result.turns });
        else select(uuid(), []);
      } catch {
        /* se queda vacía */
      }
    },

    deleteChat: async (id) => {
      set({ conversations: (get().conversations ?? []).filter((item) => item.id !== id) });
      if (get().conversationId === id) get().newChat();
      try {
        await removeAiConversation({ data: { id } });
      } catch {
        /* reaparece al volver a leer el historial */
      }
    },

    loadConversations: async () => {
      try {
        const result = await aiConversations();
        set({ conversations: result.conversations });
      } catch {
        set({ conversations: get().conversations ?? [] });
      }
    },

    send: async (text) => {
      const { model, userId, busy, conversationId, profileId } = get();
      const content = text.trim();
      if (!model || !userId || busy || !content) return;
      const userTurn: ChatTurn = { id: uuid(), role: "user", content };
      const answer: ChatTurn = { id: uuid(), role: "assistant", content: "", tools: [], pending: true };
      const history = contextOf([...get().turns, userTurn]);
      const controller = new AbortController();
      // Los turnos de esta conversación, aunque la persona abra otra mientras responde.
      let turns = [...get().turns, userTurn, answer];
      set({ turns, busy: true, controller });

      const patch = (change: Partial<ChatTurn> | ((turn: ChatTurn) => Partial<ChatTurn>)) => {
        turns = turns.map((turn) =>
          turn.id === answer.id ? { ...turn, ...(typeof change === "function" ? change(turn) : change) } : turn,
        );
        if (get().conversationId === conversationId) set({ turns });
      };

      let changed = false;
      try {
        const response = await fetch("/api/ai/chat", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", ...bearerHeader() },
          body: JSON.stringify({
            provider: model.provider,
            model: model.model,
            messages: history,
            ...(profileId ? { profileId } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error || t("El servidor respondió {0}.", { 0: response.status }));
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
            if (!line) continue;
            const event = JSON.parse(line) as
              | { type: "tool"; event: ToolChip & { changed?: boolean } }
              | { type: "text"; text: string }
              | { type: "error"; message: string }
              | { type: "done"; changed: boolean };
            if (event.type === "tool") {
              if (event.event.changed) changed = true;
              patch((turn) => ({
                tools: [...(turn.tools ?? []), { label: event.event.label, ok: event.event.ok, docId: event.event.docId }],
              }));
            } else if (event.type === "text") patch((turn) => ({ content: turn.content + event.text }));
            else if (event.type === "error") patch({ error: event.message });
            else if (event.type === "done") changed = changed || event.changed;
          }
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        patch({ error: aborted ? t("Detenido.") : error instanceof Error ? error.message : t("No se pudo enviar.") });
      } finally {
        patch({ pending: false });
        if (get().controller === controller) set({ busy: false, controller: null });
        void persist(conversationId, turns);
        // La IA cambió la bóveda en el servidor: traer los cambios ya.
        if (changed) void syncVault(userId);
      }
    },
  };
});
