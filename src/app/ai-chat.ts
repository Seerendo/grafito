import { create } from "zustand";
import type { AiProviderId } from "@/domain/ai";
import { bearerHeader } from "@/lib/auth/bearer";
import { syncVault } from "@/app/vault/sync";

/**
 * Estado del chat de IA (cliente): abierto o cerrado, modelo elegido y la
 * conversación. La conversación vive en la pestaña (sessionStorage); el modelo
 * elegido se recuerda en el navegador por usuario.
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

type ChatState = {
  userId: string | null;
  open: boolean;
  turns: ChatTurn[];
  model: ModelRef | null;
  busy: boolean;
  controller: AbortController | null;
  bind: (userId: string) => void;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setModel: (model: ModelRef | null) => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
};

const MODEL_KEY = "grafito.ai.model:";
const TURNS_KEY = "grafito.ai.turns:";

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

export const useAiChat = create<ChatState>((set, get) => ({
  userId: null,
  open: false,
  turns: [],
  model: null,
  busy: false,
  controller: null,

  bind: (userId) => {
    if (get().userId === userId) return;
    set({
      userId,
      turns: load<ChatTurn[]>(session, TURNS_KEY + userId, []).filter((turn) => !turn.pending),
      model: load<ModelRef | null>(local, MODEL_KEY + userId, null),
    });
  },

  setOpen: (open) => set({ open }),
  toggle: () => set({ open: !get().open }),

  setModel: (model) => {
    const userId = get().userId;
    if (userId) save(local, MODEL_KEY + userId, model);
    set({ model });
  },

  clear: () => {
    get().controller?.abort();
    const userId = get().userId;
    if (userId) save(session, TURNS_KEY + userId, null);
    set({ turns: [], busy: false, controller: null });
  },

  stop: () => get().controller?.abort(),

  send: async (text) => {
    const { model, userId, busy } = get();
    const content = text.trim();
    if (!model || !userId || busy || !content) return;
    const userTurn: ChatTurn = { id: crypto.randomUUID(), role: "user", content };
    const answer: ChatTurn = { id: crypto.randomUUID(), role: "assistant", content: "", tools: [], pending: true };
    const history = [...get().turns, userTurn]
      .filter((turn) => !turn.error && turn.content)
      .slice(-30)
      .map((turn) => ({ role: turn.role, content: turn.content }));
    const controller = new AbortController();
    set({ turns: [...get().turns, userTurn, answer], busy: true, controller });

    const patch = (change: Partial<ChatTurn> | ((turn: ChatTurn) => Partial<ChatTurn>)) =>
      set({
        turns: get().turns.map((turn) =>
          turn.id === answer.id ? { ...turn, ...(typeof change === "function" ? change(turn) : change) } : turn,
        ),
      });

    let changed = false;
    try {
      const response = await fetch("/api/ai/chat", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", ...bearerHeader() },
        body: JSON.stringify({ provider: model.provider, model: model.model, messages: history }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `El servidor respondió ${response.status}.`);
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
      patch({ error: aborted ? "Detenido." : error instanceof Error ? error.message : "No se pudo enviar." });
    } finally {
      patch({ pending: false });
      set({ busy: false, controller: null });
      save(session, TURNS_KEY + userId, get().turns);
      // La IA cambió la bóveda en el servidor: traer los cambios ya.
      if (changed) void syncVault(userId);
    }
  },
}));
