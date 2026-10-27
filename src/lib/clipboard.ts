/**
 * Copia texto al portapapeles. En páginas servidas por http fuera de localhost
 * el navegador no ofrece `navigator.clipboard` (solo en contextos seguros):
 * entonces se copia con una caja de texto temporal y `execCommand("copy")`.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* sin permiso: se prueba la otra vía */
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
