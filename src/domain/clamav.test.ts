import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clamavEndpoint,
  DEFAULT_CLAMAV,
  parseClamavConfig,
  parseClamdReply,
  scanDecision,
} from "./clamav.ts";

test("clamd: limpio, infectado y fallo", () => {
  assert.equal(parseClamdReply("stream: OK\0").verdict, "clean");
  const hit = parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND");
  assert.equal(hit.verdict, "infected");
  assert.equal(hit.signature, "Win.Test.EICAR_HDB-1");
  assert.equal(parseClamdReply("").verdict, "error");
  assert.equal(parseClamdReply("INSTREAM size limit exceeded. ERROR").verdict, "error");
});

test("la pantalla solo acepta un servidor, un puerto y un plazo válidos", () => {
  const ok = parseClamavConfig({ enabled: true, host: "clamav", port: 3310, timeoutSeconds: 60 });
  assert.equal(ok.ok, true);
  assert.equal(
    parseClamavConfig({ enabled: true, host: "", port: 3310, timeoutSeconds: 60 }).ok,
    false,
  );
  assert.equal(
    parseClamavConfig({ enabled: false, host: "", port: 3310, timeoutSeconds: 60 }).ok,
    true,
  );
  assert.equal(
    parseClamavConfig({ enabled: true, host: "clam av", port: 3310, timeoutSeconds: 60 }).ok,
    false,
  );
  assert.equal(
    parseClamavConfig({ enabled: true, host: "127.0.0.1", port: 0, timeoutSeconds: 60 }).ok,
    false,
  );
  assert.equal(
    parseClamavConfig({ enabled: true, host: "clamav", port: 3310, timeoutSeconds: 4 }).ok,
    false,
  );
  assert.deepEqual(
    clamavEndpoint({ enabled: false, host: "clamav", port: 3310, timeoutSeconds: 60 }),
    null,
  );
  assert.deepEqual(
    clamavEndpoint({ enabled: true, host: "clamav", port: 3310, timeoutSeconds: 60 }),
    {
      host: "clamav",
      port: 3310,
    },
  );
});

test("sin valores guardados, el antivirus queda activo en clamav:3310", () => {
  assert.equal(DEFAULT_CLAMAV.enabled, true);
  assert.equal(DEFAULT_CLAMAV.host, "clamav");
  assert.equal(DEFAULT_CLAMAV.port, 3310);
  assert.equal(DEFAULT_CLAMAV.timeoutSeconds, 60);
  assert.deepEqual(clamavEndpoint(DEFAULT_CLAMAV), { host: "clamav", port: 3310 });
});

test("sin host se permite; configurado solo pasa si está limpio", () => {
  assert.equal(scanDecision(false, "infected"), "allow");
  assert.equal(scanDecision(true, "off"), "allow");
  assert.equal(scanDecision(true, "clean"), "allow");
  assert.equal(scanDecision(true, "infected"), "reject");
  assert.equal(scanDecision(true, "error"), "reject");
});
