import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimNode,
} from "d3-force-3d";

/**
 * The 3D graph's force layout, off the main thread so drawing stays fluid while it settles.
 * Nodes repel, links pull, and nodes of one community also pull towards their group's centre,
 * so each group takes its own region of space. Positions go back as a Float32Array (x, y, z per
 * node) a few times per frame.
 */

export type LayoutIn =
  | {
      type: "start";
      count: number;
      /** Pairs of node indexes. */
      links: Int32Array;
      /** Community per node, -1 for none. */
      communities: Int32Array;
      /** Known positions to keep (x, y, z per node, NaN where unknown). */
      positions: Float32Array;
      alpha: number;
    }
  | { type: "communities"; communities: Int32Array }
  | { type: "reheat"; alpha: number }
  | { type: "pin"; index: number; x: number; y: number; z: number }
  | { type: "stop" };

export type LayoutOut = { type: "tick"; positions: Float32Array; alpha: number } | { type: "end" };

// The worker's own global, typed by hand: the webworker and DOM libraries clash in one project.
const scope = self as unknown as {
  postMessage(message: LayoutOut, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<LayoutIn>) => void) | null;
};

let simulation: Simulation | null = null;
let nodes: SimNode[] = [];
let communities: Int32Array = new Int32Array(0);
let timer = 0;

/** Pull every grouped node towards its group's current centre. */
function clusterForce(strength: number) {
  const force = (alpha: number) => {
    const sums = new Map<number, [number, number, number, number]>();
    nodes.forEach((node, index) => {
      const group = communities[index] ?? -1;
      if (group < 0) return;
      const sum = sums.get(group) ?? [0, 0, 0, 0];
      sum[0] += node.x ?? 0;
      sum[1] += node.y ?? 0;
      sum[2] += node.z ?? 0;
      sum[3] += 1;
      sums.set(group, sum);
    });
    const pull = strength * alpha;
    nodes.forEach((node, index) => {
      const sum = sums.get(communities[index] ?? -1);
      if (!sum || sum[3] < 2) return;
      node.vx = (node.vx ?? 0) + (sum[0] / sum[3] - (node.x ?? 0)) * pull;
      node.vy = (node.vy ?? 0) + (sum[1] / sum[3] - (node.y ?? 0)) * pull;
      node.vz = (node.vz ?? 0) + (sum[2] / sum[3] - (node.z ?? 0)) * pull;
    });
  };
  return force;
}

function post() {
  const positions = new Float32Array(nodes.length * 3);
  nodes.forEach((node, index) => {
    positions[index * 3] = node.x ?? 0;
    positions[index * 3 + 1] = node.y ?? 0;
    positions[index * 3 + 2] = node.z ?? 0;
  });
  const message: LayoutOut = { type: "tick", positions, alpha: simulation?.alpha() ?? 0 };
  scope.postMessage(message, [positions.buffer]);
}

/** Run ticks for about a frame's worth of time, send positions, and go on until settled. */
function run() {
  clearTimeout(timer);
  if (!simulation) return;
  const started = performance.now();
  while (performance.now() - started < 12 && simulation.alpha() > 0.002) simulation.tick();
  post();
  if (simulation.alpha() > 0.002) timer = setTimeout(run, 0) as unknown as number;
  else scope.postMessage({ type: "end" } satisfies LayoutOut);
}

scope.onmessage = (event: MessageEvent<LayoutIn>) => {
  const message = event.data;
  if (message.type === "start") {
    communities = message.communities;
    const spread = Math.cbrt(message.count) * 30;
    nodes = Array.from({ length: message.count }, (_, index) => {
      const x = message.positions[index * 3];
      const known = x !== undefined && Number.isFinite(x);
      // New nodes start inside a ball: a sphere's random points spread evenly.
      const u = Math.random() * 2 - 1;
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.cbrt(Math.random()) * spread;
      const ring = Math.sqrt(1 - u * u) * radius;
      return known
        ? {
            x,
            y: message.positions[index * 3 + 1]!,
            z: message.positions[index * 3 + 2]!,
          }
        : { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring, z: u * radius };
    });
    const links = [];
    for (let at = 0; at + 1 < message.links.length; at += 2) {
      links.push({ source: message.links[at]!, target: message.links[at + 1]! });
    }
    simulation?.stop();
    simulation = forceSimulation(nodes, 3)
      .force("charge", forceManyBody().strength(-70).theta(0.9).distanceMax(600))
      .force("link", forceLink(links).distance(40).strength(0.6))
      .force("center", forceCenter(0, 0, 0))
      .force("cluster", clusterForce(0.08))
      .velocityDecay(0.35)
      .alphaDecay(0.02)
      .alpha(message.alpha)
      .stop();
    // A new layout settles most of the way before it is first shown: no shrinking to watch.
    if (message.alpha >= 0.5) {
      const started = performance.now();
      while (simulation.alpha() > 0.25 && performance.now() - started < 1500) simulation.tick();
    }
    run();
  } else if (message.type === "communities") {
    communities = message.communities;
    if (simulation) {
      simulation.alpha(Math.max(simulation.alpha(), 0.4));
      run();
    }
  } else if (message.type === "reheat") {
    if (simulation) {
      simulation.alpha(message.alpha);
      run();
    }
  } else if (message.type === "pin") {
    const node = nodes[message.index];
    if (node) {
      node.fx = message.x;
      node.fy = message.y;
      node.fz = message.z;
    }
    if (simulation) {
      simulation.alpha(Math.max(simulation.alpha(), 0.1));
      run();
    }
  } else if (message.type === "stop") {
    clearTimeout(timer);
    simulation?.stop();
    simulation = null;
  }
};
