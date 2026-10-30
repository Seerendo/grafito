/**
 * De qué versión es una firma: el título y, en una nota, el texto; en un
 * archivo, la clave con la que está guardado (cambia en cada guardado).
 * El servidor guarda el SHA-256 de este texto. No es un certificado: solo
 * permite saber si el documento cambió después de firmar.
 */
export function signatureMaterial(input: {
  kind: "markdown" | "file";
  title: string;
  content: string;
  fileKey: string;
}): string {
  const body = input.kind === "file" ? input.fileKey : input.content;
  return `${input.kind}\n${input.title}\n${body}`;
}
