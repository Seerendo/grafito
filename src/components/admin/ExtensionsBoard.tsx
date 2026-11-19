import { useEffect, useState, type FormEvent } from "react";
import { t } from "@/app/i18n";
import {
  EXTENSION_GROUPS,
  normalizeExtensions,
  type ExtensionRules,
} from "@/domain/file-extensions";
import { extensionRules, saveExtensionRules } from "@/server/file-rules.functions";

const KNOWN = new Set(EXTENSION_GROUPS.flatMap((group) => group.extensions));

/** Extensions blocked from upload, and extensions uploaded but kept out of the index. */
export function ExtensionsBoard() {
  const [rules, setRules] = useState<ExtensionRules | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void extensionRules()
      .then((next) => {
        if (alive) setRules(next);
      })
      .catch(() => {
        if (alive) setError(t("No se pudo leer la configuración."));
      });
    return () => {
      alive = false;
    };
  }, []);
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!rules) return <p className="text-sm text-muted">{t("Cargando…")}</p>;
  return <ExtensionsForm initial={rules} onSaved={setRules} />;
}

function ExtensionsForm({
  initial,
  onSaved,
}: {
  initial: ExtensionRules;
  onSaved: (next: ExtensionRules) => void;
}) {
  const [upload, setUpload] = useState(() => new Set(initial.upload));
  const [index, setIndex] = useState(() => new Set(initial.index));
  const [uploadOther, setUploadOther] = useState(
    initial.upload.filter((ext) => !KNOWN.has(ext)).join(", "),
  );
  const [indexOther, setIndexOther] = useState(
    initial.index.filter((ext) => !KNOWN.has(ext)).join(", "),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const collect = (picked: Set<string>, other: string) =>
    normalizeExtensions([
      ...[...picked].filter((ext) => KNOWN.has(ext)),
      ...normalizeExtensions(other),
    ]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveExtensionRules({
        data: { upload: collect(upload, uploadOther), index: collect(index, indexOther) },
      });
      if (!result.ok) setMessage({ ok: false, text: result.error });
      else {
        onSaved(result.rules);
        setUpload(new Set(result.rules.upload));
        setIndex(new Set(result.rules.index));
        setUploadOther(result.rules.upload.filter((ext) => !KNOWN.has(ext)).join(", "));
        setIndexOther(result.rules.index.filter((ext) => !KNOWN.has(ext)).join(", "));
        setMessage({ ok: true, text: "Guardado." });
      }
    } catch {
      setMessage({ ok: false, text: "No se pudo guardar." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-5">
      <ExtensionPicker
        title={t("Bloquear la subida")}
        picked={upload}
        onChange={setUpload}
        other={uploadOther}
        onOther={setUploadOther}
        name="upload"
      />
      <ExtensionPicker
        title={t("Subir sin indexar")}
        picked={index}
        onChange={setIndex}
        other={indexOther}
        onOther={setIndexOther}
        name="index"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy ? t("Guardando…") : t("Guardar")}
        </button>
        {message ? (
          <p className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
            {t(message.text)}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function ExtensionPicker({
  title,
  picked,
  onChange,
  other,
  onOther,
  name,
}: {
  title: string;
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
  other: string;
  onOther: (value: string) => void;
  name: string;
}) {
  const toggle = (ext: string) => {
    const next = new Set(picked);
    if (next.has(ext)) next.delete(ext);
    else next.add(ext);
    onChange(next);
  };
  return (
    <fieldset
      data-extensions={name}
      className="space-y-4 rounded-lg border border-line bg-surface p-4"
    >
      <legend className="px-1 font-serif text-xl">{title}</legend>
      {EXTENSION_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="text-xs text-muted">{t(group.label)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {group.extensions.map((ext) => (
              <label
                key={ext}
                className={`inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm ${
                  picked.has(ext) ? "border-accent text-fg" : "border-line text-muted"
                }`}
              >
                <input
                  type="checkbox"
                  checked={picked.has(ext)}
                  onChange={() => toggle(ext)}
                  className="accent-accent"
                />
                .{ext}
              </label>
            ))}
          </div>
        </div>
      ))}
      <label className="block text-xs text-muted">
        {t("Otras extensiones")}
        <input
          value={other}
          onChange={(event) => onOther(event.target.value)}
          placeholder="msp, torrent, xpi"
          autoComplete="off"
          className="mt-1 h-11 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg"
        />
      </label>
    </fieldset>
  );
}
