import { useState } from "react";
import { t } from "@/app/i18n";
import { Modal } from "@/components/ui/Modal";
import { mailUpdateAccount } from "@/server/mailbox.functions";
import { readSaveTo, useSaveFolders, writeSaveTo } from "@/app/mail/save-to";

/**
 * Correo electrónico → Opciones → Preferencias: the signature of each account (written into new
 * messages and replies) and where files kept from a message go by default. Connecting and
 * configuring accounts stays in Cuenta → Cuentas de correo.
 */

type Account = { id: string; email: string; name: string; signature: string };

export function MailPreferences({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [signatures, setSignatures] = useState<Record<string, string>>(() =>
    Object.fromEntries(accounts.map((item) => [item.id, item.signature])),
  );
  const [saveTo, setSaveTo] = useState(readSaveTo);
  const folders = useSaveFolders();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = "h-10 w-full rounded-md border border-line bg-inset px-3 text-sm";

  const save = async () => {
    setBusy(true);
    setError("");
    for (const account of accounts) {
      if ((signatures[account.id] ?? "") === account.signature) continue;
      const answer = await mailUpdateAccount({
        data: { id: account.id, signature: signatures[account.id] ?? "" },
      }).catch(() => null);
      if (!answer?.ok) {
        setBusy(false);
        setError(answer?.error ?? "No se pudo guardar.");
        return;
      }
    }
    writeSaveTo(saveTo);
    setBusy(false);
    onSaved();
    onClose();
  };

  return (
    <Modal title={t("Preferencias del correo")} onClose={onClose} keepOpen>
      <form
        data-ui="mail-preferences"
        className="flex flex-col gap-4 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">{t("Firma")}</legend>
          {accounts.length > 1 ? (
            <select
              aria-label={t("Cuenta")}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className={input}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name === account.email
                    ? account.email
                    : `${account.name} <${account.email}>`}
                </option>
              ))}
            </select>
          ) : null}
          <textarea
            aria-label={t("Firma")}
            rows={5}
            value={signatures[accountId] ?? ""}
            onChange={(event) => setSignatures({ ...signatures, [accountId]: event.target.value })}
            className="w-full rounded-md border border-line bg-inset p-3"
          />
        </fieldset>
        <label className="flex flex-col gap-1">
          <span className="font-semibold">{t("Guardar adjuntos en")}</span>
          <select
            aria-label={t("Guardar adjuntos en")}
            value={saveTo}
            onChange={(event) => setSaveTo(event.target.value)}
            className={input}
          >
            <option value="">{t("Carpeta Personal")}</option>
            {folders.map((item) => (
              <option key={item.id} value={item.id}>
                {item.path}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <p role="alert" className="text-danger">
            {t(error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-line px-3 hover:bg-elevated"
          >
            {t("Cancelar")}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="h-10 rounded-md bg-accent px-4 font-medium text-accent-fg disabled:opacity-50"
          >
            {busy ? t("Guardando…") : t("Guardar")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
