import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTarget, classifyIp, hostListed } from "../../src/domain/mail/hosts.ts";
import {
  decodeCursor,
  encodeCursor,
  folderPlan,
  htmlToText,
  messageMarkdown,
  riskyAttachment,
  safeFileName,
  snippetOf,
  specialUseOf,
  vanished,
} from "../../src/domain/mail/message.ts";
import {
  backoffMs,
  domainAllowed,
  historyDays,
  parseMailPolicy,
  syncInterval,
} from "../../src/domain/mail/policy.ts";
import { swapSignature, withSignature } from "../../src/domain/mail/compose.ts";

/** The email module's pure rules: policy, where IMAP may connect, folders, archiving, cursors. */

test("la política se completa y se acota", () => {
  const policy = parseMailPolicy({
    concurrency: 9999,
    minIntervalSeconds: 5,
    providers: ["imap", "otro"],
    domains: [" UNI.edu ", "uni.edu"],
  });
  assert.equal(policy.concurrency, 64);
  assert.equal(policy.minIntervalSeconds, 60);
  assert.deepEqual(policy.providers, ["imap"]);
  assert.deepEqual(policy.domains, ["uni.edu"]);
  assert.equal(parseMailPolicy(null).defaultIntervalSeconds, 300);
  assert.equal(syncInterval(policy, 10), 60);
  assert.equal(syncInterval(parseMailPolicy({}), undefined), 300);
  assert.equal(historyDays(parseMailPolicy({ maxHistoryDays: 10 }), 365), 10);
  assert.equal(historyDays(parseMailPolicy({}), 0), 30);
  assert.equal(domainAllowed(policy, "ana@uni.edu"), true);
  assert.equal(domainAllowed(policy, "ana@fac.uni.edu"), true);
  assert.equal(domainAllowed(policy, "ana@otro.org"), false);
});

test("el reintento crece con jitter y respeta Retry-After", () => {
  assert.ok(backoffMs(1, 0) >= 15_000 && backoffMs(1, 1) <= 30_000);
  assert.ok(backoffMs(5, 1) <= 30_000 * 16);
  assert.equal(backoffMs(20, 1), 60 * 60 * 1000);
  assert.equal(backoffMs(1, 0, 120_000), 120_000);
});

test("SSRF: loopback, enlace local, metadatos y servicios internos nunca; red privada solo con perfil", () => {
  assert.equal(classifyIp("127.0.0.1"), "loopback");
  assert.equal(classifyIp("::1"), "loopback");
  assert.equal(classifyIp("169.254.169.254"), "metadata");
  assert.equal(classifyIp("::ffff:169.254.169.254"), "metadata");
  assert.equal(classifyIp("::ffff:a9fe:a9fe"), "metadata");
  assert.equal(classifyIp("fd00:ec2::254"), "metadata");
  assert.equal(classifyIp("10.1.2.3"), "private");
  assert.equal(classifyIp("192.168.0.10"), "private");
  assert.equal(classifyIp("fd12:3456::1"), "private");
  assert.equal(classifyIp("8.8.8.8"), "public");
  const target = (host: string, addresses: string[], trusted = false, port = 993) =>
    checkTarget({ host, port, addresses, trusted });
  assert.equal(target("imap.gmail.com", ["142.250.0.109"]).ok, true);
  assert.equal(target("mail.uni.edu", ["10.0.0.5"]).ok, false);
  assert.equal(target("mail.uni.edu", ["10.0.0.5"], true).ok, true);
  // A name that resolves to loopback or metadata is refused even when trusted (DNS rebinding).
  assert.equal(target("mail.uni.edu", ["127.0.0.1"], true).ok, false);
  assert.equal(target("evil.example", ["93.184.216.34", "169.254.169.254"]).ok, false);
  assert.equal(target("postgres", ["172.18.0.2"], true).ok, false);
  assert.equal(target("imap.gmail.com", ["142.250.0.109"], false, 22).ok, false);
  assert.equal(target("imap.gmail.com", ["142.250.0.109"], false, 143).ok, true);
  // Sending: SMTP submission ports only, the same address rules.
  const smtp = (host: string, addresses: string[], port: number, trusted = false) =>
    checkTarget({ host, port, addresses, trusted, service: "smtp" });
  assert.equal(smtp("smtp.gmail.com", ["142.250.0.108"], 587).ok, true);
  assert.equal(smtp("smtp.gmail.com", ["142.250.0.108"], 465).ok, true);
  assert.equal(smtp("smtp.gmail.com", ["142.250.0.108"], 25).ok, false);
  assert.equal(smtp("smtp.gmail.com", ["142.250.0.108"], 993).ok, false);
  assert.equal(smtp("relay.uni.edu", ["10.0.0.9"], 587).ok, false);
  assert.equal(smtp("relay.uni.edu", ["10.0.0.9"], 587, true).ok, true);
  assert.equal(smtp("relay.uni.edu", ["169.254.169.254"], 587, true).ok, false);
  assert.equal(hostListed("mail.uni.edu", ["*.uni.edu"]), true);
  assert.equal(hostListed("uni.edu", ["*.uni.edu"]), false);
  assert.equal(hostListed("evil-uni.edu", ["*.uni.edu"]), false);
});

test("los roles de carpeta salen de lo que declara el servidor y, si no, del nombre", () => {
  assert.equal(specialUseOf("INBOX", null), "inbox");
  assert.equal(specialUseOf("Cosas", "\\Sent"), "sent");
  assert.equal(specialUseOf("Elementos enviados", null), "sent");
  assert.equal(specialUseOf("INBOX/Spam", null, "/"), "junk");
  assert.equal(specialUseOf("Proyectos/2026", null), "");
});

test("texto, fragmento y nombres de archivo seguros", () => {
  assert.equal(
    htmlToText("<p>Hola&nbsp;<b>Ana</b></p><script>x()</script><p>Fin</p>"),
    "Hola Ana\nFin",
  );
  assert.equal(snippetOf("> citado\nTexto nuevo\n> más"), "Texto nuevo");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("..\\..\\win.ini"), "win.ini");
  assert.equal(safeFileName("CON"), "adjunto");
  assert.equal(safeFileName("a\u0000b.pdf"), "ab.pdf");
  assert.ok(safeFileName(`${"x".repeat(300)}.pdf`).endsWith(".pdf"));
  assert.equal(riskyAttachment("factura.pdf.exe"), true);
  assert.equal(riskyAttachment("factura.pdf"), false);
});

test("el mensaje archivado conserva la procedencia y no se interpreta como Markdown", () => {
  const markdown = messageMarkdown({
    subject: "Acta | *importante*",
    from: { name: "Ana", address: "ana@uni.edu" },
    to: [{ name: "", address: "beto@uni.edu" }],
    cc: [],
    date: Date.UTC(2026, 10, 20, 9, 30),
    account: "ana@uni.edu",
    messageId: "<abc@uni.edu>",
    text: "Hola\n```\n[[Enlace]] #etiqueta",
    attachments: [{ name: "acta.pdf", size: 2048 }],
    archivedAt: Date.UTC(2026, 10, 21),
  });
  assert.ok(markdown.startsWith("# Acta \\| \\*importante\\*"));
  assert.ok(markdown.includes("| Message-ID | \\<abc@uni.edu\\> |"));
  assert.ok(markdown.includes("````text\nHola\n```\n[[Enlace]] #etiqueta\n````"));
  assert.ok(markdown.includes("- acta.pdf (2 KB)"));
});

test("cursor de la lista y plan de sincronización de una carpeta", () => {
  const cursor = encodeCursor(1700000000000, "abc");
  assert.deepEqual(decodeCursor(cursor), { at: 1700000000000, id: "abc" });
  assert.equal(decodeCursor("basura"), null);
  assert.deepEqual(
    folderPlan({ storedValidity: 5, serverValidity: 6, lastUid: 90, backfillDone: true }),
    {
      reset: true,
      fromUid: 1,
      backfill: true,
    },
  );
  assert.deepEqual(
    folderPlan({ storedValidity: 5, serverValidity: 5, lastUid: 90, backfillDone: true }),
    {
      reset: false,
      fromUid: 91,
      backfill: false,
    },
  );
  assert.deepEqual(vanished([1, 2, 3, 5], [1, 3, 4]), [2, 5]);
});

test("la firma va debajo de un mensaje nuevo y encima del texto citado", () => {
  assert.equal(withSignature("", "Ana\nMSP"), "\n\n-- \nAna\nMSP");
  assert.equal(withSignature("Hola", "Ana"), "Hola\n\n-- \nAna");
  assert.equal(
    withSignature("\n\nEl lunes, Beto escribió:\n> hola", "Ana"),
    "\n\n-- \nAna\n\nEl lunes, Beto escribió:\n> hola",
  );
  assert.equal(withSignature("Hola", "  "), "Hola");
  assert.equal(swapSignature("Hola\n\n-- \nAna", "Ana", "Ana (MSP)"), "Hola\n\n-- \nAna (MSP)");
  assert.equal(swapSignature("Hola", "", "Ana"), "Hola\n\n-- \nAna");
  assert.equal(swapSignature("Hola\n\n-- \nAna", "Ana", ""), "Hola");
});
