/**
 * Anillo de foco solo para quien navega con Tab.
 *
 * Tras un clic, el elemento pulsado (una fila del directorio, un botón) queda
 * con el foco sin anillo; pero al pulsar después cualquier tecla, el navegador
 * da por hecho que se usa el teclado y se lo dibuja (`:focus-visible`). Con el
 * ratón, `<html data-modality="pointer">` lo apaga (ver styles.css) hasta que
 * se pulsa Tab, que es cuando el anillo sirve para saber dónde se está.
 */
export function installInputModality(): () => void {
  const root = document.documentElement;
  const onPointer = () => {
    root.dataset.modality = "pointer";
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Tab") delete root.dataset.modality;
  };
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
    delete root.dataset.modality;
  };
}
