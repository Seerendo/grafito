import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { extractSignature } from "@signpdf/utils";
import forge from "node-forge";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { decodeCertificate, hasCertificateSignature, stampCertificate } from "./signature-p12.ts";

const PASSWORD = "clave-de-prueba-9f3a";

function makeP12(password: string, name = "Ana Prueba"): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: name }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return new Uint8Array(Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary"));
}

type Asn1 = { tagClass: number; type: number; constructed: boolean; value: Asn1[] | string };

function nodes(value: Asn1[] | string): Asn1[] {
  return Array.isArray(value) ? value : [];
}

function walk(node: Asn1, visit: (node: Asn1) => void): void {
  visit(node);
  for (const child of nodes(node.value)) walk(child, visit);
}

/** Comprueba el PKCS#7 suelto: el resumen coincide y la clave pública lo firma. */
function assertSignatureValid(pdf: Uint8Array, index: number): void {
  const extracted = extractSignature(Buffer.from(pdf), index);
  const fileDigest = createHash("sha256").update(extracted.signedData).digest();
  const root = forge.asn1.fromDer(extracted.signature) as unknown as Asn1;
  const messageDigest = forge.pki.oids.messageDigest;
  let digest: Buffer | null = null;
  let attributes: Asn1 | null = null;
  walk(root, (node) => {
    const children = nodes(node.value);
    const oid = children[0];
    if (!oid || oid.type !== forge.asn1.Type.OID || typeof oid.value !== "string") return;
    if (forge.asn1.derToOid(oid.value) !== messageDigest) return;
    const set = children[1];
    const octet = set ? nodes(set.value)[0] : undefined;
    if (!octet || typeof octet.value !== "string") return;
    digest = Buffer.from(octet.value, "binary");
  });
  walk(root, (node) => {
    if (node.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || node.type !== 0 || !node.constructed) return;
    const body = nodes(node.value).map((child) => nodes(child.value)[0]).filter((child): child is Asn1 => Boolean(child));
    if (body.some((child) => child.type === forge.asn1.Type.OID && typeof child.value === "string" && forge.asn1.derToOid(child.value) === messageDigest)) {
      attributes = node;
    }
  });
  assert.ok(digest, "el PKCS#7 no trae el resumen del documento");
  assert.deepEqual(digest, fileDigest);
  assert.ok(attributes, "el PKCS#7 no trae los atributos firmados");
  const der = forge.asn1.toDer(attributes as never).getBytes();
  const signedAttributes = `\x31${der.slice(1)}`;
  const md = forge.md.sha256.create();
  md.update(signedAttributes, "raw");
  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(extracted.signature));
  const signature = signerSignature(root);
  assert.ok(signature, "el PKCS#7 no trae la firma");
  const verified = p7.certificates.some((cert) => cert.publicKey.verify(md.digest().bytes(), signature));
  assert.equal(verified, true);
}

function signerSignature(root: Asn1): string | null {
  let found: string | null = null;
  walk(root, (node) => {
    const children = nodes(node.value);
    const attributes = children.find((child) => child.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && child.type === 0);
    if (!attributes) return;
    const signature = [...children].reverse().find((child) => child.type === forge.asn1.Type.OCTETSTRING && typeof child.value === "string" && child.value.length >= 64);
    if (signature && typeof signature.value === "string") found = signature.value;
  });
  return found;
}

test("un .p12 con la contraseña correcta firma el PDF y no guarda la clave", async () => {
  const p12 = makeP12(PASSWORD);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Texto del acta", { x: 40, y: 360, size: 14, font });
  const original = await pdf.save();
  assert.equal(hasCertificateSignature(original), false);
  const signed = await stampCertificate(original, p12, PASSWORD, { page: 1, x: 0.1, y: 0.55, w: 0.7, h: 0.18 });
  const text = Buffer.from(signed).toString("latin1");
  assert.match(text, /\/ByteRange\s*\[\s*\d+\s+\d+\s+\d+\s+\d+\s*\]/);
  assert.match(text, /\/Type\s*\/Sig/);
  assert.match(text, /\/SubFilter\s*\/adbe\.pkcs7\.detached/);
  assert.match(text, /Ana Prueba/);
  assert.ok((text.match(/ re f/g) ?? []).length > 40);
  assert.equal(text.includes(PASSWORD), false);
  assert.equal(hasCertificateSignature(signed), true);
  assertSignatureValid(signed, 1);
  const again = await PDFDocument.load(signed);
  assert.equal(again.getPageCount(), 1);
  assert.equal(decodeCertificate(Buffer.from(p12).toString("base64"))?.byteLength, p12.byteLength);
});

test("una segunda firma no invalida la primera", async () => {
  const p12 = makeP12(PASSWORD);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Texto del acta", { x: 40, y: 360, size: 14, font });
  const original = await pdf.save();
  const first = await stampCertificate(original, p12, PASSWORD, { page: 1, x: 0.08, y: 0.62, w: 0.8, h: 0.16 });
  const second = await stampCertificate(first, p12, PASSWORD, { page: 1, x: 0.08, y: 0.4, w: 0.8, h: 0.16 });
  assert.equal(Buffer.from(second.subarray(0, first.length)).equals(Buffer.from(first)), true);
  assertSignatureValid(second, 1);
  assertSignatureValid(second, 2);
  const raw = Buffer.from(second).toString("latin1");
  assert.ok((raw.match(/\/Subtype\s*\/Form/g) ?? []).length >= 2);
  assert.ok((raw.match(/Ana Prueba/g) ?? []).length >= 2);
  assert.match(raw, / Tj/);
  const { extractText, getDocumentProxy } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(second));
  const { text } = await extractText(document, { mergePages: true });
  const visible = Array.isArray(text) ? text.join("\n") : text;
  assert.match(visible, /Texto del acta/);
  const again = await PDFDocument.load(second);
  assert.equal(again.getPageCount(), 1);
});

test("una contraseña distinta no abre el certificado", async () => {
  const p12 = makeP12(PASSWORD);
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  await assert.rejects(
    () => stampCertificate(bytes, p12, "otra", { page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.2 }),
    /contraseña del certificado/,
  );
});

test("lo que no es un .p12 no se acepta", () => {
  assert.equal(decodeCertificate(""), null);
  assert.equal(decodeCertificate(Buffer.from("no-es-der").toString("base64")), null);
  assert.equal(decodeCertificate("a".repeat(4_000_001)), "big");
});
