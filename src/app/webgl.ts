/** WebGL2 is what the GPU graph (cosmos.gl) needs; without it the 2D canvas draws the graph. */
export function gpuGraphSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}
