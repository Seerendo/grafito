// The parts of d3-force-3d the 3D graph uses (the package ships no types).
declare module "d3-force-3d" {
  export type SimNode = {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  };
  export type SimLink = { source: number | SimNode; target: number | SimNode };
  export type Force = ((alpha: number) => void) & { initialize?: (nodes: SimNode[]) => void };

  export type Simulation = {
    force(name: string, force: Force | null): Simulation;
    alpha(): number;
    alpha(value: number): Simulation;
    alphaDecay(value: number): Simulation;
    alphaMin(value: number): Simulation;
    velocityDecay(value: number): Simulation;
    stop(): Simulation;
    tick(iterations?: number): Simulation;
    nodes(): SimNode[];
  };

  export function forceSimulation(nodes: SimNode[], dimensions?: number): Simulation;

  export function forceManyBody(): Force & {
    strength(value: number): ReturnType<typeof forceManyBody>;
    theta(value: number): ReturnType<typeof forceManyBody>;
    distanceMax(value: number): ReturnType<typeof forceManyBody>;
  };

  export function forceLink(links: SimLink[]): Force & {
    distance(value: number): ReturnType<typeof forceLink>;
    strength(value: number): ReturnType<typeof forceLink>;
    iterations(value: number): ReturnType<typeof forceLink>;
  };

  export function forceCenter(x?: number, y?: number, z?: number): Force;
}
