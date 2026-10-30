import { createHash } from "node:crypto";
import forge from "node-forge";
import QRCode from "qrcode";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFInvalidObject,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFObject,
} from "pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { boxToPdf, type SignatureBox } from "../domain/signature-box.ts";

/** Hueco del PKCS#7. Una cadena larga cabe; si no, se rechaza el certificado. */
const SIGNATURE_LENGTH = 32_768;
const BYTE_RANGE = "**********";
const MAX_P12 = 2_000_000;
const LABEL = "Firmado electrónicamente por:";

/**
 * Firma el PDF con un certificado .p12 del firmante. La contraseña solo abre
 * el archivo en memoria: ni ella, ni el .p12, ni la clave privada se guardan.
 * El recuadro muestra un QR y el nombre. No es una firma cualificada ni un
 * sello de un prestador de confianza.
 */

export function decodeCertificate(raw: string): Uint8Array | "big" | null {
  const data = raw.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
  if (!data || data.length < 32) return null;
  if (data.length > 4_000_000) return "big";
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > MAX_P12) return "big";
  if (bytes.byteLength < 32 || bytes[0] !== 0x30) return null;
  return new Uint8Array(bytes);
}

/** El PDF ya lleva un PKCS#7 con rango de bytes. Una reescritura lo invalidaría. */
export function hasCertificateSignature(pdfBytes: Uint8Array): boolean {
  return /\/ByteRange\s*\[\s*\d+\s+\d+\s+\d+\s+\d+\s*\]/.test(Buffer.from(pdfBytes).toString("latin1"));
}

/** Mensaje para quien firma, sin repetir el detalle de la librería ni la contraseña. */
function certificateError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/password|MAC could not|Invalid password/i.test(message)) return "La contraseña del certificado no es correcta.";
  if (/private key|clave para firmar/i.test(message)) return "Ese certificado no tiene una clave para firmar.";
  if (/placeholder|too small|not large enough/i.test(message)) return "Ese certificado no cabe en la firma.";
  if (message.startsWith("Ese ") || message.startsWith("La ") || message.startsWith("No se pudo") || message.startsWith("El recuadro")) return message;
  return "Ese archivo no es un certificado .p12.";
}

type OpenedCertificate = { name: string; fingerprint: string };
type ForgeKey = { n?: { compareTo: (other: unknown) => number }; e?: { compareTo: (other: unknown) => number } };
type ForgeCert = { subject: { getField: (name: string) => { value?: unknown } | null }; publicKey: ForgeKey };

/** Abre el .p12 para comprobar la contraseña y leer el nombre. No devuelve la clave. */
function openCertificate(bytes: Uint8Array, password: string): OpenedCertificate {
  let p12: ReturnType<typeof forge.pkcs12.pkcs12FromAsn1>;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(bytes).toString("binary")));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (error) {
    throw new Error(certificateError(error));
  }
  const keyKind = forge.pki.oids.pkcs8ShroudedKeyBag;
  const keys = keyKind ? p12.getBags({ bagType: keyKind })[keyKind] : undefined;
  const privateKey = keys?.[0]?.key as ForgeKey | undefined;
  if (!privateKey?.n || !privateKey.e) throw new Error("Ese certificado no tiene una clave para firmar.");
  const certKind = forge.pki.oids.certBag;
  const certs = certKind ? p12.getBags({ bagType: certKind })[certKind] : undefined;
  let matched: ForgeCert | undefined;
  for (const bag of certs ?? []) {
    const cert = bag.cert as ForgeCert | undefined;
    const publicKey = cert?.publicKey;
    if (!cert || !publicKey?.n || !publicKey.e) continue;
    if (privateKey.n.compareTo(publicKey.n) === 0 && privateKey.e.compareTo(publicKey.e) === 0) {
      matched = cert;
      break;
    }
  }
  if (!matched) throw new Error("Ese certificado no tiene una clave para firmar.");
  const value = matched.subject.getField("CN")?.value;
  const name = typeof value === "string" ? value.trim() : "";
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(matched as never)).getBytes(), "binary");
  return { name, fingerprint: createHash("sha256").update(der).digest("hex") };
}

function pdfText(text: string): PDFHexString | PDFString {
  return [...text].some((character) => character.charCodeAt(0) > 127) ? PDFHexString.fromText(text) : PDFString.of(text);
}

/** Helvetica no dibuja todo Unicode: lo que no cabe se omite. */
function visibleName(name: string): string {
  const kept = [...name]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code <= 255;
    })
    .join("")
    .trim();
  return kept.slice(0, 80);
}

function stampClock(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(when.getUTCDate())}/${pad(when.getUTCMonth() + 1)}/${when.getUTCFullYear()} ${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())} UTC`;
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function encoded(font: PDFFont, text: string): string {
  try {
    return font.encodeText(text).toString();
  } catch {
    const safe = [...text].filter((character) => character.charCodeAt(0) < 128).join("").trim() || "Firma";
    return font.encodeText(safe).toString();
  }
}

function fitSize(font: PDFFont, text: string, width: number, preferred: number, minimum: number): number {
  let size = preferred;
  while (size > minimum && font.widthOfTextAtSize(text, size) > width) size -= 0.5;
  return size;
}

/** Módulos negros del QR, en el sistema de coordenadas de la apariencia. */
function qrMarks(text: string, x: number, y: number, size: number): string {
  const code = QRCode.create(text, { errorCorrectionLevel: "M" });
  const modules = code.modules.size;
  const cell = size / modules;
  const lines = ["0 0 0 rg"];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!code.modules.get(column, row)) continue;
      const left = x + column * cell;
      const bottom = y + (modules - 1 - row) * cell;
      lines.push(`${round(left)} ${round(bottom)} ${round(cell)} ${round(cell)} re f`);
    }
  }
  return lines.join("\n");
}

/**
 * Apariencia del recuadro: QR a la izquierda y el nombre a la derecha.
 * El QR repite el nombre, la hora y la huella del certificado. No es un
 * enlace a un prestador de confianza.
 */
function signatureAppearance(
  pdf: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  width: number,
  height: number,
  certificate: OpenedCertificate,
  when: Date,
): PDFRef {
  const pad = Math.max(2, Math.min(4, height * 0.08));
  const qrSize = Math.max(8, Math.min(height - pad * 2, Math.max(8, width * 0.42)));
  const textX = pad + qrSize + pad;
  const textWidth = Math.max(4, width - textX - pad);
  const shown = visibleName(certificate.name) || "Firma";
  const clock = stampClock(when);
  const labelSize = fitSize(font, LABEL, textWidth, Math.min(8, height * 0.18), 4);
  const nameSize = fitSize(bold, shown, textWidth, Math.min(12, height * 0.26), 5);
  const dateSize = fitSize(font, clock, textWidth, Math.min(7, height * 0.15), 4);
  const block = labelSize + nameSize + dateSize + 4;
  const base = Math.max(pad, (height - block) / 2);
  const dateY = base;
  const nameY = dateY + dateSize + 2;
  const labelY = nameY + nameSize + 2;
  const payload = [`Firmado electrónicamente por: ${certificate.name || "Firma"}`, `Fecha: ${clock}`, `Huella: ${certificate.fingerprint}`].join("\n");
  const content = [
    "q",
    "1 1 1 rg",
    `0 0 ${round(width)} ${round(height)} re f`,
    "Q",
    "q",
    "0.15 0.2 0.28 RG",
    "0.6 w",
    `0.4 0.4 ${round(Math.max(1, width - 0.8))} ${round(Math.max(1, height - 0.8))} re S`,
    "Q",
    qrMarks(payload, pad, Math.max(pad, (height - qrSize) / 2), qrSize),
    "BT",
    `/F1 ${round(labelSize)} Tf`,
    "0.1 0.12 0.16 rg",
    `1 0 0 1 ${round(textX)} ${round(labelY)} Tm`,
    `${encoded(font, LABEL)} Tj`,
    "ET",
    "BT",
    `/F2 ${round(nameSize)} Tf`,
    "0 0 0 rg",
    `1 0 0 1 ${round(textX)} ${round(nameY)} Tm`,
    `${encoded(bold, shown)} Tj`,
    "ET",
    "BT",
    `/F1 ${round(dateSize)} Tf`,
    "0.25 0.28 0.32 rg",
    `1 0 0 1 ${round(textX)} ${round(dateY)} Tm`,
    `${encoded(font, clock)} Tj`,
    "ET",
  ].join("\n");
  const stream = pdf.context.stream(content, {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, width, height],
    Resources: { Font: { F1: font.ref, F2: bold.ref } },
  });
  return pdf.context.register(stream);
}

type FieldLinks = { page: PDFRef; form: PDFRef; catalog: boolean; extra: PDFRef[] };

/**
 * Deja el hueco de la firma en la página del recuadro. Adaptado de
 * `@signpdf/placeholder-pdf-lib` (MIT) para que cada persona tenga su propio
 * nombre de campo y la apariencia (QR y nombre) que muestra el lector.
 */
function addSignatureField(
  pdf: PDFDocument,
  pageIndex: number,
  widgetRect: number[],
  name: string,
  when: Date,
  appearance: PDFRef,
): FieldLinks {
  const page = pdf.getPage(pageIndex);
  const byteRange = PDFArray.withContext(pdf.context);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of(BYTE_RANGE));
  byteRange.push(PDFName.of(BYTE_RANGE));
  byteRange.push(PDFName.of(BYTE_RANGE));
  const contents = PDFHexString.of(String.fromCharCode(0).repeat(SIGNATURE_LENGTH));
  const signatureDict = pdf.context.obj({
    Type: "Sig",
    Filter: "Adobe.PPKLite",
    SubFilter: "adbe.pkcs7.detached",
    ByteRange: byteRange,
    Contents: contents,
    Reason: pdfText("Firma con certificado"),
    M: PDFString.fromDate(when),
    ContactInfo: PDFString.of(""),
    Name: pdfText(name || "Firma"),
    Location: PDFString.of("Grafito"),
    Prop_Build: { Filter: { Name: "Adobe.PPKLite" }, App: { Name: "Grafito" } },
  });
  const signatureBytes = new Uint8Array(signatureDict.sizeInBytes());
  signatureDict.copyBytesInto(signatureBytes, 0);
  const signatureRef = pdf.context.register(PDFInvalidObject.of(signatureBytes));
  const rect = PDFArray.withContext(pdf.context);
  for (const value of widgetRect) rect.push(PDFNumber.of(value));
  const fieldName = `Grafito${createHash("sha256").update(signatureBytes).update(widgetRect.join(",")).digest("hex").slice(0, 12)}`;
  const widget = pdf.context.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: rect,
    V: signatureRef,
    T: PDFString.of(fieldName),
    F: 4,
    P: page.ref,
    AP: { N: appearance },
  });
  const widgetRef = pdf.context.register(widget);
  let annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annotations) annotations = pdf.context.obj([]);
  annotations.push(widgetRef);
  page.node.set(PDFName.of("Annots"), annotations);
  const current = pdf.catalog.get(PDFName.of("AcroForm"));
  let form: PDFDict;
  let formRef: PDFRef;
  let catalog = false;
  if (current instanceof PDFRef) {
    formRef = current;
    form = pdf.context.lookup(current, PDFDict);
  } else {
    form = current instanceof PDFDict ? current : pdf.context.obj({ Fields: [] });
    formRef = pdf.context.register(form);
    pdf.catalog.set(PDFName.of("AcroForm"), formRef);
    catalog = true;
  }
  const flags = form.lookupMaybe(PDFName.of("SigFlags"), PDFNumber);
  form.set(PDFName.of("SigFlags"), PDFNumber.of((flags?.asNumber() ?? 0) | 1 | 2));
  let fields = form.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) {
    fields = pdf.context.obj([]);
    form.set(PDFName.of("Fields"), fields);
  }
  fields.push(widgetRef);
  const extra: PDFRef[] = [];
  const fieldsEntry = form.get(PDFName.of("Fields"));
  if (fieldsEntry instanceof PDFRef) extra.push(fieldsEntry);
  const annotsEntry = page.node.get(PDFName.of("Annots"));
  if (annotsEntry instanceof PDFRef) extra.push(annotsEntry);
  return { page: page.ref, form: formRef, catalog, extra };
}

function objectTags(pdf: PDFDocument): Set<string> {
  const tags = new Set<string>();
  for (const [ref] of pdf.context.enumerateIndirectObjects()) tags.add(ref.tag);
  return tags;
}

function revisionRefs(pdf: PDFDocument, before: Set<string>, links: FieldLinks): PDFRef[] {
  const refs: PDFRef[] = [];
  const seen = new Set<string>();
  const add = (ref: PDFRef) => {
    if (seen.has(ref.tag)) return;
    seen.add(ref.tag);
    refs.push(ref);
  };
  for (const [ref] of pdf.context.enumerateIndirectObjects()) {
    if (!before.has(ref.tag)) add(ref);
  }
  add(links.page);
  add(links.form);
  for (const ref of links.extra) add(ref);
  if (links.catalog) {
    const root = pdf.context.trailerInfo.Root;
    if (root instanceof PDFRef) add(root);
  }
  return refs;
}

function previousStartxref(bytes: Buffer): number | null {
  const marker = bytes.lastIndexOf("startxref");
  if (marker < 0) return null;
  const slice = bytes.subarray(marker + "startxref".length, marker + "startxref".length + 32).toString("latin1");
  const match = /(\d+)/.exec(slice);
  if (!match) return null;
  const position = Number(match[1]);
  return Number.isFinite(position) ? position : null;
}

function serializeObject(object: PDFObject): Buffer {
  const bytes = new Uint8Array(object.sizeInBytes());
  object.copyBytesInto(bytes, 0);
  return Buffer.from(bytes);
}

/** Añade objetos al final. Los bytes ya firmados no se reescriben. */
function appendRevision(original: Buffer, pdf: PDFDocument, refs: PDFRef[]): Buffer {
  const previous = previousStartxref(original);
  const root = pdf.context.trailerInfo.Root;
  if (previous == null || !(root instanceof PDFRef)) throw new Error("No se pudo estampar la firma en el PDF.");
  let out = original[original.length - 1] === 0x0a ? original : Buffer.concat([original, Buffer.from("\n")]);
  const entries: { number: number; offset: number }[] = [];
  for (const ref of refs) {
    const object = pdf.context.lookup(ref);
    const header = Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
    const body = serializeObject(object);
    entries.push({ number: ref.objectNumber, offset: out.length });
    out = Buffer.concat([out, header, body, Buffer.from("\nendobj\n")]);
  }
  entries.sort((left, right) => left.number - right.number);
  const xrefAt = out.length;
  let xref = "xref\n";
  let index = 0;
  while (index < entries.length) {
    const start = entries[index]?.number ?? 0;
    let end = index;
    while (end + 1 < entries.length && entries[end + 1].number === entries[end].number + 1) end += 1;
    xref += `${start} ${end - index + 1}\n`;
    for (let cursor = index; cursor <= end; cursor += 1) {
      xref += `${String(entries[cursor].offset).padStart(10, "0")} 00000 n \n`;
    }
    index = end + 1;
  }
  const info = pdf.context.trailerInfo.Info;
  const id = pdf.context.trailerInfo.ID;
  const infoTag = info instanceof PDFRef ? ` /Info ${info.tag}` : "";
  const idTag = id ? ` /ID ${id.toString()}` : "";
  const trailer = `trailer\n<< /Size ${pdf.context.largestObjectNumber + 1} /Root ${root.tag}${infoTag}${idTag} /Prev ${previous} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(xref), Buffer.from(trailer)]);
}

/**
 * Dibuja el QR y el nombre en el recuadro y firma el PDF con el .p12.
 * `password` no sale de esta función. Si el PDF ya tenía una firma, la nueva
 * se añade al final para que la anterior siga pudiendo comprobarse.
 */
export async function stampCertificate(
  pdfBytes: Uint8Array,
  p12: Uint8Array,
  password: string,
  box: SignatureBox,
): Promise<Uint8Array> {
  const certificate = openCertificate(p12, password);
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
  const rect = [crop.x + placed.x, crop.y + placed.y, crop.x + placed.x + placed.width, crop.y + placed.y + placed.height];
  const when = new Date();
  const before = objectTags(pdf);
  let links: FieldLinks;
  try {
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const appearance = signatureAppearance(pdf, font, bold, placed.width, placed.height, certificate, when);
    links = addSignatureField(pdf, box.page - 1, rect, certificate.name, when, appearance);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("El recuadro") || error.message.startsWith("No se pudo"))) throw error;
    throw new Error("No se pudo estampar la firma en el PDF.");
  }
  let prepared: Buffer;
  try {
    prepared = hasCertificateSignature(pdfBytes)
      ? appendRevision(Buffer.from(pdfBytes), pdf, revisionRefs(pdf, before, links))
      : Buffer.from(await pdf.save({ useObjectStreams: false }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("No se pudo")) throw error;
    throw new Error("No se pudo estampar la firma en el PDF.");
  }
  try {
    const signer = new P12Signer(Buffer.from(p12), { passphrase: password });
    const signed = await new SignPdf().sign(prepared, signer, when);
    return new Uint8Array(signed);
  } catch (error) {
    throw new Error(certificateError(error));
  }
}
