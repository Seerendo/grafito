import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { officeText } from "./office-text.ts";

/** Texto de documentos de Office para la IA: Word, Excel, PowerPoint y OpenDocument. */

/** Un ZIP mínimo (sin CRC: el lector no lo comprueba), comprimido o no. */
function zip(files: Record<string, string>, deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8");
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const SAMPLE_DOCX = "UEsDBBQAAAAIADOxWV15bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgAM7FZXZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIADOxWV2+0/BtpwAAAOUAAAARAAAAd29yZC9kb2N1bWVudC54bWxFjsEOgjAMhl9l2V2GHowhgDeNd32AsRVYwtqlGyJvL8ODl+9v0z9fWl8/fhJv4OgIG3ksSikADVmHQyNfz9vhIkVMGq2eCKGRK0R5beulsmRmD5jEJsBYLY0cUwqVUtGM4HUsKABut57Y67StPKiF2AYmAzFufj+pU1meldcOZVZ2ZNecIYMzUvvALABhQQSeodN5urPuXaJa5UYm7ww7fxb1/7D9AlBLAQIUABQAAAAIADOxWV15bjPX6AAAAK0BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQAFAAAAAgAM7FZXZv9N+qtAAAAKQEAAAsAAAAAAAAAAAAAAIABGQEAAF9yZWxzLy5yZWxzUEsBAhQAFAAAAAgAM7FZXb7T8G2nAAAA5QAAABEAAAAAAAAAAAAAAIAB7wEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAMUCAAAAAA==";

test("lee un .docx real (Word)", () => {
  const text = officeText("Prueba.docx", new Uint8Array(Buffer.from(SAMPLE_DOCX, "base64")));
  assert.ok(text && text.includes("Informe de prueba de Grafito"), String(text));
});

test("lee las hojas de un .xlsx con sus textos compartidos y números", () => {
  const book = zip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="Ventas" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml": "<sst><si><t>Mes</t></si><si><t>Total</t></si><si><t>Enero &amp; Febrero</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1250.5</v></c></row></sheetData></worksheet>',
  });
  assert.equal(officeText("ventas.xlsx", book), "— Hoja «Ventas» —\nMes\tTotal\nEnero & Febrero\t1250.5");
});

test("lee las diapositivas de un .pptx en orden", () => {
  const deck = zip({
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Segunda</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Décima</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Portada</a:t></a:r></a:p><a:p><a:r><a:t>Subtítulo</a:t></a:r></a:p></p:sld>",
  });
  assert.equal(
    officeText("charla.pptx", deck),
    "— Diapositiva 1 —\nPortada\nSubtítulo\n\n— Diapositiva 2 —\nSegunda\n\n— Diapositiva 3 —\nDécima",
  );
});

test("lee un OpenDocument sin comprimir (.odt)", () => {
  const odt = zip({ "content.xml": "<office:text><text:h>Acta</text:h><text:p>Punto uno</text:p></office:text>" }, false);
  assert.equal(officeText("acta.odt", odt), "Acta\nPunto uno");
});

test("otros tipos o datos rotos: null", () => {
  assert.equal(officeText("foto.png", new Uint8Array([1, 2, 3])), null);
  assert.equal(officeText("roto.docx", new Uint8Array([1, 2, 3, 4])), null);
});
