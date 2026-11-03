/**
 * Custom editor undo/redo stores full text and selection because React-controlled programmatic
 * edits invalidate native textarea history. Group consecutive typing; give each programmatic
 * edit its own step. Relative imports allow Node tests.
 */

export type TextState = { value: string; start: number; end: number };

export type UndoHistory = {
  past: TextState[];
  future: TextState[];
  /** Last typing timestamp used for grouping. */
  typedAt: number;
};

/** Maximum inter-keystroke interval within one undo step. */
export const GROUP_MS = 1000;
const MAX_STEPS = 200;

export function emptyHistory(): UndoHistory {
  return { past: [], future: [], typedAt: 0 };
}

/**
 * Record before-state before editing. Consecutive recent typing shares one step; changing lines
 * starts another.
 */
export function record(
  history: UndoHistory,
  before: TextState,
  after: string,
  typing: boolean,
  now = Date.now(),
): UndoHistory {
  if (before.value === after) return history;
  const newLine =
    after.length > before.value.length &&
    after.slice(before.start, before.start + (after.length - before.value.length)).includes("\n");
  const grouped = typing && !newLine && history.typedAt > 0 && now - history.typedAt < GROUP_MS;
  const past = grouped ? history.past : [...history.past, before].slice(-MAX_STEPS);
  return { past, future: [], typedAt: typing ? now : 0 };
}

/** Undo returns the previous state or null and moves current into redo history. */
export function undo(
  history: UndoHistory,
  current: TextState,
): { history: UndoHistory; state: TextState } | null {
  const state = history.past.at(-1);
  if (!state) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [...history.future, current], typedAt: 0 },
    state,
  };
}

export function redo(
  history: UndoHistory,
  current: TextState,
): { history: UndoHistory; state: TextState } | null {
  const state = history.future.at(-1);
  if (!state) return null;
  return {
    history: { past: [...history.past, current], future: history.future.slice(0, -1), typedAt: 0 },
    state,
  };
}
