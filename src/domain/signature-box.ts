/**
 * PDF signature rectangle expressed as fractions of the displayed page, top-left origin. The
 * image is not stored; geometry determines stamping placement.
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

/** Validate a nonzero rectangle within a real page. */
export function validBox(box: SignatureBox, pages: number): boolean {
  if (!Number.isInteger(box.page) || box.page < 1 || box.page > pages) return false;
  const values = [box.x, box.y, box.w, box.h];
  if (values.some((value) => !Number.isFinite(value))) return false;
  if (box.w < 0.02 || box.h < 0.02 || box.w > 1 || box.h > 1) return false;
  if (box.x < 0 || box.y < 0 || box.x + box.w > 1.001 || box.y + box.h > 1.001) return false;
  return true;
}

/**
 * Convert displayed top-left coordinates to PDF crop-relative bottom-left coordinates without
 * adding crop offset. Supports rotations 0, 90, 180 and 270.
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
  // Round to a thousandth of a point to remove floating-point noise below visible precision.
  const snap = (value: number) => Math.round(value * 1000) / 1000;
  return {
    x: snap(Math.min(x1, x2)),
    y: snap(Math.min(y1, y2)),
    width: snap(Math.abs(x2 - x1)),
    height: snap(Math.abs(y2 - y1)),
  };
}
