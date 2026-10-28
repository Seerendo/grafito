/**
 * Archivo .zip escrito sobre la marcha (solo servidor): cada entrada se manda
 * según se lee, sin comprimir (método «stored») y sin tenerla entera en
 * memoria. Los tamaños y el CRC de cada una van después de sus datos
 * (descriptor de datos, bit 3), y los nombres en UTF-8 (bit 11). Sin ZIP64:
 * hasta 4 GB y 65.535 entradas (`ZIP_LIMIT`, `ZIP_MAX_ENTRIES`).
 */

export const ZIP_LIMIT = 0xffff_ffff;
export const ZIP_MAX_ENTRIES = 0xffff;

export type ZipEntry = {
  /** Ruta dentro del zip, con `/`. */
  path: string;
  modified: number;
  /** El contenido; `null` si ya no está (se omite la entrada). */
  read: () => Promise<ReadableStream<Uint8Array> | Uint8Array | null>;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** Fecha y hora en el formato de MS-DOS que usa el zip (hora local, de 2 en 2 s). */
function dosTime(ms: number): { time: number; date: number } {
  const at = new Date(ms);
  const year = Math.min(Math.max(at.getFullYear(), 1980), 2107);
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const FLAGS = 0x0808;

function localHeader(name: Uint8Array, when: { time: number; date: number }): Uint8Array {
  const out = new Uint8Array(30 + name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, FLAGS, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, when.time, true);
  view.setUint16(12, when.date, true);
  // CRC y tamaños: en el descriptor de datos.
  view.setUint16(26, name.length, true);
  out.set(name, 30);
  return out;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return out;
}

type Written = { name: Uint8Array; when: { time: number; date: number }; crc: number; size: number; offset: number };

function centralEntry(entry: Written): Uint8Array {
  const out = new Uint8Array(46 + entry.name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, FLAGS, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, entry.when.time, true);
  view.setUint16(14, entry.when.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.length, true);
  view.setUint32(42, entry.offset, true);
  out.set(entry.name, 46);
  return out;
}

function endOfCentral(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return out;
}

/** El zip de `entries`, en orden. Falla (corta la descarga) si pasa de 4 GB. */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const written: Written[] = [];
  let offset = 0;
  let index = 0;
  const grow = (bytes: number) => {
    offset += bytes;
    if (offset > ZIP_LIMIT) throw new Error("El zip pasa de 4 GB.");
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Las que ya no están se saltan aquí: un `pull` que no encola nada no se repite.
      let content: Awaited<ReturnType<ZipEntry["read"]>> = null;
      let entry: ZipEntry | undefined;
      while (!content && index < entries.length) {
        entry = entries[index++]!;
        content = await entry.read();
      }
      if (!content || !entry) {
        const start = offset;
        let size = 0;
        for (const entry of written) {
          const chunk = centralEntry(entry);
          controller.enqueue(chunk);
          size += chunk.length;
        }
        controller.enqueue(endOfCentral(written.length, size, start));
        controller.close();
        return;
      }
      const name = encoder.encode(entry.path);
      const when = dosTime(entry.modified);
      const at = offset;
      const header = localHeader(name, when);
      controller.enqueue(header);
      grow(header.length);
      let crc = 0;
      let size = 0;
      if (content instanceof Uint8Array) {
        crc = crc32(content);
        size = content.length;
        controller.enqueue(content);
        grow(size);
      } else {
        const reader = content.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(value, crc);
          size += value.length;
          controller.enqueue(value);
          grow(value.length);
        }
      }
      controller.enqueue(dataDescriptor(crc, size));
      grow(16);
      written.push({ name, when, crc, size, offset: at });
    },
  });
}

/** Nombre válido para un archivo o carpeta en cualquier sistema. */
export function safeName(name: string, fallback: string): string {
  const clean = name
    // Los caracteres de control tampoco valen en un nombre de archivo.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 150);
  return clean || fallback;
}

/** `name` sin repetir dentro de `taken` (sin distinguir mayúsculas): «Acta (2).pdf». */
export function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
