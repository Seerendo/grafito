/**
 * Recuadro de una firma en un PDF. Las fracciones son de la página tal como
 * se ve (origen arriba a la izquierda). La imagen no se guarda: solo sirve
 * para calcular dónde estamparla.
 */

export type SignatureBox = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export function isPdfFile(name: string, mime: string): boolean {
  return mime === "application/pdf" || /\.pdf$/i.test(name);
}

/** Cabe en una página real y no es una línea. */
export function validBox(box: SignatureBox, pages: number): boolean {
  if (!Number.isInteger(box.page) || box.page < 1 || box.page > pages) return false;
  const values = [box.x, box.y, box.w, box.h];
  if (values.some((value) => !Number.isFinite(value))) return false;
  if (box.w < 0.02 || box.h < 0.02 || box.w > 1 || box.h > 1) return false;
  if (box.x < 0 || box.y < 0 || box.x + box.w > 1.001 || box.y + box.h > 1.001) return false;
  return true;
}

/**
 * El recuadro visto (origen arriba a la izquierda) en el espacio del PDF
 * (origen abajo a la izquierda del recorte, sin sumar su desplazamiento).
 * `rotation` es el giro con el que se muestra la página: 0, 90, 180 o 270.
 */
export function boxToPdf(
  box: SignatureBox,
  pageWidth: number,
  pageHeight: number,
  rotation = 0,
): { x: number; y: number; width: number; height: number } {
  const angle = ((rotation % 360) + 360) % 360;
  const point = (vx: number, vy: number): [number, number] => {
    if (angle === 90) return [vy * pageWidth, vx * pageHeight];
    if (angle === 180) return [(1 - vx) * pageWidth, vy * pageHeight];
    if (angle === 270) return [(1 - vy) * pageWidth, (1 - vx) * pageHeight];
    return [vx * pageWidth, (1 - vy) * pageHeight];
  };
  const [x1, y1] = point(box.x, box.y);
  const [x2, y2] = point(box.x + box.w, box.y + box.h);
  // Milésima de punto: por debajo de lo que se ve, y evita el polvo de los flotantes.
  const snap = (value: number) => Math.round(value * 1000) / 1000;
  return {
    x: snap(Math.min(x1, x2)),
    y: snap(Math.min(y1, y2)),
    width: snap(Math.abs(x2 - x1)),
    height: snap(Math.abs(y2 - y1)),
  };
}
