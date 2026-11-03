/**
 * Signature version identity includes title plus note text or file storage key. The server
 * hashes it with SHA-256 to detect later changes; it is not a certificate.
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
