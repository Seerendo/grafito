import { portfolioZipLink } from "@/server/export.functions";
import { useVault } from "@/app/vault/store";

/**
 * Descarga un portafolio entero, con sus subportafolios, como .zip (`"all"`:
 * toda la bóveda). El servidor arma el zip; aquí solo se pide el enlace
 * firmado y se abre. Ver `server/export.ts`.
 */
export async function downloadPortfolio(portfolioId: string): Promise<void> {
  const fail = (message: string) =>
    useVault.getState().setDialog({ type: "upload-error", title: "No se pudo descargar", message });
  try {
    const result = await portfolioZipLink({ data: { portfolioId } });
    if (!result.ok) {
      fail(result.error);
      return;
    }
    const link = window.document.createElement("a");
    link.href = result.url;
    link.click();
  } catch {
    fail("No se pudo preparar la descarga.");
  }
}
