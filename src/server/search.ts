import { elasticUrl } from "./platform";

export type IndexDoc = {
  id: string;
  title: string;
  kind: string;
  portfolioId: string | null;
  body: string;
  links: { targetId: string; kind: string }[];
};

const INDEX = "grafito-docs";

async function ensureIndex(base: string): Promise<void> {
  const head = await fetch(`${base}/${INDEX}`, { method: "HEAD" });
  if (head.ok) {
    // El índice ya creado gana el campo nuevo sin rehacer los documentos.
    await fetch(`${base}/${INDEX}/_mapping`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ properties: { portfolioId: { type: "keyword" } } }),
    }).catch(() => undefined);
    return;
  }
  if (head.status !== 404) return;
  await fetch(`${base}/${INDEX}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mappings: {
        properties: {
          userId: { type: "keyword" },
          docId: { type: "keyword" },
          title: { type: "text" },
          kind: { type: "keyword" },
          portfolioId: { type: "keyword" },
          body: { type: "text" },
          links: { type: "text" },
        },
      },
    }),
  });
}

export async function mirrorToElastic(userId: string, docs: IndexDoc[]): Promise<{ ok: boolean; reason?: string }> {
  const base = elasticUrl();
  if (!base) return { ok: false, reason: "sin elasticsearch" };
  try {
    await ensureIndex(base);
    await fetch(`${base}/${INDEX}/_delete_by_query?conflicts=proceed&refresh=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { term: { userId } } }),
    });
    if (docs.length === 0) return { ok: true };
    const lines: string[] = [];
    for (const doc of docs) {
      lines.push(JSON.stringify({ index: { _id: `${userId}:${doc.id}` } }));
      lines.push(
        JSON.stringify({
          userId,
          docId: doc.id,
          title: doc.title,
          kind: doc.kind,
          portfolioId: doc.portfolioId,
          body: doc.body,
          links: doc.links.map((link) => `${link.kind}:${link.targetId}`).join(" "),
        }),
      );
    }
    const bulk = await fetch(`${base}/${INDEX}/_bulk?refresh=true`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${lines.join("\n")}\n`,
    });
    if (!bulk.ok) return { ok: false, reason: `elasticsearch ${bulk.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "elasticsearch no responde" };
  }
}

/** Una sola nota o tabla, sin borrar el resto del índice. */
export async function upsertElasticDoc(userId: string, doc: IndexDoc, refresh = false): Promise<void> {
  const base = elasticUrl();
  if (!base) return;
  try {
    await ensureIndex(base);
    const query = refresh ? "?refresh=true" : "";
    await fetch(`${base}/${INDEX}/_doc/${encodeURIComponent(`${userId}:${doc.id}`)}${query}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId,
        docId: doc.id,
        title: doc.title,
        kind: doc.kind,
        portfolioId: doc.portfolioId,
        body: doc.body,
        links: doc.links.map((link) => `${link.kind}:${link.targetId}`).join(" "),
      }),
    });
  } catch {
    /* Sin Elasticsearch la búsqueda sigue en Postgres. */
  }
}

/** Quita un documento del índice. No falla si Elasticsearch no está. */
export async function deleteElasticDoc(userId: string, docId: string): Promise<void> {
  const base = elasticUrl();
  if (!base) return;
  try {
    await fetch(`${base}/${INDEX}/_doc/${encodeURIComponent(`${userId}:${docId}`)}`, { method: "DELETE" });
  } catch {
    /* El barrido lo intenta de nuevo con el siguiente documento. */
  }
}

export type ElasticHit = {
  id: string;
  title: string;
  kind: string;
  portfolioId: string | null;
  snippet: string;
};

export async function searchElastic(userId: string, query: string): Promise<ElasticHit[] | null> {
  const base = elasticUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/${INDEX}/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        size: 20,
        _source: ["docId", "title", "kind", "portfolioId"],
        query: {
          bool: {
            filter: [{ term: { userId } }],
            should: [
              { match_phrase: { title: { query } } },
              { match_phrase: { body: { query } } },
            ],
            minimum_should_match: 1,
          },
        },
      }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      hits?: {
        hits?: {
          _source?: { docId?: string; title?: string; kind?: string; portfolioId?: string | null };
        }[];
      };
    };
    return (data.hits?.hits ?? [])
      .map((hit) => ({
        id: hit._source?.docId ?? "",
        title: hit._source?.title ?? "",
        kind: hit._source?.kind ?? "markdown",
        portfolioId: hit._source?.portfolioId ?? null,
        snippet: "",
      }))
      .filter((hit) => hit.id);
  } catch {
    return null;
  }
}

export async function probeElastic(): Promise<{ ok: boolean; detail: string }> {
  const base = elasticUrl();
  if (!base) return { ok: false, detail: "Sin Elasticsearch. El índice queda en Postgres." };
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { ok: false, detail: `Elasticsearch respondió ${response.status}.` };
    const data = (await response.json()) as { version?: { number?: string } };
    const version = data.version?.number;
    return { ok: true, detail: version ? `Elasticsearch ${version}.` : "Elasticsearch listo." };
  } catch {
    return { ok: false, detail: "Elasticsearch no responde. El índice queda en Postgres." };
  }
}

/** Bytes que ocupa el índice de Grafito en Elasticsearch. */
export async function elasticStoreBytes(): Promise<number | null> {
  const base = elasticUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/${INDEX}/_stats/store`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const data = (await response.json()) as { _all?: { total?: { store?: { size_in_bytes?: number } } } };
    const bytes = Number(data._all?.total?.store?.size_in_bytes);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** Disco del nodo de Elasticsearch (`total`/`available`) y lo que ocupa el índice (`used`). */
export async function elasticDisk(): Promise<{ total: number; available: number; used: number } | null> {
  const base = elasticUrl();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/_nodes/stats/fs`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      nodes?: Record<string, { fs?: { total?: { total_in_bytes?: number; available_in_bytes?: number } } }>;
    };
    let total = 0;
    let available = 0;
    for (const node of Object.values(data.nodes ?? {})) {
      total += Number(node.fs?.total?.total_in_bytes ?? 0);
      available += Number(node.fs?.total?.available_in_bytes ?? 0);
    }
    if (!Number.isFinite(total) || total <= 0) return null;
    const used = (await elasticStoreBytes()) ?? 0;
    return { total, available, used };
  } catch {
    return null;
  }
}
