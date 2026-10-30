import { Building2, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { uploadVaultFile } from "@/app/files";
import { intl, t } from "@/app/i18n";
import { useSharedView } from "@/app/shared-view";
import { useVault } from "@/app/vault/store";
import { Mark } from "@/components/brand/Mark";
import { AccessTrail, chosenExpiry, ExpiryField, utcDay } from "@/components/vault/AccessWindow";
import { Modal } from "@/components/ui/Modal";
import { SearchField } from "@/components/ui/SearchField";
import type { CellValue, FormFieldView, TableField, TableForm, TableRow } from "@/domain/vault/table";
import type { ExpiryChoice } from "@/domain/access-window";
import { orgPath } from "@/domain/orgs";
import { isPublicField } from "@/domain/vault/table";
import { invitedFormFile, invitedFormOpen, invitedFormSubmit, publicFormFile, publicFormOpen, publicFormSubmit, tableAddRows, tableAttach, tableFormActivity, tableFormPeople, tableRevokeForm, tableRowChoices, tableSaveForm } from "@/server/table.functions";

type Where = { docId: string; shareId?: string };

/** El enlace público del formulario. */
function formHref(token: string): string {
  return `${window.location.origin}/f/${token}`;
}

function when(ms: number): string {
  return new Intl.DateTimeFormat(intl(), { dateStyle: "long", timeStyle: "short" }).format(ms);
}

/** Configurar el formulario y rellenarlo desde la tabla. */
export function FormDialog({
  title,
  fields,
  form,
  where,
  editable,
  onClose,
  onSaved,
  onAdded,
}: {
  title: string;
  fields: TableField[];
  form: TableForm | null;
  where: Where;
  editable: boolean;
  onClose: () => void;
  onSaved: (form: TableForm) => void;
  onAdded: (rows: TableRow[]) => void;
}) {
  const [mode, setMode] = useState<"fill" | "setup">(form ? "fill" : "setup");
  const [name, setName] = useState(form?.title ?? title.replace(/\.tabla$/i, ""));
  const [description, setDescription] = useState(form?.description ?? "");
  const [picked, setPicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((form?.fields ?? fields.map((field) => ({ id: field.id, required: false }))).map((field) => [field.id, field.required])),
  );
  const [publish, setPublish] = useState(Boolean(form?.enabled));
  const [current, setCurrent] = useState(form);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [busy, setBusy] = useState(false);
  const [linkMode, setLinkMode] = useState<ExpiryChoice>("never");
  const [linkDate, setLinkDate] = useState("");
  const [linkTouched, setLinkTouched] = useState(false);
  const [trail, setTrail] = useState<Awaited<ReturnType<typeof tableFormActivity>> | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string; loginName: string }[] | null>(null);
  const [orgs, setOrgs] = useState<{ id: string; name: string; parentId: string | null }[]>([]);
  const [inviteUsers, setInviteUsers] = useState<Set<string>>(
    () => new Set((form?.invites ?? []).filter((item) => item.kind === "user").map((item) => item.subjectId)),
  );
  const [inviteOrgs, setInviteOrgs] = useState<Set<string>>(
    () => new Set((form?.invites ?? []).filter((item) => item.kind === "org").map((item) => item.subjectId)),
  );
  const [who, setWho] = useState("");
  const selected = fields.filter((field) => field.id in picked);
  const link = current?.publicToken && current.enabled ? formHref(current.publicToken) : "";
  const linkExisting = current?.enabled && current.publicToken ? (current.expiresAt ?? null) : null;

  useEffect(() => {
    if (linkTouched) return;
    setLinkMode(linkExisting ? "date" : "never");
    setLinkDate(linkExisting ? utcDay(linkExisting) : "");
  }, [linkExisting, linkTouched]);

  const loadTrail = () => {
    if (!editable) return;
    void tableFormActivity({ data: where })
      .then(setTrail)
      .catch(() => setTrail({ periods: [], events: [] }));
  };

  useEffect(() => {
    loadTrail();
  }, [where.docId, where.shareId, editable]);

  useEffect(() => {
    if (!editable) return;
    void tableFormPeople({ data: where })
      .then((result) => {
        setPeople(result.users);
        setOrgs(result.orgs);
      })
      .catch(() => {
        setPeople([]);
        setOrgs([]);
      });
  }, [where.docId, where.shareId, editable]);

  const filteredPeople = useMemo(() => {
    const needle = who.trim().toLowerCase();
    return (people ?? []).filter((person) => !needle || person.name.toLowerCase().includes(needle) || person.loginName.toLowerCase().includes(needle));
  }, [people, who]);
  const filteredOrgs = useMemo(() => {
    const needle = who.trim().toLowerCase();
    return orgs
      .map((org) => ({ ...org, path: orgPath(orgs, org.id) }))
      .filter((org) => !needle || org.path.toLowerCase().includes(needle));
  }, [orgs, who]);

  const save = async () => {
    if (publish && linkTouched && linkMode === "date" && !linkDate) {
      setMessage(t("Elige una fecha."));
      return;
    }
    setBusy(true);
    const expiresAt = publish ? chosenExpiry(linkTouched, false, linkMode, linkDate, linkExisting) : undefined;
    const result = await tableSaveForm({
      data: {
        ...where,
        title: name,
        description,
        publish,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        fields: selected.map((field) => ({ id: field.id, required: picked[field.id] ?? false })),
        userIds: [...inviteUsers],
        orgIds: [...inviteOrgs],
      },
    }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setMessage(t(result?.error ?? "No se pudo guardar el formulario."));
      return;
    }
    setLinkTouched(false);
    setCurrent(result.form);
    onSaved(result.form);
    setInviteUsers(new Set(result.form.invites.filter((item) => item.kind === "user").map((item) => item.subjectId)));
    setInviteOrgs(new Set(result.form.invites.filter((item) => item.kind === "org").map((item) => item.subjectId)));
    const notes: string[] = [];
    const notice = "notice" in result ? result.notice : undefined;
    if (notice?.mailOff && (inviteUsers.size > 0 || inviteOrgs.size > 0)) notes.push(t("El correo no está configurado: se guardó, pero no se envió el aviso."));
    for (const name of notice?.missing ?? []) notes.push(t("{0} no tiene correo: el aviso no se envió.", { 0: name }));
    if ((notice?.failed ?? 0) > 0) notes.push(t("No se pudo enviar el correo."));
    if ((notice?.mailed ?? 0) > 0 && notes.length === 0) notes.push(t("Se envió el aviso por correo."));
    setMessage(notes.join(" "));
    loadTrail();
  };

  const revoke = async () => {
    setBusy(true);
    const result = await tableRevokeForm({ data: where }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setMessage(t(result?.error ?? "No hay un enlace que revocar."));
      return;
    }
    setPublish(false);
    setLinkTouched(false);
    setCurrent(result.form);
    onSaved(result.form);
    setMessage(t("El enlace ya no sirve."));
    loadTrail();
  };

  const submit = async () => {
    setBusy(true);
    const cells: Record<string, unknown> = {};
    for (const field of selected) {
      const value = values[field.id];
      if (value !== undefined && value !== null && value !== "") cells[field.id] = value;
    }
    const result = await tableAddRows({ data: { ...where, rows: [{ cells }] } }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setMessage(t(result?.error ?? "No se pudo enviar."));
      return;
    }
    onAdded(result.rows);
    setValues({});
    setMessage(t("Enviado. Gracias."));
  };

  const attach = async (fieldId: string, file: File) => {
    const portfolioId = where.shareId
      ? (useSharedView.getState().tree?.documents.find((document) => document.id === where.docId)?.portfolioId ?? null)
      : (useVault.getState().documents.find((document) => document.id === where.docId)?.portfolioId ?? null);
    const stored = await uploadVaultFile(file, { portfolioId, ...(where.shareId ? { shareId: where.shareId } : {}) });
    const created = await tableAttach({
      data: { ...where, name: file.name, mime: file.type || "application/octet-stream", key: stored.key, size: stored.size },
    });
    if (!created.ok) {
      setMessage(t(created.error));
      return;
    }
    const previous = values[fieldId];
    const refs = Array.isArray(previous) ? previous.filter((ref) => ref && typeof ref === "object" && "kind" in ref) : [];
    setValues((currentValues) => ({ ...currentValues, [fieldId]: [...refs, { id: created.id, kind: "document" as const }] }));
  };

  const toggleId = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <Modal title={t("Formulario")} onClose={onClose}>
      {link ? (
        <div className="mb-3 rounded-md border border-accent/40 bg-accent/5 p-3">
          <p className="text-xs font-medium">{t("Enlace público")}</p>
          <p className="mt-1 text-xs text-muted">{t("Cualquiera con este enlace puede añadir una fila. No ve el resto de la tabla.")}</p>
          <p className="mt-1 text-xs text-muted">{current?.expiresAt ? t("Caduca el {0}.", { 0: when(current.expiresAt) }) : t("No caduca")}</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={link}
              aria-label={t("Enlace público")}
              onFocus={(event) => event.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-line bg-inset px-2 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => setCopied(true));
              }}
              className="h-9 shrink-0 rounded-md border border-line px-3 text-xs"
            >
              {copied ? t("Enlace copiado") : t("Copiar")}
            </button>
            {editable ? (
              <button type="button" disabled={busy} onClick={() => void revoke()} className="h-9 shrink-0 text-xs text-danger hover:underline disabled:opacity-60">
                {t("Revocar enlace")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="mb-3 flex gap-1">
        <button type="button" onClick={() => setMode("fill")} className={`h-8 rounded-md px-3 text-xs ${mode === "fill" ? "bg-accent text-accent-fg" : "text-muted hover:bg-elevated"}`}>
          {t("Rellenar")}
        </button>
        {editable ? (
          <button type="button" onClick={() => setMode("setup")} className={`h-8 rounded-md px-3 text-xs ${mode === "setup" ? "bg-accent text-accent-fg" : "text-muted hover:bg-elevated"}`}>
            {t("Configurar")}
          </button>
        ) : null}
      </div>
      {mode === "setup" && editable ? (
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-xs text-faint">{t("Nombre")}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-line bg-inset px-2 outline-none" />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-faint">{t("Descripción")}</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="mt-1 w-full rounded-md border border-line bg-inset px-2 py-1.5 outline-none" />
          </label>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {fields.map((field) => (
              <li key={field.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={field.id in picked}
                  onChange={() =>
                    setPicked((currentPicked) => {
                      const next = { ...currentPicked };
                      if (field.id in next) delete next[field.id];
                      else next[field.id] = false;
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{field.name}</span>
                {field.id in picked ? (
                  <label className="flex items-center gap-1 text-xs text-faint">
                    <input type="checkbox" checked={picked[field.id]} onChange={() => setPicked((currentPicked) => ({ ...currentPicked, [field.id]: !currentPicked[field.id] }))} />
                    {t("Obligatoria")}
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} />
            {t("Enlace público")}
          </label>
          {publish ? (
            <ExpiryField
              mode={linkMode}
              date={linkDate}
              onChange={(mode, date) => {
                setLinkTouched(true);
                setLinkMode(mode);
                setLinkDate(date);
              }}
            />
          ) : null}
          <p className="text-xs text-muted">{t("El enlace público no pide cuenta: quien lo tenga añade una fila y no ve la tabla.")}</p>
          {publish && !link ? <p className="text-xs text-faint">{t("Al guardar se crea el enlace, con la duración de arriba.")}</p> : null}
          {!link && current?.revokedAt ? <p className="text-xs text-muted">{t("El enlace ya no sirve.")}</p> : null}
          <p className="text-xs text-faint">{t("En el enlace público no salen los vínculos ni las relaciones. Los adjuntos sí.")}</p>
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-sm font-medium">{t("Enviar a usuarios u organizaciones")}</p>
            <p className="text-xs text-muted">{t("Quien marques recibe el formulario por correo. Lo abre con su cuenta y solo ve las preguntas, no la tabla.")}</p>
            <SearchField value={who} onChange={setWho} placeholder={t("Buscar usuario u organización")} />
            <ul className="max-h-48 overflow-y-auto rounded-md border border-line">
              {filteredOrgs.length > 0 ? <li className="border-b border-line bg-surface px-3 py-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{t("Organizaciones")}</li> : null}
              {filteredOrgs.map((org) => (
                <li key={org.id}>
                  <label className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm hover:bg-elevated">
                    <input type="checkbox" checked={inviteOrgs.has(org.id)} onChange={() => toggleId(inviteOrgs, org.id, setInviteOrgs)} />
                    <Building2 className="size-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">{org.path}</span>
                  </label>
                </li>
              ))}
              <li className="border-b border-line bg-surface px-3 py-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{t("Usuarios")}</li>
              {people === null ? <li className="px-3 py-3 text-sm text-muted">{t("Cargando…")}</li> : null}
              {people !== null && filteredPeople.length === 0 ? <li className="px-3 py-3 text-sm text-muted">{t("Ningún usuario coincide.")}</li> : null}
              {filteredPeople.map((person) => (
                <li key={person.id}>
                  <label className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm hover:bg-elevated">
                    <input type="checkbox" checked={inviteUsers.has(person.id)} onChange={() => toggleId(inviteUsers, person.id, setInviteUsers)} />
                    <User className="size-3.5 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">{person.name}</span>
                    {person.loginName ? <span className="text-xs text-faint">{person.loginName}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          </div>
          {trail ? <AccessTrail periods={trail.periods} events={trail.events} /> : null}
          <button type="button" disabled={busy || selected.length === 0} onClick={() => void save()} className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50">
            {busy ? t("Guardando…") : publish && !link ? (current?.revokedAt ? t("Nuevo enlace") : t("Crear enlace")) : t("Guardar")}
          </button>
        </div>
      ) : (
        <FillForm
          description={current?.description || description}
          fields={selected.map((field) => ({
            id: field.id,
            name: field.name,
            type: field.type,
            choices: field.choices,
            required: picked[field.id] ?? false,
            relatedTableId: field.relatedTableId,
          }))}
          values={values}
          where={where}
          busy={busy}
          onChange={(id, value) => setValues((currentValues) => ({ ...currentValues, [id]: value }))}
          onFile={(id, file) => void attach(id, file)}
          onSubmit={() => void submit()}
        />
      )}
      {message ? <p className="mt-3 text-sm text-muted">{message}</p> : null}
    </Modal>
  );
}

function FillForm({
  description,
  fields,
  values,
  where,
  busy,
  token,
  onChange,
  onFile,
  onSubmit,
}: {
  description: string;
  fields: FormFieldView[];
  values: Record<string, CellValue>;
  where?: Where;
  busy: boolean;
  token?: string;
  onChange: (id: string, value: CellValue) => void;
  onFile: (id: string, file: File) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {description ? <p className="text-sm text-muted">{description}</p> : null}
      {fields.map((field) => (
        <FieldInput key={field.id} field={field} value={values[field.id] ?? null} where={where} token={token} onChange={(value) => onChange(field.id, value)} onFile={(file) => onFile(field.id, file)} />
      ))}
      <button type="submit" disabled={busy || fields.length === 0} className="h-11 w-full rounded-md bg-accent text-sm font-medium text-accent-fg disabled:opacity-50">
        {busy ? t("Enviando…") : t("Enviar")}
      </button>
    </form>
  );
}

function FieldInput({
  field,
  value,
  where,
  token,
  onChange,
  onFile,
}: {
  field: FormFieldView;
  value: CellValue;
  where?: Where;
  token?: string;
  onChange: (value: CellValue) => void;
  onFile: (file: File) => void;
}) {
  const className = "mt-1 h-10 w-full rounded-md border border-line bg-inset px-2 outline-none";
  if (field.type === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked ? true : null)} />
        {field.name}
        {field.required ? <span className="text-faint">*</span> : null}
      </label>
    );
  }
  if (field.type === "select") {
    return (
      <label className="block text-sm">
        <span className="text-xs text-faint">
          {field.name}
          {field.required ? " *" : ""}
        </span>
        <select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)} className={className}>
          <option value="">—</option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.type === "relation" && where && field.relatedTableId) {
    return <RelationInput field={field} value={value} where={where} tableId={field.relatedTableId} onChange={onChange} />;
  }
  if (field.type === "file") {
    const count = Array.isArray(value) ? value.length : 0;
    return (
      <label className="block text-sm">
        <span className="text-xs text-faint">
          {field.name}
          {field.required ? " *" : ""}
          {count ? ` (${count})` : ""}
        </span>
        <input
          type="file"
          className="mt-1 block w-full text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            if (token) {
              void fileToBase64(file).then((base64) =>
                publicFormFile({ data: { token, name: file.name, mime: file.type || "application/octet-stream", base64 } }).then((result) => {
                  if (result.ok) {
                    const previous = Array.isArray(value) ? value.filter((ref) => ref && typeof ref === "object" && "kind" in ref) : [];
                    onChange([...previous, { id: result.id, kind: "document" }]);
                  }
                }),
              );
              return;
            }
            onFile(file);
          }}
        />
      </label>
    );
  }
  if (field.type === "link" || field.type === "relation" || field.type === "formula") {
    return <p className="text-xs text-faint">{t("«{0}» se completa en la tabla.", { 0: field.name })}</p>;
  }
  return (
    <label className="block text-sm">
      <span className="text-xs text-faint">
        {field.name}
        {field.required ? " *" : ""}
      </span>
      {field.type === "text" ? (
        <textarea value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)} rows={3} className="mt-1 w-full rounded-md border border-line bg-inset px-2 py-1.5 outline-none" />
      ) : (
        <input
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "time" ? "time" : "text"}
          step="any"
          value={value === null || Array.isArray(value) ? "" : String(value)}
          onChange={(event) => onChange(event.target.value || null)}
          className={className}
        />
      )}
    </label>
  );
}

function RelationInput({
  field,
  value,
  where,
  tableId,
  onChange,
}: {
  field: FormFieldView;
  value: CellValue;
  where: Where;
  tableId: string;
  onChange: (value: CellValue) => void;
}) {
  const [options, setOptions] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    void tableRowChoices({ data: { ...where, tableId } })
      .then((result) => {
        if (result.ok) setOptions(result.rows);
      })
      .catch(() => undefined);
  }, [where.docId, where.shareId, tableId]);
  const current = Array.isArray(value) ? value.find((ref) => ref && typeof ref === "object" && "rowId" in ref) : null;
  const selected = current && "rowId" in current ? current.rowId : "";
  return (
    <label className="block text-sm">
      <span className="text-xs text-faint">
        {field.name}
        {field.required ? " *" : ""}
      </span>
      <select
        value={selected}
        onChange={(event) => onChange(event.target.value ? [{ tableId, rowId: event.target.value }] : null)}
        className="mt-1 h-10 w-full rounded-md border border-line bg-inset px-2 outline-none"
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Página pública: solo añade una fila. */
export function PublicFormScreen({ token }: { token: string }) {
  const [view, setView] = useState<Awaited<ReturnType<typeof publicFormOpen>> | null>(null);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void publicFormOpen({ data: { token } })
      .then(setView)
      .catch(() => setView({ ok: false, error: "No se pudo abrir el formulario." }));
  }, [token]);
  const send = async () => {
    if (!view?.ok) return;
    setBusy(true);
    const cells: Record<string, unknown> = {};
    for (const field of view.fields) {
      const value = values[field.id];
      if (value !== undefined && value !== null && value !== "") cells[field.id] = value;
    }
    const result = await publicFormSubmit({ data: { token, cells } }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError(t(result?.error ?? "No se pudo enviar."));
      return;
    }
    setDone(true);
  };
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-fg">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <Mark />
          <span className="text-xs tracking-widest text-faint uppercase">Grafito</span>
        </div>
        {!view ? <p className="text-sm text-muted">{t("Cargando…")}</p> : null}
        {view && !view.ok ? <p className="text-sm text-danger">{t(view.error)}</p> : null}
        {view?.ok && done ? <p className="font-serif text-2xl">{t("Enviado. Gracias.")}</p> : null}
        {view?.ok && !done ? (
          <>
            <h1 className="font-serif text-3xl">{view.title}</h1>
            <div className="mt-4">
              <FillForm
                description={view.description}
                fields={view.fields.filter((field) => isPublicField(field.type) || field.type === "file")}
                values={values}
                token={token}
                busy={busy}
                onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
                onFile={() => undefined}
                onSubmit={() => void send()}
              />
            </div>
          </>
        ) : null}
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/** Formulario enviado a una persona o a una organización: pide sesión y no muestra la tabla. */
export function InvitedFormScreen({ token }: { token: string }) {
  const [view, setView] = useState<Awaited<ReturnType<typeof invitedFormOpen>> | null>(null);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void invitedFormOpen({ data: { token } })
      .then(setView)
      .catch(() => setView({ ok: false, error: "No se pudo abrir el formulario." }));
  }, [token]);
  const send = async () => {
    if (!view?.ok) return;
    setBusy(true);
    const cells: Record<string, unknown> = {};
    for (const field of view.fields) {
      const value = values[field.id];
      if (value !== undefined && value !== null && value !== "") cells[field.id] = value;
    }
    const result = await invitedFormSubmit({ data: { token, cells } }).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      setError(t(result?.error ?? "No se pudo enviar."));
      return;
    }
    setDone(true);
  };
  const upload = async (id: string, file: File) => {
    const base64 = await fileToBase64(file);
    const result = await invitedFormFile({
      data: { token, name: file.name, mime: file.type || "application/octet-stream", base64 },
    }).catch(() => null);
    if (!result?.ok) {
      setError(t(result?.error ?? "No se pudo subir."));
      return;
    }
    setValues((current) => {
      const previous = current[id];
      const refs = Array.isArray(previous) ? previous.filter((ref) => ref && typeof ref === "object" && "kind" in ref) : [];
      return { ...current, [id]: [...refs, { id: result.id, kind: "document" as const }] };
    });
  };
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10 text-fg">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <Mark />
          <span className="text-xs tracking-widest text-faint uppercase">Grafito</span>
        </div>
        {!view ? <p className="text-sm text-muted">{t("Cargando…")}</p> : null}
        {view && !view.ok ? <p className="text-sm text-danger">{t(view.error)}</p> : null}
        {view?.ok && done ? <p className="font-serif text-2xl">{t("Enviado. Gracias.")}</p> : null}
        {view?.ok && !done ? (
          <>
            <h1 className="font-serif text-3xl">{view.title}</h1>
            <div className="mt-4">
              <FillForm
                description={view.description}
                fields={view.fields.filter((field) => isPublicField(field.type) || field.type === "file")}
                values={values}
                busy={busy}
                onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
                onFile={(id, file) => void upload(id, file)}
                onSubmit={() => void send()}
              />
            </div>
          </>
        ) : null}
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
