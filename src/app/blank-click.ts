/**
 * Clics que no son para escribir: un hueco (la barra superior vacía, el
 * espacio entre paneles o entre campos de un formulario, el fondo de un
 * diálogo) o la etiqueta de un campo de texto. El navegador lleva ahí la
 * selección de texto al punto más cercano, que suele ser el final de un campo
 * o de su etiqueta, y deja una barra parpadeando donde nadie escribe.
 *
 * Una guarda para toda la app (`installBlankClickGuard`, montada en la ruta
 * raíz): en esos clics no se mueve la selección y el campo que tuviera el
 * foco lo suelta, como al hacer clic fuera de él. Para escribir se hace clic
 * en el propio campo.
 *
 * No actúa sobre el texto de lectura (la nota, el chat, las listas), que se
 * puede seleccionar arrastrando, ni sobre lo que se arrastra o se dibuja.
 */

const TEXT_INPUT = new Set(["text", "email", "password", "url", "number", "search", "tel", ""]);

const CONTROL = "input, textarea, select, button, a, [contenteditable], [role=button], [role=menuitem], [role=switch], [tabindex]";

/** Zonas donde arrastrar desde un margen sirve para seleccionar, o que se arrastran. */
const KEEP = 'article, [data-reader], canvas, svg, [draggable="true"], [data-ui="graph"]';

function isTextControl(control: HTMLElement | null): boolean {
  return (
    control instanceof HTMLTextAreaElement ||
    (control instanceof HTMLInputElement && TEXT_INPUT.has(control.getAttribute("type") ?? ""))
  );
}

/** Un hueco: ni un control ni un elemento con texto propio. */
export function isBlank(target: HTMLElement): boolean {
  if (target.closest(CONTROL) || target.closest("label")) return false;
  return ![...target.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
}

export function releaseFocus(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * Quita una selección vacía (un cursor de texto suelto) que no está en un
 * campo enfocado: al cambiar de pantalla, el navegador la deja en el primer
 * campo cercano, donde parpadea sin que nadie haya hecho clic.
 */
export function clearStrayCaret(): void {
  const selection = window.getSelection();
  if (!selection || selection.type !== "Caret") return;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement | null)?.isContentEditable) return;
  selection.removeAllRanges();
}

/**
 * La etiqueta de un campo de texto (su nombre o el espacio a su lado), sin
 * contar la de los buscadores con forma de píldora, cuya etiqueta es el
 * propio campo (`data-field`). Las casillas e interruptores siguen
 * activándose desde su etiqueta.
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
    // Sobre la barra de desplazamiento de un panel: que se pueda arrastrar.
    const scrolls = target.scrollHeight > target.clientHeight || target.scrollWidth > target.clientWidth;
    if (scrolls && target.clientWidth > 0 && (event.offsetX > target.clientWidth || event.offsetY > target.clientHeight)) return;
    if (textLabel(target) || (isBlank(target) && !target.closest(KEEP))) {
      event.preventDefault();
      releaseFocus();
      // Al soltar un campo, su cursor queda aparcado justo después de él (en
      // su etiqueta) y algunos navegadores lo siguen dibujando ahí.
      clearStrayCaret();
    }
  };
  // El clic en la etiqueta ya no enfoca su campo ni pone el cursor al final.
  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLElement && textLabel(target)) event.preventDefault();
  };
  // Al cambiar el foco a algo que no es un campo de texto (un botón, un
  // selector…), el navegador deja el cursor aparcado entre elementos, junto a
  // un campo, donde algunos navegadores lo siguen dibujando. Un cursor entre
  // elementos (no dentro de un texto) nunca lo puso la persona: se quita.
  const onFocusChange = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.type !== "Caret" || selection.anchorNode?.nodeType !== Node.ELEMENT_NODE) return;
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
