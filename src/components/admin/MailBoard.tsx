import { useEffect, useState, type FormEvent } from "react";
import { Select } from "@/components/ui/Select";
import { TextField } from "@/components/ui/TextField";
import { useAccountProfile } from "@/app/account-profile";
import { mailState, saveMailSettings, sendTestMail } from "@/server/mail.functions";
import { t } from "@/app/i18n";

/**
 * Administración → Correo electrónico: el servidor SMTP con el que Grafito
 * manda los accesos de los usuarios nuevos y los avisos de cambios. Ver
 * docs/MAIL.md.
 */

type State = Extract<Awaited<ReturnType<typeof mailState>>, { ok: true }>;
type Security = State["settings"]["security"];

const PORTS: Record<Security, number> = { none: 25, starttls: 587, tls: 465 };

export function MailBoard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");

  const load = () =>
    mailState()
      .then((next) => {
        if (!next.ok) setError(t("Sin permiso para configurar el correo."));
        else setState(next);
      })
      .catch(() => setError(t("No se pudo leer la configuración.")));

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="text-sm text-danger">{t(error)}</p>;
  if (!state) return <p className="text-sm text-muted">{t("Cargando…")}</p>;
  return <MailForm state={state} onSaved={() => void load()} />;
}

function MailForm({ state, onSaved }: { state: State; onSaved: () => void }) {
  const profile = useAccountProfile();
  const initial = state.settings;
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [security, setSecurity] = useState<Security>(initial.security);
  const [user, setUser] = useState(initial.user);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [from, setFrom] = useState(initial.from);
  const [fromName, setFromName] = useState(initial.fromName);
  const [publicUrl, setPublicUrl] = useState(initial.publicUrl);
  const [hours, setHours] = useState(String(initial.accessHours));
  const [testTo, setTestTo] = useState(profile.contactEmail);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  const values = () => ({
    host,
    port: Number(port) || PORTS[security],
    security,
    user,
    password: password || undefined,
    clearPassword: clearPassword || undefined,
    from,
    fromName,
    publicUrl,
    accessHours: Math.min(720, Math.max(1, Math.round(Number(hours) || 24))),
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setMessage(null);
    try {
      const result = await saveMailSettings({ data: values() });
      if (!result.ok) setMessage({ ok: false, text: result.error });
      else {
        setPassword("");
        setClearPassword(false);
        setMessage({ ok: true, text: "Guardado." });
        onSaved();
      }
    } catch {
      setMessage({ ok: false, text: "No se pudo guardar." });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const result = await sendTestMail({ data: { ...values(), to: testTo } });
      setMessage(result.ok ? { ok: true, text: "Correo de prueba enviado." } : { ok: false, text: result.error });
    } catch {
      setMessage({ ok: false, text: "No se pudo enviar el correo." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="space-y-5 rounded-lg border border-line bg-surface p-4"
    >
      {!state.encryption ? (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {t("Falta")}{" "}<code>{t("GRAFITO_ENCRYPTION_KEY")}</code>{" "}{t("(32 caracteres o más) en el servidor: nadie podrá guardar claves hasta que la definas.")}
        </p>
      ) : null}
      <p className={`text-sm ${state.ready ? "text-accent" : "text-muted"}`}>
        {state.ready ? t("El correo está activo.") : t("El correo está apagado.")}
      </p>

      <Section title={t("Servidor SMTP")}>
        <TextField label={t("Servidor")} value={host} onChange={setHost} autoComplete="off" optional />
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="text-muted">{t("Seguridad")}</span>
            <Select
              value={security}
              onChange={(value) => {
                const next = value as Security;
                // Si el puerto era el típico de la seguridad anterior, se cambia con ella.
                if (Number(port) === PORTS[security]) setPort(String(PORTS[next]));
                setSecurity(next);
              }}
              className="mt-1"
            >
              <option value="starttls">{t("STARTTLS")}</option>
              <option value="tls">{t("SSL/TLS")}</option>
              <option value="none">{t("Ninguna")}</option>
            </Select>
          </label>
          <TextField label={t("Puerto")} value={port} onChange={setPort} autoComplete="off" type="number" />
        </div>
        <TextField label={t("Usuario")} value={user} onChange={setUser} autoComplete="off" optional />
        <div>
          <TextField
            label={initial.hasPassword ? t("Contraseña (vacío = la guardada)") : t("Contraseña")}
            value={password}
            onChange={(value) => {
              setPassword(value);
              if (value) setClearPassword(false);
            }}
            autoComplete="new-password"
            secret
            optional
          />
          {initial.hasPassword && !password ? (
            <label className="mt-2 flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} />
              {t("Quitar la contraseña guardada")}
            </label>
          ) : null}
        </div>
      </Section>

      <Section title={t("Remitente")}>
        <TextField label={t("Correo del remitente")} value={from} onChange={setFrom} autoComplete="off" type="email" optional />
        <TextField label={t("Nombre del remitente")} value={fromName} onChange={setFromName} autoComplete="off" optional />
      </Section>

      <Section title={t("Enlaces y accesos")}>
        <TextField label={t("Dirección de Grafito")} value={publicUrl} onChange={setPublicUrl} autoComplete="off" type="url" optional />
        <TextField
          label={t("Validez del acceso de un usuario nuevo (horas)")}
          value={hours}
          onChange={setHours}
          autoComplete="off"
          type="number"
        />
      </Section>

      <Section title={t("Prueba")}>
        <TextField label={t("Enviar prueba a")} value={testTo} onChange={setTestTo} autoComplete="email" type="email" optional />
        <div className="flex items-end">
          <button
            type="button"
            disabled={busy !== null || !testTo}
            onClick={() => void test()}
            className="h-11 rounded-md border border-line px-4 text-sm text-fg hover:bg-elevated disabled:opacity-50"
          >
            {busy === "test" ? t("Enviando…") : t("Probar")}
          </button>
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button
          type="submit"
          disabled={busy !== null}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy === "save" ? t("Guardando…") : t("Guardar")}
        </button>
        {message ? <p className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>{t(message.text)}</p> : null}
      </div>
    </form>
  );
}

/** Un grupo de campos con su título, en dos columnas en pantallas anchas. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-medium tracking-widest text-faint uppercase">{title}</legend>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </fieldset>
  );
}
