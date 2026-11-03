import { useEffect, useState, type FormEvent } from "react";
import { t } from "@/app/i18n";
import { TextField } from "@/components/ui/TextField";
import { Switch } from "@/components/ui/Switch";
import { clamavAdminState, probeClamav, saveClamavSettings } from "@/server/clamav.functions";

/** Administración → Seguridad: servidor ClamAV, puerto y plazo de análisis. */

type State = Extract<Awaited<ReturnType<typeof clamavAdminState>>, { ok: true }>;
type Status = "off" | "up" | "down";

export function SecurityBoard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void clamavAdminState()
      .then((next) => {
        if (!alive) return;
        if (!next.ok) setError(t("Sin permiso para configurar la seguridad."));
        else setState(next);
      })
      .catch(() => {
        if (alive) setError(t("No se pudo leer la configuración."));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!state) return <p className="text-sm text-muted">{t("Cargando…")}</p>;
  return <AntivirusForm state={state} onSaved={setState} />;
}

function AntivirusForm({ state, onSaved }: { state: State; onSaved: (next: State) => void }) {
  const initial = state.settings;
  const [enabled, setEnabled] = useState(initial.enabled);
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [timeout, setTimeoutSeconds] = useState(String(initial.timeoutSeconds));
  const [status, setStatus] = useState<Status | null>(state.status);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | null>(null);

  const values = () => ({
    enabled,
    host,
    port: Math.round(Number(port) || 0),
    timeoutSeconds: Math.round(Number(timeout) || 0),
  });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setMessage(null);
    try {
      const result = await saveClamavSettings({ data: values() });
      if (!result.ok) setMessage({ ok: false, text: result.error });
      else {
        setMessage({ ok: true, text: "Guardado." });
        const next = await clamavAdminState();
        if (next.ok) {
          onSaved(next);
          setStatus(next.status);
        }
      }
    } catch {
      setMessage({ ok: false, text: "No se pudo guardar." });
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setMessage(null);
    try {
      const result = await probeClamav({ data: { host, port: Math.round(Number(port) || 0) } });
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setStatus(result.status);
    } catch {
      setMessage({ ok: false, text: "No se pudo comprobar." });
      setStatus("down");
    } finally {
      setBusy(null);
    }
  };

  const statusText =
    status === "up"
      ? t("ClamAV responde.")
      : status === "down"
        ? t("ClamAV no responde.")
        : status === "off" || !enabled
          ? t("El antivirus está apagado.")
          : t("Pulsa Comprobar para ver si responde.");

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="space-y-5 rounded-lg border border-line bg-surface p-4"
    >
      <p className={`text-sm ${status === "up" ? "text-accent" : "text-muted"}`}>{statusText}</p>
      <Switch
        checked={enabled}
        onChange={(next) => {
          setEnabled(next);
          setStatus(null);
        }}
        label={t("Activar el antivirus")}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <TextField
          label={t("Servidor")}
          value={host}
          onChange={(value) => {
            setHost(value);
            setStatus(null);
          }}
          autoComplete="off"
          optional
        />
        <TextField
          label={t("Puerto")}
          value={port}
          onChange={(value) => {
            setPort(value);
            setStatus(null);
          }}
          autoComplete="off"
          type="number"
        />
        <TextField
          label={t("Tiempo de espera (segundos)")}
          value={timeout}
          onChange={setTimeoutSeconds}
          autoComplete="off"
          type="number"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button
          type="submit"
          disabled={busy !== null}
          className="h-11 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {busy === "save" ? t("Guardando…") : t("Guardar")}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void check()}
          className="h-11 rounded-md border border-line px-4 text-sm hover:bg-elevated disabled:opacity-50"
        >
          {busy === "check" ? t("Comprobando…") : t("Comprobar")}
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
