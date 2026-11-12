import { useEffect, useState, useSyncExternalStore } from "react";
import { usePluginEnabled } from "@/app/plugins";
import { PERMISSION } from "@/domain/permissions";
import type { GraphEdge, ManualKind } from "@/domain/vault/types";
import type { TextAnchor } from "@/domain/vault/anchor";
import { graphEdges, graphIncoming, graphState, publicGraph } from "@/server/graph.functions";
import { usePermissions } from "@/app/permissions";
import { unpackAnalysis, unpackEdges, type NodeAnalysis } from "@/domain/graph-pack";

/**
 * The graph and mentions come from Grafeno through the server. While the Grafo plugin is paused,
 * or Grafeno is not configured or not answering, the graph is off: its button, view and mentions
 * hide, and the rest of Grafito works as usual.
 */

export type GraphScope = { shareId?: string; token?: string };

export type GraphLink = GraphEdge & { shareId?: string; target?: "portfolio" };

export type IncomingLink = {
  source: string;
  kind: "wiki" | ManualKind;
  anchor?: TextAnchor;
};

const CHECK_MS = 60_000;
/** Server copies a write within about a second; ask again after that. */
const SETTLE_MS = 2_000;

let online: boolean | null = null;
let checkedAt = 0;
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (online === next) return;
  online = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ask the server whether the graph is usable, at most once a minute. */
export function refreshGraphState(force = false): Promise<void> {
  if (!force && Date.now() - checkedAt < CHECK_MS && online !== null) return Promise.resolve();
  checking ??= graphState()
    .then((state) => publish(state.available))
    .catch(() => publish(false))
    .finally(() => {
      checkedAt = Date.now();
      checking = null;
    });
  return checking;
}

/** A read reported the graph off (paused, or Grafeno stopped answering). */
function reportOff() {
  checkedAt = Date.now();
  publish(false);
}

/** Whether the signed-in person can see the graph and mentions now. */
export function useGraphAvailable(active = true): boolean {
  const plugin = usePluginEnabled("grafo");
  const can = usePermissions();
  const state = useSyncExternalStore(
    subscribe,
    () => online,
    () => null,
  );
  useEffect(() => {
    if (!active) return;
    void refreshGraphState();
    const onFocus = () => void refreshGraphState();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refreshGraphState(), CHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [active]);
  // Turning the Grafo plugin back on shows the graph at once: ask the server again instead of
  // waiting for the next minute's check (turning it off already hides it through the flag).
  useEffect(() => {
    if (active && plugin) void refreshGraphState(true);
  }, [active, plugin]);
  return active && plugin && can(PERMISSION.graphView) && state === true;
}

type EdgeResult = {
  off: boolean;
  ready: boolean;
  edges: GraphLink[];
  /** Community and importance per document, once Grafeno has analysed the vault. */
  analysis: Map<string, NodeAnalysis>;
};

const NO_ANALYSIS = new Map<string, NodeAnalysis>();

async function fetchEdges(scope: GraphScope): Promise<EdgeResult> {
  const result = scope.token
    ? await publicGraph({ data: { token: scope.token } })
    : await graphEdges({ data: scope.shareId ? { shareId: scope.shareId } : {} });
  if (!result.ok) return { off: result.off, ready: false, edges: [], analysis: NO_ANALYSIS };
  return {
    off: false,
    ready: result.ready,
    edges: unpackEdges(result.edges),
    analysis: unpackAnalysis(result.analysis),
  };
}

/**
 * Links of a vault, a share or a public link. version changes when the visible content changes
 * (the client's vault revision, a share's tree); the links are asked again shortly after.
 */
export function useGraphEdges(
  scope: GraphScope,
  version: string,
  enabled: boolean,
): {
  edges: GraphLink[];
  analysis: Map<string, NodeAnalysis>;
  loading: boolean;
  ready: boolean;
} {
  const [state, setState] = useState<{ key: string; result: EdgeResult } | null>(null);
  const key = `${scope.token ?? ""}|${scope.shareId ?? ""}`;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      fetchEdges(scope)
        .then((result) => {
          if (cancelled) return;
          if (result.off) {
            if (scope.token) setPublic(scope.token, false);
            else reportOff();
          }
          setState({ key, result });
          // A vault still being copied into Grafeno fills in shortly.
          if (!result.off && !result.ready) timer = window.setTimeout(load, SETTLE_MS * 2);
        })
        .catch(() => undefined);
    let timer = window.setTimeout(load, state?.key === key ? SETTLE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // scope is read through key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, enabled]);
  const current = state?.key === key ? state.result : null;
  return {
    edges: current?.edges ?? [],
    analysis: current?.analysis ?? NO_ANALYSIS,
    loading: enabled && current === null,
    ready: current?.ready ?? false,
  };
}

/** What links to a document, and documents worth linking to it (most suggested first). */
export type DocumentGraph = { items: IncomingLink[]; related: string[] };

/** What links to a document, asked again when version changes. */
export function useIncomingLinks(
  target: { id: string; kind?: "doc" | "portfolio" } | null,
  scope: GraphScope,
  version: string,
  enabled: boolean,
): DocumentGraph | null {
  const [state, setState] = useState<({ key: string } & DocumentGraph) | null>(null);
  const key = target
    ? `${target.kind ?? "doc"}:${target.id}|${scope.token ?? ""}|${scope.shareId ?? ""}`
    : "";
  useEffect(() => {
    if (!enabled || !target) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        const request = scope.token
          ? publicGraph({ data: { token: scope.token, id: target.id } })
          : graphIncoming({
              data: {
                id: target.id,
                kind: target.kind ?? "doc",
                ...(scope.shareId ? { shareId: scope.shareId } : {}),
              },
            });
        void request
          .then((result) => {
            if (cancelled) return;
            if (!result.ok) {
              if (result.off) {
                if (scope.token) setPublic(scope.token, false);
                else reportOff();
              }
              setState({ key, items: [], related: [] });
              return;
            }
            setState({
              key,
              items: result.items as IncomingLink[],
              related: result.related.map((row) => row.id),
            });
          })
          .catch(() => undefined);
      },
      state?.key === key ? SETTLE_MS : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // target and scope are read through key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, enabled]);
  return state?.key === key ? { items: state.items, related: state.related } : null;
}

/** Public links' graph state: shared by every component of the page, asked again regularly. */
const PUBLIC_MS = 30_000;
const publicState = new Map<string, boolean>();
const publicAsked = new Map<string, number>();
const publicListeners = new Set<() => void>();

function setPublic(token: string, available: boolean) {
  if (publicState.get(token) === available) return;
  publicState.set(token, available);
  for (const listener of publicListeners) listener();
}

function askPublic(token: string) {
  // Several components ask at once; one request serves them.
  if (Date.now() - (publicAsked.get(token) ?? 0) < 2_000) return;
  publicAsked.set(token, Date.now());
  void publicGraph({ data: { token } })
    .then((result) => setPublic(token, result.ok))
    .catch(() => setPublic(token, false));
}

/**
 * Whether a public link's graph is usable; public pages have no session to ask with. Asked again
 * every 30 s and when the page comes back to the front, so pausing the Grafo plugin also hides
 * it from pages already open.
 */
export function usePublicGraph(token: string | undefined): boolean {
  const available = useSyncExternalStore(
    (listener) => {
      publicListeners.add(listener);
      return () => publicListeners.delete(listener);
    },
    () => (token ? (publicState.get(token) ?? false) : false),
    () => false,
  );
  useEffect(() => {
    if (!token) return;
    askPublic(token);
    const onFocus = () => askPublic(token);
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => askPublic(token), PUBLIC_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [token]);
  return available;
}

/** Changes when the vault's content or links change; asks the graph again shortly after. */
export function vaultVersion(
  documents: readonly { updatedAt: number; links: readonly unknown[] }[],
  portfolios: readonly { links?: readonly unknown[] }[],
): string {
  let latest = 0;
  let links = 0;
  for (const document of documents) {
    if (document.updatedAt > latest) latest = document.updatedAt;
    links += document.links.length;
  }
  for (const portfolio of portfolios) links += portfolio.links?.length ?? 0;
  return `${documents.length}:${latest}:${portfolios.length}:${links}`;
}

/** Changes when a shared tree's documents or the reader's view of it change. */
export function treeVersion(tree: {
  share: { id: string; view?: string };
  documents: readonly { id: string; updatedAt: string; links?: readonly unknown[] }[];
  portfolios: readonly unknown[];
}): string {
  let latest = "";
  let links = 0;
  for (const document of tree.documents) {
    if (document.updatedAt > latest) latest = document.updatedAt;
    links += document.links?.length ?? 0;
  }
  return `${tree.share.id}:${tree.share.view ?? ""}:${tree.documents.length}:${tree.portfolios.length}:${latest}:${links}`;
}
