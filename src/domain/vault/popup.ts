/**
 * Dónde poner un recuadro (la nota de un PDF, o su burbuja) para que quepa en
 * el área visible. Las coordenadas son las del contenido que se desplaza.
 * `left` lo apoya a la izquierda del punto; si no cabe, al otro lado.
 * `center` lo centra en el punto y lo mete dentro si se sale.
 */
export function placePopup(input: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewLeft: number;
  viewTop: number;
  viewWidth: number;
  viewHeight: number;
  margin?: number;
  prefer: "left" | "center";
}): { left: number; top: number } {
  const margin = input.margin ?? 8;
  const viewL = input.viewLeft + margin;
  const viewT = input.viewTop + margin;
  const viewR = input.viewLeft + input.viewWidth - margin;
  const viewB = input.viewTop + input.viewHeight - margin;
  const roomW = Math.max(0, viewR - viewL);
  const roomH = Math.max(0, viewB - viewT);
  const width = Math.min(Math.max(0, input.width), roomW);
  const height = Math.min(Math.max(0, input.height), roomH);
  let left = input.prefer === "left" ? input.x - width : input.x - width / 2;
  if (left < viewL) left = input.prefer === "left" ? Math.min(viewR - width, input.x + margin) : viewL;
  if (left + width > viewR) left = viewR - width;
  if (left < viewL) left = viewL;
  let top = input.y;
  if (top + height > viewB) top = input.y - height;
  if (top < viewT) top = viewT;
  if (top + height > viewB) top = viewB - height;
  return { left, top };
}
