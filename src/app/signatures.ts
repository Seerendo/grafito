import { useEffect } from "react";
import { create } from "zustand";
import {
  SIGNATURES_LOADING,
  failSignatures,
  settleSignatures,
  signatureKey,
  type SignatureLoad,
} from "@/domain/signature-view";
import { signatureState } from "@/server/signature.functions";

/**
 * Signature requests per document, shared by the PDF overlay, the signature bar and the
 * signature dialog so they never disagree. Each load is numbered; an answer older than the
 * latest request for the same document is dropped.
 */

type Store = {
  byKey: Record<string, SignatureLoad>;
  set: (key: string, load: SignatureLoad) => void;
};

const useStore = create<Store>((set) => ({
  byKey: {},
  set: (key, load) => set((state) => ({ byKey: { ...state.byKey, [key]: load } })),
}));

const latest = new Map<string, number>();
let sequence = 0;

/** Ask the server again; the store keeps the last rows until the answer arrives. */
export async function loadSignatures(docId: string, shareId?: string): Promise<void> {
  const key = signatureKey(docId, shareId);
  const ticket = ++sequence;
  latest.set(key, ticket);
  const { byKey, set } = useStore.getState();
  if (!byKey[key]) set(key, SIGNATURES_LOADING);
  let next: SignatureLoad;
  try {
    next = settleSignatures(await signatureState({ data: { docId, shareId } }));
  } catch {
    next = failSignatures(useStore.getState().byKey[key]);
  }
  if (latest.get(key) === ticket) useStore.getState().set(key, next);
}

/** Refresh interval for signatures stamped by other people. */
const POLL_MS = 20_000;

/**
 * Current signature state for a document. With poll, load now and every POLL_MS, and again
 * whenever version changes (after a local action).
 */
export function useSignatures(
  docId: string,
  shareId: string | undefined,
  options: { poll?: boolean; version?: number } = {},
): SignatureLoad {
  const key = signatureKey(docId, shareId);
  const load = useStore((state) => state.byKey[key]) ?? SIGNATURES_LOADING;
  const { poll = false, version = 0 } = options;
  useEffect(() => {
    void loadSignatures(docId, shareId);
    if (!poll) return;
    const timer = window.setInterval(() => void loadSignatures(docId, shareId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [docId, shareId, poll, version]);
  return load;
}
