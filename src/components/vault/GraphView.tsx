import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { GraphGpu, type GraphApi } from "./GraphGpu";
import { Graph3d } from "./Graph3d";
import { gpuGraphSupported } from "@/app/webgl";
import type { NodeAnalysis } from "@/domain/graph-pack";
import { Locate, Minus, Plus, X } from "lucide-react";
import {
  graphClickIntent,
  neighbourhood,
  shortestPath,
  type GraphNode,
} from "@/domain/vault/graph";
import { useGraphEdges, vaultVersion, type GraphScope } from "@/app/graph";
import { sharedTarget, useSharedTrees } from "@/app/shared-links";
import { useSharedView } from "@/app/shared-view";
import { extractHeadings, extractWikiLinks } from "@/domain/vault/links";
import type { Document, GraphKind, Portfolio } from "@/domain/vault/types";
import { useVault } from "@/app/vault/store";
import { t } from "@/app/i18n";
import { linkKey } from "@/domain/vault/anchor";

type SimNode = {
  id: string;
  title: string;
  pinned: boolean;
  kind: "markdown" | "file" | "portfolio";
  shared: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
};

type Edge = { from: string; to: string; kind: GraphKind };
type Camera = { x: number; y: number; k: number };
type Target = { x: number; y: number; k: number };

const MIN_K = 0.22;
const MAX_K = 3.2;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readColor(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Graph source defaults to the owned vault; shared views supply read-only documents. */
export type GraphSource = {
  /** Source label displayed beside the graph title, such as workspace or shared content. */
  name?: string;
  documents: Document[];
  portfolios: Portfolio[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Where the links come from: a share or a public link. */
  scope: GraphScope;
  /** Changes when the shown content changes, so the links are asked again. */
  version: string;
};

export function GraphView({
  onOpenNote,
  source,
}: {
  onOpenNote: (id: string) => void;
  source?: GraphSource;
}) {
  const ownDocuments = useVault((state) => state.documents);
  const ownPortfolios = useVault((state) => state.portfolios);
  const ownActiveId = useVault((state) => state.activeId);
  const ownSelect = useVault((state) => state.selectInGraph);
  const trees = useSharedTrees((state) => state.trees);
  // Owned-vault graphs also include linked portfolios and linked shared targets.
  // Built once per change of the vault: zooming re-renders this view many times a second.
  const extras = useMemo(
    () => (source ? new Map<string, Extra>() : graphExtras(ownDocuments, ownPortfolios, trees)),
    [source, ownDocuments, ownPortfolios, trees],
  );
  const documents: GraphNode[] = useMemo(
    () =>
      source?.documents ?? [...ownDocuments, ...[...extras.values()].map((extra) => extra.node)],
    [source?.documents, ownDocuments, extras],
  );
  const activeId = source ? source.activeId : ownActiveId;
  const extrasRef = useRef(extras);
  extrasRef.current = extras;
  const selectInGraph = (id: string) => {
    if (source) source.onSelect(id);
    else if (!extrasRef.current.has(id)) ownSelect(id);
  };
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(activeId);
  // Open portfolios on their page and shared targets in their viewer.
  const openNode = (id: string) => {
    const extra = extrasRef.current.get(id);
    if (!extra) return onOpenNote(id);
    if (extra.open) extra.open();
  };
  const openRef = useRef(openNode);
  const selectRef = useRef(selectInGraph);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, k: 1 });
  const apiRef = useRef<GraphApi>({
    zoom: () => undefined,
    fit: () => undefined,
    focus: () => undefined,
    reveal: () => undefined,
    pan: () => undefined,
  });
  activeRef.current = activeId;
  openRef.current = openNode;
  selectRef.current = selectInGraph;
  const [local, setLocal] = useState(false);
  // How many links away "Entorno" reaches.
  const [depth, setDepth] = useState(1);
  // The other end of a path from the active node, and whether the path bar is open.
  const [pathTo, setPathTo] = useState<string | null>(null);
  const [pathOpen, setPathOpen] = useState(false);
  // Highlight documents without links, or the ones joining groups.
  const [mark, setMark] = useState<"orphans" | "bridges" | null>(null);
  // The GPU draws the graph when the browser has WebGL2; the 2D canvas otherwise.
  const [gpu] = useState(gpuGraphSupported);
  // The 3D view, remembered in this browser.
  const [depth3d, setDepth3d] = useState(readThree);
  const toggleThree = () => {
    setDepth3d((value) => {
      try {
        localStorage.setItem(THREE_KEY, value ? "0" : "1");
      } catch {
        // Private windows may refuse storage; the choice still applies now.
      }
      return !value;
    });
  };
  // Colour by community and size by importance, remembered in this browser.
  const [tint, setTint] = useState(readTint);
  const toggleTint = () => {
    setTint((value) => {
      try {
        localStorage.setItem(TINT_KEY, value ? "0" : "1");
      } catch {
        // Private windows may refuse storage; the choice still applies now.
      }
      return !value;
    });
  };
  const [seed, setSeed] = useState(0);
  const [zoom, setZoom] = useState(100);

  // Links come from Grafeno; only those between nodes shown here are drawn.
  const { edges: links, analysis } = useGraphEdges(
    source?.scope ?? {},
    source ? source.version : vaultVersion(ownDocuments, ownPortfolios),
    true,
  );
  const edges: Edge[] = useMemo(() => {
    const nodeIds = new Set(documents.map((node) => node.id));
    return links
      .filter((link) => nodeIds.has(link.from) && nodeIds.has(link.to))
      .map(({ from, to, kind }) => ({ from, to, kind }));
  }, [documents, links]);

  // The shortest chain of links from the active node to the chosen one, over every link.
  const path = useMemo(
    () =>
      activeId && pathTo && activeId !== pathTo ? shortestPath(edges, activeId, pathTo) : null,
    [edges, activeId, pathTo],
  );

  // Documents without any link, in or out (portfolios and shared targets only show with one).
  const orphans = useMemo(() => {
    const linked = new Set<string>();
    for (const edge of edges) {
      linked.add(edge.from);
      linked.add(edge.to);
    }
    return documents
      .filter((node) => node.kind !== "portfolio" && !node.shared && !linked.has(node.id))
      .map((node) => node.id);
  }, [documents, edges]);

  // The documents that join groups most (Grafeno's betweenness): the top 2 %, from 3 to 50.
  const bridges = useMemo(() => {
    const scored = documents
      .map((node) => ({ id: node.id, score: analysis.get(node.id)?.bridge ?? 0 }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const keep = Math.min(50, Math.max(3, Math.round(documents.length * 0.02)));
    return scored.slice(0, keep).map((item) => item.id);
  }, [documents, analysis]);

  const marked = mark === "orphans" ? orphans : mark === "bridges" ? bridges : null;

  // Only "Entorno" depends on the active node; "Todo" keeps its layout when it changes.
  const focusId = local ? activeId : null;
  const pathKey = local && path ? path.join(",") : "";
  const { visibleNotes, visibleEdges, signature } = useMemo(() => {
    const neighborIds = focusId ? neighbourhood(edges, focusId, depth) : new Set<string>();
    // A path stays whole in "Entorno", however far it goes.
    if (pathKey) for (const id of pathKey.split(",")) neighborIds.add(id);
    const notes = local ? documents.filter((note) => neighborIds.has(note.id)) : documents;
    const ids = new Set(notes.map((note) => note.id));
    const shown = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return {
      visibleNotes: notes,
      visibleEdges: shown,
      signature: `${notes.map((note) => note.id).join(",")}|${shown
        .map((edge) => `${edge.kind}:${edge.from}-${edge.to}`)
        .join(",")}|${seed}`,
    };
  }, [documents, edges, focusId, local, seed, depth, pathKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = stageRef.current;
    if (!canvas || !parent) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const readPaint = () => ({
      accent: readColor("--color-accent", "#e0a14a"),
      fg: readColor("--color-fg", "#f3eee6"),
      muted: readColor("--color-muted", "#a89b8c"),
      faint: readColor("--color-faint", "#746a5e"),
      line: readColor("--color-line", "#3a342c"),
      elevated: readColor("--color-elevated", "#26231d"),
      ink: readColor("--color-accent-fg", "#1c1408"),
    });

    let width = 0;
    let height = 0;
    let nodes: SimNode[] = [];
    let frame = 0;
    let raf = 0;
    let running = false;
    let locked = false;
    let followId: string | null = null;
    let fly: Target | null = null;
    let dragId: string | null = null;
    let panning = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    const hoverId = { current: null as string | null };
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; cx: number; cy: number } | null = null;

    const publish = () => {
      const next = Math.round(cameraRef.current.k * 100);
      setZoom((prev) => (prev === next ? prev : next));
    };

    const place = () => {
      const count = Math.max(visibleNotes.length, 1);
      nodes = visibleNotes.map((note, index) => {
        const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
        const radius = Math.min(width, height) * 0.32 || 160;
        return {
          id: note.id,
          title: note.title,
          pinned: note.pinned,
          kind: note.kind,
          shared: Boolean(note.shared),
          x: width / 2 + Math.cos(angle) * radius,
          y: height / 2 + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          fixed: false,
        };
      });
      frame = 0;
    };

    const measure = () => {
      const rect = parent.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };

    const toWorld = (sx: number, sy: number) => {
      const cam = cameraRef.current;
      return {
        x: cam.x + (sx - width / 2) / cam.k,
        y: cam.y + (sy - height / 2) / cam.k,
      };
    };

    const point = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const bounds = (list: SimNode[]): Target => {
      if (list.length === 0 || width === 0 || height === 0) {
        return { x: width / 2, y: height / 2, k: 1 };
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of list) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x);
        maxY = Math.max(maxY, node.y);
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const bw = Math.max(180, maxX - minX + 220);
      const bh = Math.max(160, maxY - minY + 180);
      const k = clamp(Math.min((width * 0.78) / bw, (height * 0.7) / bh), MIN_K, 1.7);
      const bias = width >= 960 ? 150 : 0;
      return { x: cx + bias / k, y: cy, k };
    };

    const cluster = (id: string) => {
      const ids = new Set<string>([id]);
      for (const edge of visibleEdges) {
        if (edge.from === id) ids.add(edge.to);
        if (edge.to === id) ids.add(edge.from);
      }
      const list = nodes.filter((node) => ids.has(node.id));
      return list.length > 0 ? list : nodes;
    };

    const zoomAt = (sx: number, sy: number, nextK: number) => {
      const cam = cameraRef.current;
      const k = clamp(nextK, MIN_K, MAX_K);
      const wx = cam.x + (sx - width / 2) / cam.k;
      const wy = cam.y + (sy - height / 2) / cam.k;
      cam.k = k;
      cam.x = wx - (sx - width / 2) / k;
      cam.y = wy - (sy - height / 2) / k;
    };

    const kick = () => {
      if (width > 0) draw();
      start();
    };

    apiRef.current = {
      zoom(factor) {
        locked = true;
        fly = null;
        const cam = cameraRef.current;
        cam.k = clamp(cam.k * factor, MIN_K, MAX_K);
        publish();
        kick();
      },
      fit() {
        locked = true;
        fly = bounds(nodes);
        kick();
      },
      focus() {
        locked = true;
        const id = activeRef.current;
        followId = id;
        fly = bounds(id ? cluster(id) : nodes);
        kick();
      },
      reveal() {
        followId = null;
        kick();
      },
      pan(dx, dy) {
        locked = true;
        fly = null;
        const cam = cameraRef.current;
        cam.x -= dx / cam.k;
        cam.y -= dy / cam.k;
        kick();
      },
    };

    const step = () => {
      const list = nodes;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]!;
          const b = list[j]!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          if (dist < 1) {
            dx = 1;
            dy = 0;
            dist = 1;
          }
          const force = 4200 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!a.fixed) {
            a.vx += fx;
            a.vy += fy;
          }
          if (!b.fixed) {
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }
      const byId = new Map(list.map((node) => [node.id, node]));
      for (const edge of visibleEdges) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const force = (dist - 150) * 0.012;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.fixed) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!b.fixed) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      const originX = width / 2 || 0;
      const originY = height / 2 || 0;
      for (const node of list) {
        if (node.fixed) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx += (originX - node.x) * 0.008;
        node.vy += (originY - node.y) * 0.008;
        node.vx *= 0.78;
        node.vy *= 0.78;
        node.x += node.vx;
        node.y += node.vy;
      }
    };

    const draw = () => {
      const { accent, muted, faint, line, elevated, ink } = readPaint();
      const cam = cameraRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.save();
      context.translate(width / 2, height / 2);
      context.scale(cam.k, cam.k);
      context.translate(-cam.x, -cam.y);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const edge of visibleEdges) {
        const a = byId.get(edge.from);
        const b = byId.get(edge.to);
        if (!a || !b) continue;
        const hot = a.id === activeRef.current || b.id === activeRef.current;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.strokeStyle = hot ? accent : line;
        context.globalAlpha = hot ? 0.9 : 0.7;
        context.lineWidth = (hot ? 1.6 : 1) / cam.k;
        context.setLineDash(
          edge.kind === "referencia"
            ? [6 / cam.k, 4 / cam.k]
            : edge.kind === "llama"
              ? [2 / cam.k, 3 / cam.k]
              : [],
        );
        context.stroke();
        context.setLineDash([]);
        context.globalAlpha = 1;
      }
      const showQuietLabels = cam.k >= 0.5;
      for (const node of nodes) {
        const active = node.id === activeRef.current;
        const radius = (active ? 11 : node.pinned ? 8 : 6.5) / cam.k;
        context.beginPath();
        if (node.kind === "file") {
          roundRect(context, node.x - radius, node.y - radius, radius * 2, radius * 2, 3 / cam.k);
        } else if (node.kind === "portfolio") {
          // A diamond represents an entire portfolio.
          const r = radius * 1.35;
          context.moveTo(node.x, node.y - r);
          context.lineTo(node.x + r, node.y);
          context.lineTo(node.x, node.y + r);
          context.lineTo(node.x - r, node.y);
          context.closePath();
        } else {
          context.arc(node.x, node.y, radius, 0, Math.PI * 2);
        }
        context.fillStyle = active ? accent : elevated;
        context.fill();
        context.lineWidth = 1.5 / cam.k;
        context.strokeStyle = active || node.id === hoverId.current ? accent : faint;
        // Shared targets use a dashed border.
        if (node.shared) context.setLineDash([3 / cam.k, 2 / cam.k]);
        context.stroke();
        context.setLineDash([]);
        if (!active && !showQuietLabels) continue;
        const label =
          node.title.length > 28 ? t("{0}…", { 0: node.title.slice(0, 26) }) : node.title;
        context.font = `${12 / cam.k}px Outfit, sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "top";
        const metrics = context.measureText(label);
        if (active) {
          context.fillStyle = accent;
          roundRect(
            context,
            node.x - metrics.width / 2 - 6 / cam.k,
            node.y + radius + 6 / cam.k,
            metrics.width + 12 / cam.k,
            18 / cam.k,
            6 / cam.k,
          );
          context.fill();
          context.fillStyle = ink;
        } else {
          context.fillStyle = muted;
        }
        context.fillText(label, node.x, node.y + radius + 8 / cam.k);
      }
      context.restore();
    };

    const ease = (target: Target) => {
      const cam = cameraRef.current;
      if (reduced) {
        cam.x = target.x;
        cam.y = target.y;
        cam.k = target.k;
        return true;
      }
      cam.x += (target.x - cam.x) * 0.16;
      cam.y += (target.y - cam.y) * 0.16;
      cam.k += (target.k - cam.k) * 0.16;
      return (
        Math.hypot(target.x - cam.x, target.y - cam.y) < 0.8 && Math.abs(target.k - cam.k) < 0.01
      );
    };

    const tick = () => {
      const id = activeRef.current;
      if (id !== followId) {
        followId = id;
        if (id) fly = bounds(cluster(id));
      } else if (fly && !locked && id) {
        fly = bounds(cluster(id));
      }
      const settling = frame < (reduced ? 1 : 180) || dragId !== null;
      if (settling && width > 0) step();
      if (!locked && !fly && frame < 240 && width > 0) {
        const list = id ? cluster(id) : nodes;
        if (ease(bounds(list))) locked = frame > 200;
      }
      if (fly) {
        if (ease(fly)) {
          cameraRef.current.x = fly.x;
          cameraRef.current.y = fly.y;
          cameraRef.current.k = fly.k;
          fly = null;
        }
        publish();
      }
      if (width > 0) draw();
      frame += 1;
      const hot = settling || fly !== null || (!locked && frame < 240) || panning || pinch !== null;
      if (hot) raf = requestAnimationFrame(tick);
      else running = false;
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    const hit = (sx: number, sy: number) => {
      const world = toWorld(sx, sy);
      const cam = cameraRef.current;
      const reach = 18 / cam.k;
      return (
        nodes.find((node) => (node.x - world.x) ** 2 + (node.y - world.y) ** 2 < reach ** 2) ?? null
      );
    };

    const pinchOf = () => {
      const items = [...pointers.values()];
      const a = items[0];
      const b = items[1];
      if (!a || !b) return null;
      return {
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      parent.focus({ preventScroll: true });
      const at = point(event);
      pointers.set(event.pointerId, at);
      if (pointers.size >= 2) {
        dragId = null;
        panning = false;
        pinch = pinchOf();
        locked = true;
        fly = null;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      const node = event.button === 1 ? null : hit(at.x, at.y);
      moved = false;
      lastX = at.x;
      lastY = at.y;
      if (node) {
        dragId = node.id;
        panning = false;
      } else {
        dragId = null;
        panning = true;
      }
      canvas.setPointerCapture(event.pointerId);
      frame = 0;
      start();
    };

    const onMove = (event: PointerEvent) => {
      const at = point(event);
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, at);
      if (pointers.size >= 2 && pinch) {
        const next = pinchOf();
        if (!next) return;
        const cam = cameraRef.current;
        const k0 = cam.k;
        const k1 = clamp(k0 * (next.dist / pinch.dist), MIN_K, MAX_K);
        const worldX = cam.x + (pinch.cx - width / 2) / k0;
        const worldY = cam.y + (pinch.cy - height / 2) / k0;
        cam.k = k1;
        cam.x = worldX - (next.cx - width / 2) / k1;
        cam.y = worldY - (next.cy - height / 2) / k1;
        pinch = next;
        locked = true;
        fly = null;
        publish();
        if (!running) draw();
        return;
      }
      if (!dragId && !panning) {
        const node = hit(at.x, at.y);
        hoverId.current = node?.id ?? null;
        canvas.style.cursor = node ? "pointer" : "";
        if (!running) draw();
        return;
      }
      const dx = at.x - lastX;
      const dy = at.y - lastY;
      if (dx * dx + dy * dy > 9) moved = true;
      lastX = at.x;
      lastY = at.y;
      if (panning) {
        locked = true;
        fly = null;
        const cam = cameraRef.current;
        cam.x -= dx / cam.k;
        cam.y -= dy / cam.k;
        canvas.style.cursor = "grabbing";
        if (!running) draw();
        return;
      }
      const node = nodes.find((item) => item.id === dragId);
      if (!node) return;
      if (moved) node.fixed = true;
      const world = toWorld(at.x, at.y);
      node.x = world.x;
      node.y = world.y;
      node.vx = 0;
      node.vy = 0;
    };

    const lastClick = { current: null as { id: string; at: number } | null };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      const picked = dragId;
      const wasPan = panning;
      const didMove = moved;
      dragId = null;
      panning = false;
      canvas.style.cursor = "";
      if (picked && pointers.size === 0) {
        const intent = graphClickIntent(lastClick.current, picked, Date.now(), didMove);
        if (intent === "open") {
          lastClick.current = null;
          openRef.current(picked);
        } else if (intent === "inspect") {
          lastClick.current = { id: picked, at: Date.now() };
          skipReveal.current = true;
          selectRef.current(picked);
        }
      } else if (wasPan && !didMove) {
        lastClick.current = null;
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      publish();
    };

    const onLeave = () => {
      hoverId.current = null;
      if (!running && width > 0) draw();
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      locked = true;
      fly = null;
      const at = point(event);
      const pinchZoom = event.ctrlKey || event.metaKey;
      const coarse =
        event.deltaMode !== 0 || (Math.abs(event.deltaY) >= 40 && Math.abs(event.deltaX) < 8);
      if (pinchZoom || coarse) {
        const factor = Math.exp(-event.deltaY * (pinchZoom ? 0.012 : 0.0016));
        zoomAt(at.x, at.y, cameraRef.current.k * factor);
      } else {
        const cam = cameraRef.current;
        cam.x += event.deltaX / cam.k;
        cam.y += event.deltaY / cam.k;
      }
      publish();
      kick();
    };

    measure();
    place();
    if (width > 0) {
      const id = activeRef.current;
      const target = bounds(id ? cluster(id) : nodes);
      cameraRef.current.x = target.x;
      cameraRef.current.y = target.y;
      cameraRef.current.k = target.k;
      followId = id;
      publish();
    }
    start();

    const observer = new ResizeObserver(() => {
      const previous = nodes.map((node) => ({ ...node }));
      const laid = previous.some((node) => node.x !== 0 || node.y !== 0);
      measure();
      if (laid && previous.length === visibleNotes.length && width > 0) nodes = previous;
      else place();
      frame = Math.min(frame, 120);
      start();
    });
    observer.observe(parent);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
    // signature names the visible nodes and edges; rebuilding the simulation on any other
    // render would reset the layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, []);

  const revealed = useRef<string | null | undefined>(undefined);
  const skipReveal = useRef(false);
  useEffect(() => {
    if (revealed.current === undefined) {
      revealed.current = activeId;
      return;
    }
    if (revealed.current === activeId) return;
    revealed.current = activeId;
    if (skipReveal.current) {
      skipReveal.current = false;
      return;
    }
    apiRef.current.reveal();
  }, [activeId]);

  const onStageKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (key === "+" || key === "=") {
      event.preventDefault();
      apiRef.current.zoom(1.15);
    } else if (key === "-" || key === "_") {
      event.preventDefault();
      apiRef.current.zoom(1 / 1.15);
    } else if (key === "0") {
      event.preventDefault();
      apiRef.current.fit();
    } else if (key === "ArrowLeft") {
      event.preventDefault();
      apiRef.current.pan(48, 0);
    } else if (key === "ArrowRight") {
      event.preventDefault();
      apiRef.current.pan(-48, 0);
    } else if (key === "ArrowUp") {
      event.preventDefault();
      apiRef.current.pan(0, 48);
    } else if (key === "ArrowDown") {
      event.preventDefault();
      apiRef.current.pan(0, -48);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="font-serif text-xl">
            {t("Grafo")}
            {source?.name ? <span className="text-muted"> · {source.name}</span> : null}
          </h2>
          <p className="text-xs text-faint">
            {visibleNotes.length} {t("documentos ·")} {visibleEdges.length} {t("vínculos")}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setLocal(false)}
            className={`h-10 rounded-md px-3 text-sm ${local ? "text-muted hover:bg-elevated" : "bg-elevated text-fg"}`}
          >
            {t("Todo")}
          </button>
          <button
            type="button"
            onClick={() => setLocal(true)}
            className={`h-10 rounded-md px-3 text-sm ${local ? "bg-elevated text-fg" : "text-muted hover:bg-elevated"}`}
          >
            {t("Entorno")}
          </button>
          {local ? (
            <div
              role="group"
              aria-label={t("Niveles del entorno")}
              className="flex rounded-md border border-line"
            >
              {[1, 2, 3].map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={depth === level}
                  onClick={() => setDepth(level)}
                  className={`h-10 w-9 text-sm ${depth === level ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
                >
                  {level}
                </button>
              ))}
            </div>
          ) : null}
          {activeId ? (
            <button
              type="button"
              aria-pressed={pathOpen}
              onClick={() => {
                setPathOpen((open) => !open);
                setPathTo(null);
              }}
              className={`h-10 rounded-md px-3 text-sm ${pathOpen ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"}`}
            >
              {t("Camino")}
            </button>
          ) : null}
          {gpu ? (
            <div
              role="group"
              aria-label={t("Resaltar")}
              className="flex rounded-md border border-line"
            >
              <button
                type="button"
                aria-pressed={mark === "orphans"}
                onClick={() => setMark((value) => (value === "orphans" ? null : "orphans"))}
                className={`h-10 px-3 text-sm ${mark === "orphans" ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
              >
                {t("Huérfanas")} <span className="text-faint">{orphans.length}</span>
              </button>
              {bridges.length > 0 ? (
                <button
                  type="button"
                  aria-pressed={mark === "bridges"}
                  onClick={() => setMark((value) => (value === "bridges" ? null : "bridges"))}
                  className={`h-10 px-3 text-sm ${mark === "bridges" ? "bg-elevated text-fg" : "text-muted hover:text-fg"}`}
                >
                  {t("Puentes")} <span className="text-faint">{bridges.length}</span>
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex items-center rounded-md border border-line">
            <button
              type="button"
              aria-label={t("Alejar")}
              onClick={() => apiRef.current.zoom(1 / 1.2)}
              className="grid h-10 w-10 place-items-center text-muted hover:text-fg"
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              aria-label={t("Encajar el grafo")}
              onClick={() => apiRef.current.fit()}
              className="h-10 min-w-12 px-1 text-xs text-muted hover:text-fg"
            >
              {zoom}%
            </button>
            <button
              type="button"
              aria-label={t("Acercar")}
              onClick={() => apiRef.current.zoom(1.2)}
              className="grid h-10 w-10 place-items-center text-muted hover:text-fg"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              aria-label={t("Ir al documento seleccionado")}
              onClick={() => apiRef.current.focus()}
              className="grid h-10 w-10 place-items-center text-muted hover:text-fg"
            >
              <Locate className="size-4" />
            </button>
          </div>
          {gpu && analysis.size > 0 ? (
            <button
              type="button"
              aria-pressed={tint}
              onClick={toggleTint}
              className={`h-10 rounded-md px-3 text-sm ${tint ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"}`}
            >
              {t("Comunidades")}
            </button>
          ) : null}
          {gpu ? (
            <button
              type="button"
              aria-pressed={depth3d}
              onClick={toggleThree}
              className={`h-10 rounded-md px-3 text-sm ${depth3d ? "bg-elevated text-fg" : "text-muted hover:bg-elevated hover:text-fg"}`}
            >
              3D
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSeed((value) => value + 1)}
            className="h-10 rounded-md px-3 text-sm text-muted hover:bg-elevated hover:text-fg"
          >
            {t("Reacomodar")}
          </button>
        </div>
      </div>
      {pathOpen && activeId ? (
        <PathBar
          documents={documents}
          fromId={activeId}
          toId={pathTo}
          path={path}
          onPick={setPathTo}
          onOpen={(id) => selectInGraph(id)}
          onClose={() => {
            setPathOpen(false);
            setPathTo(null);
          }}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <NodeCard source={source} />
        <div
          ref={stageRef}
          tabIndex={0}
          onKeyDown={onStageKey}
          className="relative min-h-0 flex-1 outline-none select-none"
        >
          {gpu && depth3d ? (
            <Graph3d
              nodes={visibleNotes}
              edges={visibleEdges}
              signature={signature}
              activeId={activeId}
              apiRef={apiRef}
              onZoom={(percent) => setZoom((prev) => (prev === percent ? prev : percent))}
              onInspect={(id) => {
                skipReveal.current = true;
                selectRef.current(id);
              }}
              onOpen={(id) => openRef.current(id)}
              analysis={tint ? analysis : NO_TINT}
              path={path}
              marked={marked}
              onPathTo={(id) => {
                setPathOpen(true);
                setPathTo(id);
              }}
            />
          ) : gpu ? (
            <GraphGpu
              nodes={visibleNotes}
              edges={visibleEdges}
              signature={signature}
              activeId={activeId}
              apiRef={apiRef}
              onZoom={(percent) => setZoom((prev) => (prev === percent ? prev : percent))}
              onInspect={(id) => {
                skipReveal.current = true;
                selectRef.current(id);
              }}
              onOpen={(id) => openRef.current(id)}
              analysis={tint ? analysis : NO_TINT}
              path={path}
              marked={marked}
              onPathTo={(id) => {
                setPathOpen(true);
                setPathTo(id);
              }}
            />
          ) : (
            <canvas
              ref={canvasRef}
              aria-label={t("Grafo de documentos")}
              className="h-full w-full cursor-grab touch-none"
            />
          )}
        </div>
      </div>
    </div>
  );
}

type Extra = { node: GraphNode; open?: () => void };

const MAX_MATCHES = 8;

/** From the active node to one chosen by title (or Shift+click in the graph), and the result. */
function PathBar({
  documents,
  fromId,
  toId,
  path,
  onPick,
  onOpen,
  onClose,
}: {
  documents: GraphNode[];
  fromId: string;
  toId: string | null;
  path: string[] | null;
  onPick: (id: string | null) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(documents.map((node) => [node.id, node])), [documents]);
  const from = byId.get(fromId);
  const to = toId ? byId.get(toId) : undefined;
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? documents
        .filter((node) => node.id !== fromId && node.title.toLowerCase().includes(needle))
        .slice(0, MAX_MATCHES)
    : [];
  return (
    <div className="relative shrink-0 border-b border-line px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">{t("Desde")}</span>
        <span className="max-w-48 truncate text-fg">{from?.title ?? ""}</span>
        <span className="text-muted">{t("hasta")}</span>
        <input
          value={to && !query ? to.title : query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (toId) onPick(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              onPick(matches[0].id);
              setQuery("");
            } else if (event.key === "Escape") onClose();
          }}
          aria-label={t("Documento de destino")}
          placeholder={t("Título, o Mayús+clic en el grafo")}
          className="h-9 min-w-56 flex-1 rounded-md border border-line bg-surface px-2 text-fg outline-none focus:border-accent"
        />
        <button
          type="button"
          aria-label={t("Cerrar camino")}
          onClick={onClose}
          className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>
      {matches.length > 0 ? (
        <ul
          role="listbox"
          className="absolute top-full right-3 left-3 z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-xl"
        >
          {matches.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPick(node.id);
                  setQuery("");
                }}
                className="w-full truncate rounded px-2 py-1.5 text-left hover:bg-elevated"
              >
                {node.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {to ? (
        path ? (
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-xs">
            {path.map((id, index) => (
              <li key={id} className="flex items-center gap-1">
                {index > 0 ? <span className="text-faint">→</span> : null}
                <button
                  type="button"
                  onClick={() => onOpen(id)}
                  className="max-w-48 truncate rounded px-1.5 py-0.5 text-fg hover:bg-elevated"
                >
                  {byId.get(id)?.title ?? id}
                </button>
              </li>
            ))}
            <li className="text-faint">· {t("{0} saltos", { 0: path.length - 1 })}</li>
          </ol>
        ) : (
          <p className="mt-2 text-xs text-muted">
            {t("No hay vínculos que unan estos documentos.")}
          </p>
        )
      ) : null}
    </div>
  );
}

const TINT_KEY = "grafito.graph.communities";
const THREE_KEY = "grafito.graph.3d";

function readThree(): boolean {
  try {
    return localStorage.getItem(THREE_KEY) === "1";
  } catch {
    return false;
  }
}
const NO_TINT = new Map<string, NodeAnalysis>();

function readTint(): boolean {
  try {
    return localStorage.getItem(TINT_KEY) !== "0";
  } catch {
    return true;
  }
}

/**
 * Extra owned-vault graph nodes: portfolios with incoming/outgoing links and visible shared
 * targets referenced by links.
 */
function graphExtras(
  documents: Document[],
  portfolios: Portfolio[],
  trees: ReturnType<typeof useSharedTrees.getState>["trees"],
): Map<string, Extra> {
  const out = new Map<string, Extra>();
  const links = [
    ...documents.flatMap((document) => document.links),
    ...portfolios.flatMap((portfolio) => portfolio.links ?? []),
  ];
  const portfolioNode = (portfolio: Portfolio): Extra => ({
    node: {
      id: portfolio.id,
      title: portfolio.name,
      kind: "portfolio",
      content: "",
      links: portfolio.links ?? [],
      pinned: false,
    },
    open: () => useVault.getState().openPortfolio(portfolio.id),
  });
  for (const portfolio of portfolios) {
    if ((portfolio.links ?? []).length > 0) out.set(portfolio.id, portfolioNode(portfolio));
  }
  for (const link of links) {
    if (out.has(link.targetId)) continue;
    if (link.shareId) {
      const found = sharedTarget(trees, link);
      if (!found) continue;
      out.set(link.targetId, {
        node: {
          id: link.targetId,
          title: `${found.title} · ${found.ownerName}`,
          kind: found.kind,
          content: "",
          links: [],
          pinned: false,
          shared: true,
        },
        open: () => {
          useVault.getState().setGraph(false);
          useSharedView
            .getState()
            .openShared(found.tree, found.kind === "portfolio" ? null : link.targetId);
        },
      });
    } else if (link.target === "portfolio") {
      const portfolio = portfolios.find((item) => item.id === link.targetId);
      if (portfolio) out.set(portfolio.id, portfolioNode(portfolio));
    }
  }
  return out;
}

function NodeCard({ source }: { source?: GraphSource }) {
  const ownDocuments = useVault((state) => state.documents);
  const ownPortfolios = useVault((state) => state.portfolios);
  const ownActiveId = useVault((state) => state.activeId);
  const documents = source?.documents ?? ownDocuments;
  const portfolios = source?.portfolios ?? ownPortfolios;
  const activeId = source ? source.activeId : ownActiveId;
  const document = documents.find((item) => item.id === activeId) ?? null;
  if (!document) return null;
  const portfolio =
    portfolios.find((item) => item.id === document.portfolioId)?.name ?? t("Carpeta Personal");
  const headings = document.kind === "markdown" ? extractHeadings(document.content) : [];
  const wikis = document.kind === "markdown" ? extractWikiLinks(document.content) : [];
  return (
    <aside
      data-ui="inspector"
      data-graph-inspector
      className="max-h-52 overflow-y-auto border-b border-line bg-surface px-4 py-3 md:absolute md:top-3 md:right-3 md:z-10 md:max-h-96 md:w-72 md:border"
    >
      <p className="text-xs text-faint">
        {document.kind === "file" ? t("Archivo") : t("Nota")} · {portfolio}
      </p>
      <h3 className="mt-1 font-serif text-xl leading-tight">{document.title}</h3>
      <h4 className="mt-3 text-xs font-medium tracking-widest text-faint uppercase">
        {t("Esquema")}
      </h4>
      {headings.length === 0 ? (
        document.kind === "file" ? null : (
          <p className="mt-1 text-sm text-muted">{t("Sin encabezados")}</p>
        )
      ) : (
        <ul className="mt-1">
          {headings.map((heading) => (
            <li
              key={heading.id}
              className={`truncate py-1 text-sm text-fg ${
                heading.level <= 1
                  ? ""
                  : heading.level === 2
                    ? "pl-3"
                    : heading.level === 3
                      ? "pl-6"
                      : "pl-9"
              }`}
            >
              {heading.text}
            </li>
          ))}
        </ul>
      )}
      {wikis.length > 0 || document.links.length > 0 ? (
        <>
          <h4 className="mt-3 text-xs font-medium tracking-widest text-faint uppercase">
            {t("Vínculos")}
          </h4>
          <ul className="mt-1 text-sm text-muted">
            {wikis.map((title) => (
              <li key={`w-${title}`} className="truncate py-0.5">
                {t("Wiki ·")} {title}
              </li>
            ))}
            {document.links.map((link) => {
              const target = documents.find((item) => item.id === link.targetId);
              const label = link.kind === "llama" ? t("Invoca") : t("Referencia");
              return (
                <li key={`${link.kind}-${linkKey(link)}`} className="truncate py-0.5">
                  {t(label)} · {target?.title ?? t("sin destino")}
                  {link.anchor ? ` · «${link.anchor.exact}»` : ""}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </aside>
  );
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
