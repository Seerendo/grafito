import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type * as Three from "three";
import type { OrbitControls as Orbit } from "three/examples/jsm/controls/OrbitControls.js";
import { graphClickIntent, type GraphNode } from "@/domain/vault/graph";
import type { GraphKind } from "@/domain/vault/types";
import type { NodeAnalysis } from "@/domain/graph-pack";
import { t } from "@/app/i18n";
import type { GraphApi } from "./GraphGpu";
import { communityPalette, cssColor, readPaint, rgba, type Paint, type Rgba } from "./graph-paint";
import type { LayoutIn, LayoutOut } from "./graph3d.worker";

/**
 * The graph in 3D (three.js, WebGL). The force layout runs in a worker (graph3d.worker.ts) and
 * groups each community in its own region of space. Notes are spheres, files cubes and
 * portfolios octahedra, each kind one instanced mesh; every link is one segment of a single
 * line geometry, so a large vault is a handful of draw calls. Drag to orbit, right-drag or
 * Shift+drag to pan, wheel to zoom.
 */

type Edge = { from: string; to: string; kind: GraphKind };

const KINDS = ["markdown", "file", "portfolio"] as const;
/** Most labels drawn at once. */
const MAX_LABELS = 120;
/** How much a dimmed node or link keeps of its colour. */
const DIM = 0.22;

export function Graph3d({
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
  signature: string;
  activeId: string | null;
  apiRef: MutableRefObject<GraphApi>;
  onZoom: (percent: number) => void;
  onInspect: (id: string) => void;
  onOpen: (id: string) => void;
  analysis: Map<string, NodeAnalysis>;
  path: string[] | null;
  marked: string[] | null;
  onPathTo: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLCanvasElement>(null);
  // The 3D code is fetched when first shown; after a new version is deployed an open tab can no
  // longer fetch it, and only reloading helps.
  const [failed, setFailed] = useState(false);
  const live = useRef({
    nodes,
    edges,
    activeId,
    analysis,
    path,
    marked,
    onZoom,
    onInspect,
    onOpen,
    onPathTo,
    index: new Map<string, number>(),
    positions: new Float32Array(0) as Float32Array,
    hover: -1,
    steered: false,
    followedAt: 0,
    lastClick: null as { id: string; at: number } | null,
    /** Set by the scene once it exists. */
    load: () => undefined as void,
    paint: () => undefined as void,
    frame: (_ids: string[] | null, _duration: number) => undefined as void,
    camera: {
      zoom: (_factor: number) => undefined as void,
      pan: (_dx: number, _dy: number) => undefined as void,
    },
    clusters: (_communities: Int32Array) => undefined as void,
  });
  const state = live.current;
  state.nodes = nodes;
  state.edges = edges;
  state.activeId = activeId;
  state.analysis = analysis;
  state.path = path;
  state.marked = marked;
  state.onZoom = onZoom;
  state.onInspect = onInspect;
  state.onOpen = onOpen;
  state.onPathTo = onPathTo;

  useEffect(() => {
    const host = hostRef.current;
    const labels = labelsRef.current;
    if (!host || !labels) return;
    let cancelled = false;
    let teardown = () => undefined as void;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    void Promise.all([import("three"), import("three/examples/jsm/controls/OrbitControls.js")])
      .then(([THREE, { OrbitControls }]) => {
        if (cancelled) return;
        teardown = buildScene(THREE, OrbitControls, host, labels, reduced);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      teardown();
    };
    // One scene for the life of the view; data changes go through state.load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The scene, its worker and its handlers; returns how to take it all down. */
  function buildScene(
    THREE: typeof Three,
    OrbitControls: typeof Orbit,
    host: HTMLDivElement,
    labels: HTMLCanvasElement,
    reduced: boolean,
  ): () => void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 200_000);
    camera.position.set(0, 0, 900);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reduced;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(1, 1.2, 1.5);
    scene.add(sun);

    const geometries = {
      markdown: new THREE.SphereGeometry(1, 14, 10),
      file: new THREE.BoxGeometry(1.5, 1.5, 1.5),
      portfolio: new THREE.OctahedronGeometry(1.45),
    };
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    let meshes: { mesh: Three.InstancedMesh; nodes: number[] }[] = [];
    /** Where each node is: its mesh and instance. */
    let slots: { mesh: number; instance: number }[] = [];
    const lineGeometry = new THREE.BufferGeometry();
    const lineMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
    });
    const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
    scene.add(lines);
    let linkEnds = new Int32Array(0);
    let sizes = new Float32Array(0);

    const worker = new Worker(new URL("./graph3d.worker.ts", import.meta.url), {
      type: "module",
    });
    let dirty = true;
    let raf = 0;
    let referenceDistance = 900;
    let fly: {
      from: Three.Vector3;
      to: Three.Vector3;
      target0: Three.Vector3;
      target1: Three.Vector3;
      start: number;
      duration: number;
    } | null = null;

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const paintColors = () => {
      const paint: Paint = readPaint();
      const background = rgba(cssColor("--color-bg", "#141210"));
      const palette = communityPalette();
      const active = state.activeId ? state.index.get(state.activeId) : undefined;
      const highlight = new Set<number>();
      const chain = state.path;
      for (const id of chain ?? state.marked ?? []) {
        const index = state.index.get(id);
        if (index !== undefined) highlight.add(index);
      }
      const dimming = highlight.size > 0;
      // Theme colours are sRGB; three.js works in linear light.
      const mix = (color: Rgba, keep: number) =>
        new THREE.Color().setRGB(
          color[0] * keep + background[0] * (1 - keep),
          color[1] * keep + background[1] * (1 - keep),
          color[2] * keep + background[2] * (1 - keep),
          THREE.SRGBColorSpace,
        );
      sizes = new Float32Array(state.nodes.length);
      state.nodes.forEach((node, index) => {
        const found = state.analysis.get(node.id);
        const tint =
          found && found.community >= 0 && found.community < palette.length
            ? palette[found.community]!
            : paint.faint;
        const base = found ? 2.2 + 3.8 * Math.sqrt(found.rank / 1000) : node.pinned ? 3.6 : 3;
        // Highlighted documents grow so they stand out in depth.
        const raised = dimming && highlight.has(index) ? base * 1.7 : base;
        sizes[index] = index === active ? Math.max(5, raised + 1) : raised;
        const color =
          index === active
            ? paint.accent
            : node.shared
              ? ([tint[0], tint[1], tint[2], 1] as Rgba)
              : tint;
        const keep =
          dimming && !highlight.has(index) && index !== active ? DIM : node.shared ? 0.6 : 1;
        const slot = slots[index];
        if (slot) meshes[slot.mesh]?.mesh.setColorAt(slot.instance, mix(color, keep));
      });
      for (const { mesh } of meshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Links: the active node's and the path's in the accent colour; the rest dim with a highlight.
      const steps = new Set<string>();
      if (chain) {
        for (let at = 1; at < chain.length; at += 1) {
          steps.add(`${chain[at - 1]}|${chain[at]}`);
          steps.add(`${chain[at]}|${chain[at - 1]}`);
        }
      }
      const colors = new Float32Array((linkEnds.length / 2) * 6);
      for (let at = 0; at < linkEnds.length / 2; at += 1) {
        const a = linkEnds[at * 2]!;
        const b = linkEnds[at * 2 + 1]!;
        const from = state.nodes[a]?.id;
        const to = state.nodes[b]?.id;
        const onPath = steps.has(`${from}|${to}`);
        const hot = onPath || (!chain && (a === active || b === active));
        const color = mix(hot ? paint.accent : paint.line, hot ? 1 : dimming ? DIM : 0.9);
        colors.set([color.r, color.g, color.b, color.r, color.g, color.b], at * 6);
      }
      lineGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      placeNodes();
      dirty = true;
      drawLabels();
    };

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    /** Move every instance and link end to the latest positions. */
    const placeNodes = () => {
      const positions = state.positions;
      if (positions.length < state.nodes.length * 3) return;
      slots.forEach((slot, index) => {
        const size = sizes[index] ?? 3;
        position.set(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
        scale.set(size, size, size);
        matrix.compose(position, quaternion, scale);
        meshes[slot.mesh]?.mesh.setMatrixAt(slot.instance, matrix);
      });
      for (const { mesh } of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      const ends = new Float32Array((linkEnds.length / 2) * 6);
      for (let at = 0; at < linkEnds.length / 2; at += 1) {
        const a = linkEnds[at * 2]! * 3;
        const b = linkEnds[at * 2 + 1]! * 3;
        ends.set(
          [
            positions[a]!,
            positions[a + 1]!,
            positions[a + 2]!,
            positions[b]!,
            positions[b + 1]!,
            positions[b + 2]!,
          ],
          at * 6,
        );
      }
      lineGeometry.setAttribute("position", new THREE.BufferAttribute(ends, 3));
      lineGeometry.computeBoundingSphere();
      dirty = true;
    };

    /** Frame some nodes (or all): the camera keeps its direction and moves to see them. */
    const frame = (ids: string[] | null, duration: number) => {
      const positions = state.positions;
      const list =
        ids && ids.length > 0
          ? ids
              .map((id) => state.index.get(id))
              .filter((index): index is number => index !== undefined)
          : state.nodes.map((_, index) => index);
      if (list.length === 0 || positions.length === 0) return;
      const center = new THREE.Vector3();
      for (const index of list)
        center.add(
          position.set(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!),
        );
      center.divideScalar(list.length);
      // A minimum, so a handful of documents does not fill the screen.
      let radius = 45;
      for (const index of list) {
        position.set(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
        radius = Math.max(radius, position.distanceTo(center));
      }
      const fov = (camera.fov * Math.PI) / 180;
      const distance = (radius * 1.25) / Math.sin(Math.min(fov, fov * camera.aspect) / 2);
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (direction.lengthSq() === 0) direction.set(0, 0, 1);
      const to = center.clone().add(direction.multiplyScalar(distance));
      // The zoom reads 100 % right after each framing.
      referenceDistance = distance;
      if (reduced || duration <= 0) {
        camera.position.copy(to);
        controls.target.copy(center);
        fly = null;
        dirty = true;
        return;
      }
      fly = {
        from: camera.position.clone(),
        to,
        target0: controls.target.clone(),
        target1: center,
        start: performance.now(),
        duration,
      };
    };

    const publishZoom = () => {
      const distance = camera.position.distanceTo(controls.target) || 1;
      state.onZoom(Math.round((referenceDistance / distance) * 100));
    };

    const drawLabels = () => {
      const context = labels.getContext("2d");
      if (!context) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (labels.width !== Math.round(width * dpr)) labels.width = Math.round(width * dpr);
      if (labels.height !== Math.round(height * dpr)) labels.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const positions = state.positions;
      if (positions.length < state.nodes.length * 3) return;
      const paint = readPaint();
      const active = state.activeId ? state.index.get(state.activeId) : undefined;
      const wanted = new Set<number>();
      const add = (index: number | undefined) => {
        if (index !== undefined && index >= 0) wanted.add(index);
      };
      add(active);
      add(state.hover);
      if (active !== undefined) {
        for (let at = 0; at < linkEnds.length / 2; at += 1) {
          if (linkEnds[at * 2] === active) add(linkEnds[at * 2 + 1]);
          if (linkEnds[at * 2 + 1] === active) add(linkEnds[at * 2]);
        }
      }
      for (const id of state.path ?? []) add(state.index.get(id));
      // The first marked documents (the strongest bridges come first); more would overlap in depth.
      for (const id of (state.marked ?? []).slice(0, 20)) add(state.index.get(id));
      // Small graphs label everything; larger ones the most important documents.
      if (state.nodes.length <= 150) state.nodes.forEach((_, index) => add(index));
      else {
        [...state.analysis.entries()]
          .sort((a, b) => b[1].rank - a[1].rank)
          .slice(0, 25)
          .forEach(([id]) => add(state.index.get(id)));
      }
      context.font = "12px Outfit, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "top";
      let drawn = 0;
      for (const index of wanted) {
        if (drawn >= MAX_LABELS) break;
        const node = state.nodes[index];
        if (!node) continue;
        position.set(positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!);
        position.project(camera);
        if (position.z > 1 || position.z < -1) continue;
        const x = ((position.x + 1) / 2) * width;
        const y = ((1 - position.y) / 2) * height;
        if (x < -80 || y < -40 || x > width + 80 || y > height + 40) continue;
        const label =
          node.title.length > 28 ? t("{0}…", { 0: node.title.slice(0, 26) }) : node.title;
        const top = y + 10;
        if (index === active) {
          const boxWidth = context.measureText(label).width + 12;
          context.fillStyle = paint.accentText;
          context.beginPath();
          context.roundRect(x - boxWidth / 2, top - 2, boxWidth, 18, 6);
          context.fill();
          context.fillStyle = paint.ink;
        } else {
          context.fillStyle = paint.muted;
        }
        context.fillText(label, x, top);
        drawn += 1;
      }
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (fly) {
        const progress = Math.min(1, (performance.now() - fly.start) / fly.duration);
        const ease = 1 - (1 - progress) ** 3;
        camera.position.lerpVectors(fly.from, fly.to, ease);
        controls.target.lerpVectors(fly.target0, fly.target1, ease);
        if (progress >= 1) fly = null;
        dirty = true;
      }
      const moved = controls.update();
      if (moved || dirty) {
        renderer.render(scene, camera);
        drawLabels();
        publishZoom();
        dirty = false;
      }
    };
    raf = requestAnimationFrame(loop);
    controls.addEventListener("start", () => {
      state.steered = true;
      fly = null;
    });

    worker.onmessage = (event: MessageEvent<LayoutOut>) => {
      const message = event.data;
      if (message.type === "tick") {
        state.positions = message.positions;
        placeNodes();
        // While the layout settles the camera follows it, until the person moves it.
        if (!state.steered && performance.now() - state.followedAt > 600) {
          state.followedAt = performance.now();
          frameDefault(500);
        }
      } else if (!state.steered) frameDefault(500);
    };

    /** The active node and its neighbours, or the whole graph without one. */
    const frameDefault = (duration: number) => {
      const active = state.activeId;
      if (!active) return frame(null, duration);
      const around = new Set([active]);
      for (const edge of state.edges) {
        if (edge.from === active) around.add(edge.to);
        if (edge.to === active) around.add(edge.from);
      }
      frame(around.size > 1 ? [...around] : null, duration);
    };

    const communitiesArray = () =>
      Int32Array.from(state.nodes, (node) => {
        const community = state.analysis.get(node.id)?.community;
        return community !== undefined && community >= 0 ? community : -1;
      });

    /** New nodes or links: rebuild the meshes, keep known positions, restart the layout. */
    const load = () => {
      const previous = new Map<string, [number, number, number]>();
      state.index.forEach((index, id) => {
        const p = state.positions;
        if (p.length >= (index + 1) * 3)
          previous.set(id, [p[index * 3]!, p[index * 3 + 1]!, p[index * 3 + 2]!]);
      });
      state.index = new Map(state.nodes.map((node, index) => [node.id, index]));
      for (const { mesh } of meshes) {
        scene.remove(mesh);
        mesh.dispose();
      }
      const groups = KINDS.map((kind) =>
        state.nodes.flatMap((node, index) => (node.kind === kind ? [index] : [])),
      );
      meshes = groups.flatMap((list, kind) => {
        if (list.length === 0) return [];
        const mesh = new THREE.InstancedMesh(geometries[KINDS[kind]!], material, list.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        scene.add(mesh);
        return [{ mesh, nodes: list }];
      });
      slots = new Array(state.nodes.length);
      meshes.forEach((entry, meshIndex) =>
        entry.nodes.forEach((node, instance) => {
          slots[node] = { mesh: meshIndex, instance };
        }),
      );
      const pairs: number[] = [];
      for (const edge of state.edges) {
        const a = state.index.get(edge.from);
        const b = state.index.get(edge.to);
        if (a !== undefined && b !== undefined) pairs.push(a, b);
      }
      linkEnds = Int32Array.from(pairs);
      const seed = new Float32Array(state.nodes.length * 3).fill(Number.NaN);
      state.nodes.forEach((node, index) => {
        const known = previous.get(node.id);
        if (known) seed.set(known, index * 3);
      });
      const fresh = previous.size === 0;
      state.positions = new Float32Array(0);
      state.steered = false;
      const start: LayoutIn = {
        type: "start",
        count: state.nodes.length,
        links: linkEnds,
        communities: communitiesArray(),
        positions: seed,
        alpha: fresh ? 1 : 0.4,
      };
      worker.postMessage(start);
      paintColors();
    };

    // Picking: a click without dragging lands on the instance under the pointer.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (event: PointerEvent | MouseEvent): number => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(
        meshes.map((entry) => entry.mesh),
        false,
      );
      const hit = hits[0];
      if (!hit || hit.instanceId === undefined) return -1;
      const entry = meshes.find((item) => item.mesh === hit.object);
      return entry?.nodes[hit.instanceId] ?? -1;
    };
    let down: { x: number; y: number } | null = null;
    let hoverQueued = false;
    const onDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      const index = pick(event);
      const node = state.nodes[index];
      if (!node) return;
      if (event.shiftKey) {
        state.onPathTo(node.id);
        return;
      }
      const intent = graphClickIntent(state.lastClick, node.id, Date.now(), false);
      if (intent === "open") {
        state.lastClick = null;
        state.onOpen(node.id);
      } else if (intent === "inspect") {
        state.lastClick = { id: node.id, at: Date.now() };
        state.onInspect(node.id);
      }
    };
    const onMove = (event: PointerEvent) => {
      if (down || hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        const index = pick(event);
        if (index === state.hover) return;
        state.hover = index;
        renderer.domElement.style.cursor = index >= 0 ? "pointer" : "";
        drawLabels();
      });
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointermove", onMove);

    // A theme change recolours the scene.
    const themes = new MutationObserver(() => paintColors());
    themes.observe(document.documentElement, { attributes: true });

    state.load = load;
    state.paint = paintColors;
    state.frame = frame;
    state.clusters = (communities) =>
      worker.postMessage({ type: "communities", communities } satisfies LayoutIn);
    state.camera = {
      zoom: (factor) => {
        state.steered = true;
        const offset = camera.position.clone().sub(controls.target).divideScalar(factor);
        camera.position.copy(controls.target).add(offset);
        dirty = true;
      },
      pan: (dx, dy) => {
        state.steered = true;
        const distance = camera.position.distanceTo(controls.target);
        const step = distance / Math.max(1, host.clientHeight);
        const right = new THREE.Vector3()
          .setFromMatrixColumn(camera.matrix, 0)
          .multiplyScalar(-dx * step);
        const up = new THREE.Vector3()
          .setFromMatrixColumn(camera.matrix, 1)
          .multiplyScalar(dy * step);
        camera.position.add(right).add(up);
        controls.target.add(right).add(up);
        dirty = true;
      },
    };
    load();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      themes.disconnect();
      worker.postMessage({ type: "stop" } satisfies LayoutIn);
      worker.terminate();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      controls.dispose();
      for (const { mesh } of meshes) mesh.dispose();
      Object.values(geometries).forEach((geometry) => geometry.dispose());
      material.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      state.load = () => undefined;
      state.paint = () => undefined;
    };
  }

  // New nodes or links, or Reacomodar.
  useEffect(() => {
    state.load();
    // state.load reads the current nodes and edges; signature says when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Selection: recolour and frame the new neighbourhood.
  useEffect(() => {
    state.paint();
    // state.paint reads the live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Communities arrived or were turned on or off: recolour and regroup.
  useEffect(() => {
    state.paint();
    state.clusters(
      Int32Array.from(state.nodes, (node) => {
        const community = analysis.get(node.id)?.community;
        return community !== undefined && community >= 0 ? community : -1;
      }),
    );
    // state reads the live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  // A path or marked documents: highlight and frame them.
  const pathKey = path?.join(",") ?? "";
  const markedKey = marked?.join(",") ?? "";
  useEffect(() => {
    state.paint();
    const ids = path && path.length > 1 ? path : marked && marked.length > 0 ? marked : null;
    if (ids) {
      state.steered = true;
      state.frame(ids, 600);
    }
    // state reads the live values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey, markedKey]);

  apiRef.current = {
    zoom: (factor) => state.camera.zoom(factor),
    fit: () => {
      state.steered = true;
      state.frame(null, 500);
    },
    focus: () => {
      state.steered = true;
      const around = new Set(state.activeId ? [state.activeId] : []);
      for (const edge of state.edges) {
        if (edge.from === state.activeId) around.add(edge.to);
        if (edge.to === state.activeId) around.add(edge.from);
      }
      state.frame(around.size > 1 ? [...around] : null, 500);
    },
    reveal: () => {
      const around = new Set(state.activeId ? [state.activeId] : []);
      for (const edge of state.edges) {
        if (edge.from === state.activeId) around.add(edge.to);
        if (edge.to === state.activeId) around.add(edge.from);
      }
      if (around.size > 1) state.frame([...around], 500);
    },
    pan: (dx, dy) => state.camera.pan(dx, dy),
  };

  return (
    <div className="relative h-full w-full">
      <div
        ref={hostRef}
        aria-label={t("Grafo de documentos en 3D")}
        className="absolute inset-0 cursor-grab touch-none"
      />
      <canvas ref={labelsRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {failed ? (
        <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted">
          {t("No se pudo cargar la vista 3D. Recarga la página.")}
        </p>
      ) : null}
    </div>
  );
}
