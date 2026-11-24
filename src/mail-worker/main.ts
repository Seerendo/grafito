import { getSql } from "@/lib/db";
import { adoptInstallSecrets } from "@/server/install-secrets";
import { MailWorker } from "@/server/mail/worker";
import { logEvent } from "@/server/telemetry";

/**
 * Entry point of the grafito-mail-sync process (the mail-sync service in docker-compose.yml): the
 * same image as the app, started with `node .output-mail/main.mjs`. It needs Postgres
 * (DATABASE_URL) because the web app and the worker share the queue. MAIL_SYNC_ENABLED=false
 * keeps it idle: no heartbeat, so the Correo extension shows it as not connected.
 */

async function listen(worker: MailWorker): Promise<() => Promise<void>> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return async () => undefined;
  const { Client } = await import("pg");
  let client: import("pg").Client | null = null;
  let closed = false;
  const connect = async () => {
    if (closed) return;
    const next = new Client({ connectionString: url });
    next.on("notification", () => worker.nudge());
    next.on("error", () => {
      client = null;
      setTimeout(() => void connect().catch(() => undefined), 5000);
    });
    await next.connect();
    await next.query("listen mail_job");
    client = next;
  };
  await connect().catch(() => setTimeout(() => void connect().catch(() => undefined), 5000));
  return async () => {
    closed = true;
    await client?.end().catch(() => undefined);
  };
}

async function main(): Promise<void> {
  if (process.env.MAIL_SYNC_ENABLED === "false") {
    logEvent("mail.worker.disabled");
    setInterval(() => undefined, 1 << 30);
    return;
  }
  if (!process.env.DATABASE_URL?.trim()) {
    logEvent("mail.worker.disabled", { reason: "no DATABASE_URL" });
    setInterval(() => undefined, 1 << 30);
    return;
  }
  // The app creates the installation secrets on its first start; wait for them.
  while (!adoptInstallSecrets()) {
    logEvent("mail.worker.waiting", { reason: "installation secrets" });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const sql = await getSql();
  const raw = Number(process.env.MAIL_SYNC_CONCURRENCY);
  const worker = new MailWorker(sql, Number.isInteger(raw) && raw > 0 ? raw : null);
  const unlisten = await listen(worker);
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logEvent("mail.worker.signal", { signal });
    await worker.stop();
    await unlisten();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("unhandledRejection", (error) =>
    logEvent("mail.worker.unhandled", {
      error: error instanceof Error ? error.message.slice(0, 200) : "?",
    }),
  );
  await worker.start();
}

void main().catch((error) => {
  logEvent("mail.worker.fatal", {
    error: error instanceof Error ? error.message.slice(0, 300) : "?",
  });
  process.exit(1);
});
