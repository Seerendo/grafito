import { useEffect, useState } from "react";
import type { Passage } from "@/domain/search-text";
import { searchDocuments } from "@/server/admin.functions";

export type ContentHit = {
  id: string;
  title: string;
  kind: string;
  snippet: string;
  passages: Passage[];
  more: number;
};

/**
 * Debounced content-index search while typing. Queries shorter than two characters do not
 * contact the server.
 */
export function useContentSearch(query: string): ContentHit[] {
  const [hits, setHits] = useState<ContentHit[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void searchDocuments({ data: { q } })
        .then((result) => {
          if (cancelled) return;
          setHits(
            result.hits.map((hit) => ({
              ...hit,
              passages: hit.passages ?? [],
              more: hit.more ?? 0,
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);
  return hits;
}
