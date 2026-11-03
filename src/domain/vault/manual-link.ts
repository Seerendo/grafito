import { linkKey, type TextAnchor } from "./anchor.ts";
import type { ManualLink } from "./types.ts";

/** Manual-link limit prevents oversized shared trees. */
export const MAX_MANUAL_LINKS = 200;

/**
 * Add a link or replace one with the same target and anchor. Return full when a new link
 * exceeds the limit.
 */
export function withManualLink(
  links: readonly ManualLink[],
  added: ManualLink,
): ManualLink[] | "full" {
  const key = linkKey(added);
  const rest = links.filter((link) => linkKey(link) !== key);
  if (rest.length >= MAX_MANUAL_LINKS) return "full";
  return [...rest, added];
}

/** Remove the link matching the target and optional anchor. */
export function withoutManualLink(
  links: readonly ManualLink[],
  removed: { targetId: string; anchor?: TextAnchor },
): ManualLink[] {
  const key = linkKey(removed);
  return links.filter((link) => linkKey(link) !== key);
}
