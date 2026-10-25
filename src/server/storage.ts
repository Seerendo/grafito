import { objectStorageEnv } from "./platform";

export async function probeBucket(): Promise<{ ok: boolean; detail: string }> {
  const storage = objectStorageEnv();
  if (!storage) {
    return {
      ok: false,
      detail: "No hay bucket configurado. Los archivos siguen en la bóveda del navegador.",
    };
  }
  try {
    const response = await fetch(`${storage.endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { ok: false, detail: `El bucket respondió ${response.status}.` };
    return { ok: true, detail: `MinIO listo. Cubo «${storage.bucket}».` };
  } catch {
    return { ok: false, detail: "MinIO no responde. Los archivos siguen en la bóveda." };
  }
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sumMetric(text: string, name: string): number | null {
  const pattern = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\S+)`, "gm");
  let total = 0;
  let found = false;
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

export async function minioSpace(): Promise<{ total: number; available: number; used: number } | null> {
  const storage = objectStorageEnv();
  if (!storage) return null;
  try {
    const metrics = await fetch(`${storage.endpoint}/minio/v2/metrics/cluster`, { signal: AbortSignal.timeout(1500) });
    if (metrics.ok) {
      const text = await metrics.text();
      const total = sumMetric(text, "minio_cluster_capacity_usable_total_bytes");
      const available = sumMetric(text, "minio_cluster_capacity_usable_free_bytes");
      if (total != null && available != null && total > 0) {
        return { total, available, used: Math.max(0, total - available) };
      }
    }
  } catch {
    /* the signed info call is the fallback */
  }
  try {
    return await minioAdminDisk(storage);
  } catch {
    return null;
  }
}

async function minioAdminDisk(
  storage: NonNullable<ReturnType<typeof objectStorageEnv>>,
): Promise<{ total: number; available: number; used: number } | null> {
  const { createHash, createHmac } = await import("node:crypto");
  const url = new URL(`${storage.endpoint}/minio/admin/v3/info`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const region = storage.region || "us-east-1";
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${EMPTY_HASH}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", url.pathname, "", canonicalHeaders, signedHeaders, EMPTY_HASH].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
  const signing = hmac(hmac(hmac(hmac(`AWS4${storage.secretKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signing).update(stringToSign).digest("hex");
  const response = await fetch(url, {
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${storage.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": EMPTY_HASH,
    },
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    servers?: { disks?: { totalspace?: number; usedspace?: number; availspace?: number }[] }[];
  };
  let total = 0;
  let available = 0;
  let used = 0;
  for (const server of data.servers ?? []) {
    for (const disk of server.disks ?? []) {
      total += Number(disk.totalspace ?? 0);
      available += Number(disk.availspace ?? 0);
      used += Number(disk.usedspace ?? 0);
    }
  }
  if (!Number.isFinite(total) || total <= 0) return null;
  return { total, available, used };
}