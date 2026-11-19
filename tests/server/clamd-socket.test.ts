import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { scanBytes } from "../../src/server/clamd-socket.ts";

/**
 * INSTREAM against a fake clamd that, like the real one, reads the whole stream (up to the
 * zero-length chunk), answers and closes.
 */

const NUL = String.fromCharCode(0);

async function fakeClamd(
  onData: (socket: net.Socket, ended: boolean) => void,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    let tail = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      tail = Buffer.concat([tail, chunk]).subarray(-4);
      onData(socket, tail.length === 4 && tail.readUInt32BE(0) === 0);
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return { port: address.port, close: () => server.close() };
}

test("una detección llega como detección aunque clamd cierre enseguida", async () => {
  const clamd = await fakeClamd((socket, ended) => {
    if (ended) socket.end(`stream: Eicar-Test-Signature FOUND${NUL}`);
  });
  try {
    const reply = await scanBytes(new Uint8Array(8 * 1024 * 1024).fill(7), {
      host: "127.0.0.1",
      port: clamd.port,
    });
    assert.equal(reply.verdict, "infected");
    assert.equal(reply.signature, "Eicar-Test-Signature");
  } finally {
    clamd.close();
  }
});

test("el límite de tamaño de clamd llega como error con su texto", async () => {
  const clamd = await fakeClamd((socket, ended) => {
    if (ended) socket.end(`INSTREAM size limit exceeded. ERROR${NUL}`);
  });
  try {
    const reply = await scanBytes(new Uint8Array(8 * 1024 * 1024).fill(7), {
      host: "127.0.0.1",
      port: clamd.port,
    });
    assert.equal(reply.verdict, "error");
    assert.match(reply.detail, /size limit exceeded/);
  } finally {
    clamd.close();
  }
});

test("sin respuesta y con reset: falla", async () => {
  const clamd = await fakeClamd((socket) => socket.resetAndDestroy());
  try {
    await assert.rejects(
      scanBytes(new Uint8Array(1024), { host: "127.0.0.1", port: clamd.port }, 5000),
    );
  } finally {
    clamd.close();
  }
});
