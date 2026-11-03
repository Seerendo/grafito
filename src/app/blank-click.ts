/**
 * App-wide blank-click guard installed in the root route. Clicks on empty space or text-field
 * labels must blur the current field without moving the text selection to a stray blinking
 * caret. Users click directly into fields to type. Reading text remains selectable, and drag or
 * drawing surfaces retain their behavior.
 */

const TEXT_INPUT = new Set(["text", "email", "password", "url", "number", "search", "tel", ""]);

const CONTROL =
  "input, textarea, select, button, a, [contenteditable], [role=button], [role=menuitem], [role=switch], [tabindex]";

/** Areas where dragging from margins selects content, or that are themselves draggable. */
const KEEP = 'article, [data-reader], canvas, svg, [draggable="true"], [data-ui="graph"]';

function isTextControl(control: HTMLElement | null): boolean {
  return (
    control instanceof HTMLTextAreaElement ||
    (control instanceof HTMLInputElement && TEXT_INPUT.has(control.getAttribute("type") ?? ""))
  );
}

/** Blank space: neither a control nor an element with its own text. */
export function isBlank(target: HTMLElement): boolean {
  if (target.closest(CONTROL) || target.closest("label")) return false;
  return ![...target.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
  );
}

export function releaseFocus(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * Remove an empty selection outside the focused field; navigation can leave a blinking caret
 * near a field the user never clicked.
 */
export function clearStrayCaret(): void {
  const selection = window.getSelection();
  if (!selection || selection.type !== "Caret") return;
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active as HTMLElement | null)?.isContentEditable
  )
    return;
  selection.removeAllRanges();
}

/**
 * Text-field labels, excluding pill search labels whose entire area is the field (data-field).
 * Checkbox and switch labels still activate their controls.
 */
function textLabel(target: HTMLElement): HTMLLabelElement | null {
  const label = target.closest("label");
  if (!label || label.hasAttribute("data-field")) return null;
  const control = label.control as HTMLElement | null;
  if (!control || target === control || control.contains(target)) return null;
  return isTextControl(control) ? label : null;
}

export function installBlankClickGuard(): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target || !(target instanceof HTMLElement)) return;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    // Allow dragging the panel scrollbar.
    const scrolls =
      target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth;
    if (
      scrolls &&
      target.clientWidth > 0 &&
      (event.offsetX > target.clientWidth || event.offsetY > target.clientHeight)
    )
      return;
    if (textLabel(target) || (isBlank(target) && !target.closest(KEEP))) {
      event.preventDefault();
      releaseFocus();
      // Some browsers keep painting a caret parked just after a blurred field, inside its label.
      clearStrayCaret();
    }
  };
  // Clicking the label neither focuses its field nor moves the caret to its end.
  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLElement && textLabel(target)) event.preventDefault();
  };
  // Focusing a button or selector can leave a caret between elements near a field. Such a caret was not placed inside text by the user and should be removed.
  const onFocusChange = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.type !== "Caret" ||
        selection.anchorNode?.nodeType !== Node.ELEMENT_NODE
      )
        return;
      clearStrayCaret();
    }, 0);
  };
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("focusout", onFocusChange, true);
  document.addEventListener("focusin", onFocusChange, true);
  return () => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("focusout", onFocusChange, true);
    document.removeEventListener("focusin", onFocusChange, true);
  };
}
