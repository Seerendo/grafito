import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION } from "../../src/domain/permissions.ts";
import {
  assignSegments,
  davDepth,
  davHref,
  davLockedOut,
  davPermitted,
  davShows,
  isMarkdownName,
  lockSeconds,
  matchSegment,
  noteFileName,
  noteTitleFromName,
  overwriteAllowed,
  parseDavPath,
  pathFromDestination,
  presentedLock,
  propfindXml,
  sanitizeBase,
} from "../../src/domain/dav.ts";

const member = {
  isAdmin: false,
  permissions: [PERMISSION.notesRead, PERMISSION.notesEdit, PERMISSION.filesDownload],
};
const admin = { isAdmin: true, permissions: [] as string[] };

test("la ruta separa la bóveda propia de lo compartido", () => {
  assert.deepEqual(parseDavPath("/dav"), { kind: "root" });
  assert.deepEqual(parseDavPath("/dav/"), { kind: "root" });
  assert.deepEqual(parseDavPath("/dav/Personal/Notas/Acta.md"), {
    kind: "personal",
    segments: ["Notas", "Acta.md"],
  });
  assert.deepEqual(parseDavPath("/dav/Compartidos/Equipo"), {
    kind: "shares",
    segments: ["Equipo"],
  });
  assert.equal(parseDavPath("/dav/Otra").kind, "bad");
  assert.equal(parseDavPath("/dav/Personal/%2e%2e").kind, "bad");
  assert.equal(parseDavPath("/dav/Personal/a%2Fb").kind, "bad");
  assert.deepEqual(parseDavPath("/dav/Personal/Hola%20mundo.md"), {
    kind: "personal",
    segments: ["Hola mundo.md"],
  });
});

test("un administrador no escribe en lo compartido si ese nodo es de solo lectura", () => {
  assert.equal(davPermitted("edit-note", admin, { read: true, write: false }), false);
  assert.equal(davPermitted("upload-file", admin, { read: true, write: false }), false);
  assert.equal(davPermitted("read-note", admin, { read: true, write: false }), true);
  assert.equal(davPermitted("edit-note", admin, null), true);
  assert.equal(davPermitted("upload-file", member, null), false);
  assert.equal(davPermitted("edit-note", member, { read: true, write: true }), true);
  assert.equal(davPermitted("list", { isAdmin: false, permissions: [] }, null), false);
});

test("quien solo descarga archivos no ve los nombres de las notas", () => {
  const files = { isAdmin: false, permissions: [PERMISSION.filesDownload] };
  assert.equal(davShows(files, "file"), true);
  assert.equal(davShows(files, "markdown"), false);
  assert.equal(davShows(files, "portfolio"), true);
});

test("los nombres repetidos se distinguen y el título de una nota vuelve del archivo", () => {
  const named = assignSegments([
    { id: "abcdef12", base: "Acta" },
    { id: "98765432", base: "acta" },
    { id: "solo", base: "Único" },
  ]);
  assert.equal(named.find((item) => item.id === "solo")?.segment, "Único");
  assert.equal(matchSegment(named, "Acta"), null);
  assert.equal(matchSegment(named, "Acta (abcdef).md".replace(".md", "")), "abcdef12");
  assert.equal(noteFileName("Bitácora"), "Bitácora.md");
  assert.equal(noteTitleFromName("Bitácora.md"), "Bitácora");
  assert.equal(isMarkdownName("nota.MD"), true);
  assert.equal(sanitizeBase("a/b\\c"), "a b c");
  assert.equal(sanitizeBase("fin."), "fin");
});

test("profundidad, destino y pisar", () => {
  assert.deepEqual(davDepth(null), { depth: 1 });
  assert.deepEqual(davDepth("0"), { depth: 0 });
  assert.deepEqual(davDepth("infinity"), { reject: true });
  assert.equal(overwriteAllowed(null), true);
  assert.equal(overwriteAllowed("F"), false);
  assert.equal(
    pathFromDestination("https://notas.ejemplo/dav/Personal/A.md", "https://notas.ejemplo/dav/"),
    "/dav/Personal/A.md",
  );
  assert.equal(davHref(["Personal", "A b.md"], false), "/dav/Personal/A%20b.md");
  assert.equal(davHref(["Personal"], true), "/dav/Personal/");
});

test("el XML escapa el nombre y un bloqueo lee el token", () => {
  const xml = propfindXml([
    {
      href: "/dav/Personal/a&b.md",
      name: "a<b>",
      collection: false,
      bytes: 3,
      mime: "text/markdown",
      modifiedMs: 0,
    },
  ]);
  assert.ok(xml.includes("a&amp;b.md"));
  assert.ok(xml.includes("a&lt;b&gt;"));
  assert.ok(!xml.includes("<d:collection/>"));
  assert.equal(presentedLock("(<opaquelocktoken:ABC-1>)"), "opaquelocktoken:abc-1");
  assert.equal(lockSeconds("Second-99999"), 3600);
  assert.equal(lockSeconds(null), 600);
});

test("veinte fallos en la ventana cierran la entrada", () => {
  const now = 1_000_000;
  const stamps = Array.from({ length: 20 }, () => now - 1000);
  assert.equal(davLockedOut(stamps, now), true);
  assert.equal(davLockedOut(stamps.slice(0, 19), now), false);
  assert.equal(
    davLockedOut(
      stamps.map(() => now - 11 * 60 * 1000),
      now,
    ),
    false,
  );
});
