import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, safeName, uniqueName, zipStream } from "./zip.ts";

/** Zip en streaming: lo que se escribe se vuelve a leer igual (directorio central, CRC, tamaños). */

function readZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    const start = offset + 30 + view.getUint16(offset + 26, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc);
    assert.equal(view.getUint32(start + size, true), 0x08074b50);
    out.push({ name, data });
    at += 46 + nameLength;
  }
  return out;
}

test("escribe entradas de bytes y de streams, y omite las que no están", async () => {
  const big = new Uint8Array(200_000).map((_, i) => i % 251);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(big.subarray(0, 70_000));
      controller.enqueue(big.subarray(70_000));
      controller.close();
    },
  });
  const zip = zipStream([
    { path: "Atlas/Acta ñandú.md", modified: Date.UTC(2026, 9, 28), read: async () => new TextEncoder().encode("# Hola") },
    { path: "Atlas/plano.bin", modified: Date.now(), read: async () => stream },
    { path: "falta.pdf", modified: Date.now(), read: async () => null },
  ]);
  const bytes = new Uint8Array(await new Response(zip).arrayBuffer());
  const entries = readZip(bytes);
  assert.deepEqual(entries.map((entry) => entry.name), ["Atlas/Acta ñandú.md", "Atlas/plano.bin"]);
  assert.equal(new TextDecoder().decode(entries[0]!.data), "# Hola");
  assert.deepEqual(entries[1]!.data, big);
});

test("crc32 conocido", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("nombres válidos y sin repetir", () => {
  assert.equal(safeName('Plan: "v2" / final.', "x"), "Plan v2 final");
  assert.equal(safeName("  ..  ", "Nota"), "Nota");
  const taken = new Set<string>();
  assert.equal(uniqueName("Acta.md", taken), "Acta.md");
  assert.equal(uniqueName("acta.md", taken), "acta (2).md");
  assert.equal(uniqueName("Acta.md", taken), "Acta (3).md");
});
