/**
 * Show focus rings for Tab navigation. Pointer clicks set html data-modality=pointer to
 * suppress browser focus-visible rings until Tab is pressed; see styles.css.
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
