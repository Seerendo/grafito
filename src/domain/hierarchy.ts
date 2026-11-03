export type HierarchyItem = { id: string; parentId: string | null };

/** Index and traverse once, including the root and tolerating cyclic input. */
export function subtreeIds(items: readonly HierarchyItem[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item.id);
    children.set(item.parentId, siblings);
  }
  const ids = new Set([rootId]);
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return ids;
}
