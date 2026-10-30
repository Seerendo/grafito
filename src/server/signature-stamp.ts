import { PDFDocument } from "pdf-lib";
import { boxToPdf, type SignatureBox } from "../domain/signature-box.ts";

const MAX_IMAGE = 500_000;

/**
 * La imagen llega en base64 y solo se decodifica en memoria.
 * `"big"` si pesa demasiado; `null` si no es una imagen usable.
 */
export function decodeSignatureImage(raw: string): Uint8Array | "big" | null {
  const data = raw.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "").replace(/\s/g, "");
  if (!data) return null;
  if (data.length > 700_000) return "big";
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > MAX_IMAGE) return "big";
  if (bytes.byteLength < 32) return null;
  return new Uint8Array(bytes);
}

export async function pdfPageCount(pdfBytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(pdfBytes)).getPageCount();
  } catch {
    throw new Error("No se pudo estampar la firma en el PDF.");
  }
}

/** PNG o JPEG, por los bytes, no por el nombre que diga el navegador. */
export function imageKind(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/**
 * Estampa la imagen en el recuadro y devuelve el PDF nuevo.
 * Quien llama no debe guardar `image`: aquí solo se lee.
 */
export async function stampSignature(pdfBytes: Uint8Array, image: Uint8Array, box: SignatureBox): Promise<Uint8Array> {
  const kind = imageKind(image);
  if (!kind) throw new Error("La firma tiene que ser una imagen PNG o JPEG.");
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(pdfBytes);
  } catch {
    throw new Error("No se pudo estampar la firma en el PDF.");
  }
  if (box.page < 1 || box.page > pdf.getPageCount()) throw new Error("El recuadro no cabe en la página.");
  const page = pdf.getPage(box.page - 1);
  if (!page) throw new Error("El recuadro no cabe en la página.");
  const crop = page.getCropBox();
  const placed = boxToPdf(box, crop.width, crop.height, page.getRotation().angle);
  try {
    const embedded = kind === "png" ? await pdf.embedPng(image) : await pdf.embedJpg(image);
    page.drawImage(embedded, {
      x: crop.x + placed.x,
      y: crop.y + placed.y,
      width: placed.width,
      height: placed.height,
    });
    return pdf.save();
  } catch {
    throw new Error("No se pudo estampar la firma en el PDF.");
  }
}
