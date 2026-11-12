import { useEffect, useRef, type MutableRefObject } from "react";
import type { Graph } from "@cosmos.gl/graph";
import { graphClickIntent, type GraphNode } from "@/domain/vault/graph";
import type { GraphKind } from "@/domain/vault/types";
import { t } from "@/app/i18n";

/**
 * The graph on the GPU (cosmos.gl, WebGL2): the force layout and the drawing of points and links
 * run in shaders, so tens of thousands of nodes stay fluid. Labels are drawn on a 2D canvas on
 * top, only for the points cosmos.gl samples on screen plus the active node and its neighbours.
 */

export type GraphApi = {
  zoom: (factor: number) => void;
  fit: () => void;
  focus: () => void;
  reveal: () => void;
  pan: (dx: number, dy: number) => void;
};

type Edge = { from: string; to: string; kind: GraphKind };

type Paint = {
  accent: Rgba;
  fg: Rgba;
  muted: string;
  faint: Rgba;
  line: Rgba;
  elevated: Rgba;
  ink: string;
  accentText: string;
};

type Rgba = [number, number, number, number];

const SHAPE = { markdown: 0, file: 1, portfolio: 3 } as const;
const STYLE: Record<GraphKind, number> = { wiki: 0, referencia: 1, llama: 2 };
/** Most labels drawn at once; more would only overlap. */
const MAX_LABELS = 300;

function cssColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Any CSS color as RGBA floats, read back through a 2D context. */
function rgba(color: string, alpha = 1): Rgba {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return [1, 1, 1, alpha];
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  const value = String(probe.fillStyle);
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      alpha,
    ];
  }
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255, 1];
  return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, (parts[3] ?? 1) * alpha];
}

function readPaint(): Paint {
  const accent = cssColor("--color-accent", "#e0a14a");
  return {
    accent: rgba(accent),
    fg: rgba(cssColor("--color-fg", "#f3eee6")),
    muted: cssColor("--color-muted", "#a89b8c"),
    faint: rgba(cssColor("--color-faint", "#746a5e")),
    line: rgba(cssColor("--color-line", "#3a342c"), 0.85),
    elevated: rgba(cssColor("--color-elevated", "#26231d")),
    ink: cssColor("--color-accent-fg", "#1c1408"),
    accentText: accent,
  };
}

export function GraphGpu({
  nodes,
  edges,
  signature,
  activeId,
  apiRef,
  onZoom,
  onInspect,
  onOpen,
}: {
  nodes: GraphNode[];
  edges: Edge[];
  /** Changes when the visible nodes, links or the layout seed change. */
  signature: string;
  activeId: string | null;
  apiRef: MutableRefObject<GraphApi>;
  onZoom: (percent: number) => void;
  onInspect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<Graph | null>(null);
  // Values the cosmos.gl callbacks read, kept current without rebuilding the graph.
  const live = useRef({
    nodes,
    edges,
    index: new Map<string, number>(),
    activeId,
    hover: undefined as number | undefined,
    neighbours: new Set<number>(),
    paint: null as Paint | null,
    transform: { k: 1, x: 0, y: 0 },
    draggedAt: 0,
    /** The person zoomed or panned: the camera stops following the layout. */
    steered: false,
    followedAt: 0,
    lastClick: null as { id: string; at: number } | null,
    onZoom,
    onInspect,
    onOpen,
    drawLabels: () => undefined as void,
  });
  live.current.onZoom = onZoom;
  live.current.onInspect = onInspect;
  live.current.onOpen = onOpen;

  // One cosmos.gl instance for the life of the view.
  useEffect(() => {
    const host = hostRef.current;
    const labels = labelsRef.current;
    if (!host || !labels) return;
    let cancelled = false;
    let frame = 0;
    const state = live.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const drawLabels = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const graph = graphRef.current;
        const context = labels.getContext("2d");
        if (!graph || !context) return;
        const rect = labels.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (labels.width !== Math.round(rect.width * dpr))
          labels.width = Math.round(rect.width * dpr);
        if (labels.height !== Math.round(rect.height * dpr))
          labels.height = Math.round(rect.height * dpr);
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        const paint = state.paint ?? readPaint();
        const shown = new Map<number, [number, number]>();
        const sampled = graph.getSampledPointPositionsMap({ nonBlocking: true });
        for (const [index, position] of sampled) {
          if (shown.size >= MAX_LABELS) break;
          shown.set(index, position);
        }
        // The active node, its neighbours and the hovered node always get a label.
        const wanted = [...state.neighbours];
        if (state.hover !== undefined) wanted.push(state.hover);
        if (wanted.length > 0) {
          graph.trackPointPositionsByIndices(wanted);
          for (const [index, position] of graph.getTrackedPointPositionsMap({
            nonBlocking: true,
          })) {
            shown.set(index, position);
          }
        }
        const active = state.activeId ? state.index.get(state.activeId) : undefined;
        context.font = "12px Outfit, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "top";
        for (const [index, position] of shown) {
          const node = state.nodes[index];
          if (!node) continue;
          const [x, y] = graph.spaceToScreenPosition(position);
          if (x < -80 || y < -40 || x > rect.width + 80 || y > rect.height + 40) continue;
          const radius = graph.spaceToScreenRadius((graph.getPointRadiusByIndex(index) ?? 5) / 1);
          const label =
            node.title.length > 28 ? t("{0}…", { 0: node.title.slice(0, 26) }) : node.title;
          const top = y + Math.max(6, radius) + 4;
          if (index === active) {
            const width = context.measureText(label).width + 12;
            context.fillStyle = paint.accentText;
            context.beginPath();
            context.roundRect(x - width / 2, top - 2, width, 18, 6);
            context.fill();
            context.fillStyle = paint.ink;
          } else {
            context.fillStyle = paint.muted;
          }
          context.fillText(label, x, top);
        }
      });
    };
    state.drawLabels = drawLabels;

    void import("@cosmos.gl/graph").then(({ Graph }) => {
      if (cancelled) return;
      state.paint = readPaint();
      const paint = state.paint;
      const graph = new Graph(host, {
        backgroundColor: [0, 0, 0, 0],
        spaceSize: 8192,
        pointDefaultSize: 10,
        scalePointsOnZoom: false,
        pointDefaultColor: paint.elevated,
        pointDefaultStrokeColor: paint.faint,
        pointDefaultStrokeWidth: 1.5,
        linkDefaultColor: paint.line,
        linkDefaultWidth: 1,
        linkDashLength: 6,
        linkDashGap: 4,
        renderHoveredPointRing: true,
        hoveredPointRingColor: paint.accent,
        focusedPointRingColor: paint.accent,
        pointGreyoutOpacity: 0.25,
        linkGreyoutOpacity: 0.12,
        enableDrag: true,
        fitViewOnInit: false,
        transitionDuration: reduced ? 0 : 300,
        simulationGravity: 0.1,
        simulationRepulsion: 1.6,
        simulationLinkSpring: 0.6,
        simulationLinkDistance: 30,
        simulationFriction: 0.85,
        simulationDecay: reduced ? 1000 : 4000,
        // While the layout settles the camera follows it, as the 2D graph did, until the person
        // zooms or pans.
        onSimulationTick: () => {
          if (!state.steered && Date.now() - state.followedAt > 500) {
            state.followedAt = Date.now();
            frameView(graph, 450);
          }
          drawLabels();
        },
        onSimulationEnd: () => {
          if (!state.steered) frameView(graph, 450);
          drawLabels();
        },
        onTransition: () => drawLabels(),
        onZoomStart: (_event, userDriven) => {
          if (userDriven) state.steered = true;
        },
        onZoom: (event) => {
          const { k, x, y } = event.transform;
          state.transform = { k, x, y };
          state.onZoom(Math.round(k * 100));
          drawLabels();
        },
        onPointMouseOver: (index) => {
          state.hover = index;
          host.style.cursor = "pointer";
          drawLabels();
        },
        onPointMouseOut: () => {
          state.hover = undefined;
          host.style.cursor = "";
          drawLabels();
        },
        onDragEnd: () => {
          state.draggedAt = Date.now();
          // A dragged node stays where it was dropped, as before.
          if (state.hover !== undefined) graph.setPinnedPoint(state.hover, true);
        },
        onPointClick: (index) => {
          const node = state.nodes[index];
          if (!node) return;
          const moved = Date.now() - state.draggedAt < 250;
          const intent = graphClickIntent(state.lastClick, node.id, Date.now(), moved);
          if (intent === "open") {
            state.lastClick = null;
            state.onOpen(node.id);
          } else if (intent === "inspect") {
            state.lastClick = { id: node.id, at: Date.now() };
            state.onInspect(node.id);
          }
        },
      });
      graphRef.current = graph;
      load(graph);
    });

    const observer = new ResizeObserver(() => drawLabels());
    observer.observe(host);
    // A theme change recolours the graph.
    const themes = new MutationObserver(() => {
      state.paint = readPaint();
      const graph = graphRef.current;
      if (graph) paintGraph(graph);
    });
    themes.observe(document.documentElement, { attributes: true });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      themes.disconnect();
      graphRef.current?.destroy();
      graphRef.current = null;
    };
    // The instance lives as long as the view; data changes go through load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The active node and its neighbours, or the whole graph without one. */
  function frameView(graph: Graph, duration: number) {
    const around = neighboursOf(live.current.activeId);
    if (around.length > 1) graph.fitViewByPointIndices(around, duration, 0.3);
    else graph.fitView(duration, 0.12);
  }

  /** Colours that depend on the active node: it and its links stand out. */
  function paintGraph(graph: Graph) {
    const state = live.current;
    const paint = state.paint ?? readPaint();
    const active = state.activeId ? state.index.get(state.activeId) : undefined;
    const colors = new Float32Array(state.nodes.length * 4);
    const strokes = new Float32Array(state.nodes.length * 4);
    const sizes = new Float32Array(state.nodes.length);
    state.nodes.forEach((node, index) => {
      const fill = index === active ? paint.accent : paint.elevated;
      colors.set(fill, index * 4);
      // Shared targets have a fainter border.
      const stroke =
        index === active
          ? paint.accent
          : node.shared
            ? ([paint.faint[0], paint.faint[1], paint.faint[2], 0.45] as Rgba)
            : paint.faint;
      strokes.set(stroke, index * 4);
      sizes[index] = index === active ? 20 : node.pinned ? 15 : 12;
    });
    const linkColors = new Float32Array(state.edges.length * 4);
    state.edges.forEach((edge, index) => {
      const hot = edge.from === state.activeId || edge.to === state.activeId;
      linkColors.set(hot ? paint.accent : paint.line, index * 4);
    });
    graph.setPointColors(colors);
    graph.setPointStrokeColors(strokes);
    graph.setPointSizes(sizes);
    graph.setLinkColors(linkColors);
    graph.setConfigPartial({ focusedPointIndex: active });
    graph.render();
    state.drawLabels();
  }

  /** New nodes or links: keep known positions, place new nodes around the centre. */
  function load(graph: Graph) {
    const state = live.current;
    const previous = new Map<string, [number, number]>();
    if (state.index.size > 0) {
      const positions = graph.getPointPositions();
      for (const [id, index] of state.index) {
        const x = positions[index * 2];
        const y = positions[index * 2 + 1];
        if (x !== undefined && y !== undefined && Number.isFinite(x)) previous.set(id, [x, y]);
      }
    }
    state.nodes = nodes;
    state.edges = edges;
    state.index = new Map(nodes.map((node, index) => [node.id, index]));
    const fresh = previous.size === 0;
    const center = 4096;
    const spread = Math.max(200, Math.sqrt(nodes.length) * 40);
    const positions = new Float32Array(nodes.length * 2);
    const shapes = new Float32Array(nodes.length);
    nodes.forEach((node, index) => {
      const known = previous.get(node.id);
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * spread;
      positions[index * 2] = known?.[0] ?? center + Math.cos(angle) * distance;
      positions[index * 2 + 1] = known?.[1] ?? center + Math.sin(angle) * distance;
      shapes[index] = SHAPE[node.kind];
    });
    const links = new Float32Array(edges.length * 2);
    const styles = new Float32Array(edges.length);
    let at = 0;
    for (const edge of edges) {
      const from = state.index.get(edge.from);
      const to = state.index.get(edge.to);
      if (from === undefined || to === undefined) continue;
      links[at * 2] = from;
      links[at * 2 + 1] = to;
      styles[at] = STYLE[edge.kind];
      at += 1;
    }
    state.steered = false;
    graph.setPinnedPoints(null);
    graph.setPointPositions(positions, !fresh);
    graph.setPointShapes(shapes);
    graph.setLinks(links.subarray(0, at * 2));
    graph.setLinkStyles(styles.subarray(0, at));
    neighboursOf(state.activeId);
    paintGraph(graph);
    graph.start(fresh ? 1 : 0.3);
  }

  function neighboursOf(id: string | null) {
    const state = live.current;
    const set = new Set<number>();
    const self = id ? state.index.get(id) : undefined;
    if (self !== undefined && graphRef.current) {
      set.add(self);
      for (const index of graphRef.current.getNeighboringPointIndices(self)) set.add(index);
    }
    state.neighbours = set;
    return [...set];
  }

  // Data: new nodes or links, or Reacomodar.
  useEffect(() => {
    const graph = graphRef.current;
    if (graph) load(graph);
    // load reads the current nodes and edges; signature says when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Selection: recolour and keep the labels of the new neighbourhood.
  useEffect(() => {
    live.current.activeId = activeId;
    const graph = graphRef.current;
    if (!graph) return;
    neighboursOf(activeId);
    paintGraph(graph);
  }, [activeId]);

  apiRef.current = {
    zoom(factor) {
      live.current.steered = true;
      const graph = graphRef.current;
      if (graph) graph.setZoomLevel(graph.getZoomLevel() * factor, 200);
    },
    fit() {
      live.current.steered = true;
      graphRef.current?.fitView(400, 0.12);
    },
    focus() {
      const graph = graphRef.current;
      if (!graph) return;
      const around = neighboursOf(live.current.activeId);
      if (around.length > 0) graph.fitViewByPointIndices(around, 400, 0.3);
      else graph.fitView(400, 0.15);
    },
    reveal() {
      const graph = graphRef.current;
      const around = neighboursOf(live.current.activeId);
      if (graph && around.length > 0) graph.fitViewByPointIndices(around, 400, 0.3);
    },
    pan(dx, dy) {
      live.current.steered = true;
      const graph = graphRef.current;
      if (!graph) return;
      const { k, x, y } = live.current.transform;
      graph.setViewTransform({ k, x: x + dx, y: y + dy });
      live.current.drawLabels();
    },
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={hostRef}
        aria-label={t("Grafo de documentos")}
        className="absolute inset-0 cursor-grab touch-none"
      />
      <canvas ref={labelsRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}
