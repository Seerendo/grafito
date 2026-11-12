import { useEffect, useRef, type MutableRefObject } from "react";
import type { Graph } from "@cosmos.gl/graph";
import { graphClickIntent, type GraphNode } from "@/domain/vault/graph";
import type { NodeAnalysis } from "@/domain/graph-pack";
import { communityPalette, readPaint, type Paint, type Rgba } from "./graph-paint";
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

const SHAPE = { markdown: 0, file: 1, portfolio: 3 } as const;
const STYLE: Record<GraphKind, number> = { wiki: 0, referencia: 1, llama: 2 };
/** Most labels drawn at once; more would only overlap. */
const MAX_LABELS = 300;
/** Layout steps computed before a mostly new graph is first shown. */
const PRE_STEPS = 220;

export function GraphGpu({
  nodes,
  edges,
  signature,
  activeId,
  apiRef,
  onZoom,
  onInspect,
  onOpen,
  analysis,
  path,
  marked,
  onPathTo,
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
  /** Community and importance per document; empty to draw every node alike. */
  analysis: Map<string, NodeAnalysis>;
  /** A chain of documents to highlight, from the active one; null for none. */
  path: string[] | null;
  /** Documents to highlight without a path (orphans or bridges); null for none. */
  marked: string[] | null;
  /** Shift+click picks the other end of a path. */
  onPathTo: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  const graphRef = useRef<Graph | null>(null);
  // Values the cosmos.gl callbacks read, kept current without rebuilding the graph.
  const live = useRef({
    nodes,
    edges,
    /** The latest props: load() copies them in, even when cosmos.gl loads after they changed. */
    next: { nodes, edges },
    /** Where each document was last placed, kept across Todo, Entorno and Camino. */
    memory: new Map<string, [number, number]>(),
    dragging: undefined as number | undefined,
    index: new Map<string, number>(),
    activeId,
    hover: undefined as number | undefined,
    neighbours: new Set<number>(),
    paint: null as Paint | null,
    transform: { k: 1, x: 0, y: 0 },
    draggedAt: 0,
    /** The person zoomed or panned: the camera stops following the layout. */
    steered: false,
    lastClick: null as { id: string; at: number } | null,
    onZoom,
    onInspect,
    onOpen,
    analysis,
    clusterKey: "",
    path: null as string[] | null,
    marked: null as string[] | null,
    onPathTo,
    drawLabels: () => undefined as void,
  });
  live.current.next = { nodes, edges };
  live.current.onZoom = onZoom;
  live.current.onInspect = onInspect;
  live.current.onOpen = onOpen;
  live.current.analysis = analysis;
  live.current.path = path;
  live.current.marked = marked;
  live.current.onPathTo = onPathTo;

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
        const marks = markedIndices();
        const wanted = [
          ...state.neighbours,
          ...pathIndices(),
          // A few marked documents get a label each; many would only overlap.
          ...(marks.length <= 60 ? marks : []),
        ];
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
        linkDefaultWidth: 1.6,
        linkDashLength: 6,
        linkDashGap: 4,
        renderHoveredPointRing: true,
        hoveredPointRingColor: paint.accent,
        focusedPointRingColor: paint.accent,
        pointGreyoutOpacity: 0.25,
        linkGreyoutOpacity: 0.12,
        enableDrag: true,
        fitViewOnInit: false,
        // Data changes snap; motion comes from the layout alone.
        transitionDuration: 0,
        simulationGravity: 0.1,
        simulationRepulsion: 1.6,
        simulationLinkSpring: 0.6,
        simulationLinkDistance: 30,
        simulationFriction: 0.85,
        simulationDecay: reduced ? 1000 : 4000,
        onSimulationTick: () => drawLabels(),
        // One gentle framing once it settles, unless the person moved the camera meanwhile.
        onSimulationEnd: () => {
          remember(graph);
          if (!state.steered) frameView(graph, reduced ? 0 : 900);
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
        onDragStart: () => {
          state.dragging = state.hover;
          state.steered = true;
          // A settled layout is paused; dragging needs it running to move the node.
          if (!graph.isSimulationRunning) graph.start(0.12);
        },
        onDragEnd: () => {
          state.draggedAt = Date.now();
          // A dragged node stays where it was dropped, as before.
          if (state.dragging !== undefined) graph.setPinnedPoint(state.dragging, true);
          state.dragging = undefined;
        },
        onPointClick: (index, _position, event) => {
          const node = state.nodes[index];
          if (!node) return;
          if (event.shiftKey) {
            state.onPathTo(node.id);
            return;
          }
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
    const palette = communityPalette();
    state.nodes.forEach((node, index) => {
      const found = state.analysis.get(node.id);
      // The largest communities get a colour each; the rest stay neutral.
      const tint =
        found && found.community >= 0 && found.community < palette.length
          ? palette[found.community]!
          : paint.elevated;
      const fill = index === active ? paint.accent : tint;
      colors.set(fill, index * 4);
      // Shared targets have a fainter border.
      const stroke =
        index === active
          ? paint.accent
          : node.shared
            ? ([paint.faint[0], paint.faint[1], paint.faint[2], 0.45] as Rgba)
            : paint.faint;
      strokes.set(stroke, index * 4);
      // Importance (PageRank, 0–1000) grows the node; without it every node is alike.
      const base = found ? 9 + 15 * Math.sqrt(found.rank / 1000) : node.pinned ? 15 : 12;
      sizes[index] = index === active ? Math.max(20, base + 4) : base;
    });
    // A path greys out the rest and draws its links in the accent colour.
    const steps = new Set<string>();
    const chain = state.path;
    if (chain) {
      for (let at = 1; at < chain.length; at += 1) {
        steps.add(`${chain[at - 1]}|${chain[at]}`);
        steps.add(`${chain[at]}|${chain[at - 1]}`);
      }
    }
    const pathLinks: number[] = [];
    const linkColors = new Float32Array(state.edges.length * 4);
    state.edges.forEach((edge, index) => {
      const step = steps.has(`${edge.from}|${edge.to}`);
      if (step) pathLinks.push(index);
      const hot = step || (!chain && (edge.from === state.activeId || edge.to === state.activeId));
      linkColors.set(hot ? paint.accent : paint.line, index * 4);
    });
    graph.setPointColors(colors);
    graph.setPointStrokeColors(strokes);
    graph.setPointSizes(sizes);
    graph.setLinkColors(linkColors);
    graph.setConfigPartial({
      focusedPointIndex: active,
      // A path wins over orphans or bridges.
      highlightedPointIndices: chain ? pathIndices() : state.marked ? markedIndices() : undefined,
      highlightedLinkIndices: chain ? pathLinks : state.marked ? [] : undefined,
    });
    graph.render();
    state.drawLabels();
  }

  /** Indices of the marked documents shown here. */
  function markedIndices(): number[] {
    const state = live.current;
    return (state.marked ?? [])
      .map((id) => state.index.get(id))
      .filter((index): index is number => index !== undefined);
  }

  /** Indices of the documents on the highlighted path. */
  function pathIndices(): number[] {
    const state = live.current;
    return (state.path ?? [])
      .map((id) => state.index.get(id))
      .filter((index): index is number => index !== undefined);
  }

  /**
   * Nodes of one community pull together in the layout, so each group sits apart and not only
   * in its own colour. Without communities (or with them turned off) there is no such force.
   * Returns whether the groups changed since the last call.
   */
  function applyClusters(graph: Graph): boolean {
    const state = live.current;
    const clusters = state.nodes.map((node) => {
      const community = state.analysis.get(node.id)?.community;
      return community !== undefined && community >= 0 ? community : undefined;
    });
    const key = clusters.map((value) => value ?? "").join(",");
    if (key === state.clusterKey) return false;
    state.clusterKey = key;
    const clustered = clusters.some((value) => value !== undefined);
    graph.setPointClusters(clustered ? clusters : []);
    graph.setConfigPartial({ simulationCluster: clustered ? 0.25 : 0 });
    return true;
  }

  /** New nodes or links: keep known positions, place new nodes around the centre. */
  function remember(graph: Graph) {
    const state = live.current;
    // A small view (Entorno, a short path) has its own layout; keeping it would misplace those
    // documents when the whole graph comes back.
    if (state.index.size === 0 || state.index.size < state.memory.size * 0.5) return;
    const positions = graph.getPointPositions();
    for (const [id, index] of state.index) {
      const x = positions[index * 2];
      const y = positions[index * 2 + 1];
      if (x !== undefined && y !== undefined && Number.isFinite(x)) state.memory.set(id, [x, y]);
    }
  }

  function load(graph: Graph) {
    const state = live.current;
    remember(graph);
    const previous = state.memory;
    const { nodes, edges } = state.next;
    state.nodes = nodes;
    state.edges = edges;
    state.index = new Map(nodes.map((node, index) => [node.id, index]));
    const unknown = nodes.filter((node) => !previous.has(node.id)).length;
    // Mostly new documents: lay them out before showing them.
    const fresh = unknown > nodes.length * 0.3;
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
    graph.setPointPositions(positions, true);
    graph.setPointShapes(shapes);
    graph.setLinks(links.subarray(0, at * 2));
    graph.setLinkStyles(styles.subarray(0, at));
    neighboursOf(state.activeId);
    applyClusters(graph);
    paintGraph(graph);
    graph.render(fresh ? 1 : 0.15, 0);
    // Settle most of the layout on the GPU before the first frame, so it is not watched
    // shrinking and the camera frames it once.
    if (fresh) for (let step = 0; step < PRE_STEPS; step += 1) graph.step();
    frameView(graph, 0);
    graph.start(fresh ? 0.25 : 0.15);
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

  // A path was found or cleared: highlight it and frame it.
  const pathKey = path?.join(",") ?? "";
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    paintGraph(graph);
    const indices = pathIndices();
    if (indices.length > 1) {
      live.current.steered = true;
      graph.fitViewByPointIndices(indices, 500, 0.25);
    }
    // paintGraph and its helpers read the live values; these effects run on what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey]);

  // Orphans or bridges were marked or cleared: highlight them and frame them.
  const markedKey = marked?.join(",") ?? "";
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    paintGraph(graph);
    const indices = markedIndices();
    if (indices.length > 0 && !live.current.path) {
      live.current.steered = true;
      graph.fitViewByPointIndices(indices, 500, 0.2);
    }
    // paintGraph and its helpers read the live values; these effects run on what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markedKey]);

  // Communities and importance arrived or were turned on or off.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const moved = applyClusters(graph);
    paintGraph(graph);
    if (!moved) return;
    // The groups move together: let the layout settle again, following it as before.
    live.current.steered = false;
    graph.start(0.4);
    // paintGraph and its helpers read the live values; these effects run on what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  // Selection: recolour and keep the labels of the new neighbourhood.
  useEffect(() => {
    live.current.activeId = activeId;
    const graph = graphRef.current;
    if (!graph) return;
    neighboursOf(activeId);
    paintGraph(graph);
    // paintGraph and its helpers read the live values; these effects run on what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
