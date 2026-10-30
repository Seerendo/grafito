import { intl, t } from "@/app/i18n";
import { expiryAt, type ExpiryChoice } from "@/domain/access-window";

/** Caducidad que el usuario elige en Compartir y en el formulario. */

export function utcDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Lo que hay que mandar al guardar.
 * `undefined` deja cada permiso con su caducidad (cuando no coinciden y nadie tocó el control).
 */
export function chosenExpiry(
  touched: boolean,
  mixed: boolean,
  mode: ExpiryChoice,
  date: string,
  existing: number | null,
): number | null | undefined {
  if (!touched) return mixed ? undefined : existing;
  return expiryAt(mode, date, Date.now());
}

export function ExpiryField({
  mode,
  date,
  mixed,
  onChange,
}: {
  mode: ExpiryChoice;
  date: string;
  mixed?: boolean;
  onChange: (mode: ExpiryChoice, date: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="text-xs text-faint">{t("Caduca")}</span>
        <select
          value={mode}
          onChange={(event) => onChange(event.target.value as ExpiryChoice, date)}
          className="mt-1 h-10 w-full rounded-md border border-line bg-inset px-2 outline-none"
        >
          <option value="never">{t("No caduca")}</option>
          <option value="1">{t("1 día")}</option>
          <option value="7">{t("7 días")}</option>
          <option value="30">{t("30 días")}</option>
          <option value="90">{t("90 días")}</option>
          <option value="date">{t("Fecha")}</option>
        </select>
      </label>
      {mode === "date" ? (
        <input
          type="date"
          value={date}
          onChange={(event) => onChange("date", event.target.value)}
          className="h-10 w-full rounded-md border border-line bg-inset px-2 outline-none"
        />
      ) : null}
      {mixed ? <p className="text-xs text-muted">{t("Hay permisos con distinta caducidad.")}</p> : null}
    </div>
  );
}

type Period = {
  subjectKind: string;
  subjectName: string;
  grantedAt: number;
  expiresAt: number | null;
  endedAt: number | null;
  endKind: string;
};

type Hit = { at: number; channel: string; actorName: string };

function stamp(at: number): string {
  return new Intl.DateTimeFormat(intl(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(at);
}

function eventLine(event: Hit): string {
  if (event.channel === "public") return t("Abrió el enlace");
  if (event.channel === "form") {
    return event.actorName === "Alguien envió el formulario" ? t("Envió el formulario") : t("Alguien abrió el formulario");
  }
  return event.actorName ? `${event.actorName} · ${t("Abrió lo compartido")}` : t("Abrió lo compartido");
}

/** Periodos de permiso (vigentes y cerrados) y últimas aperturas. */
export function AccessTrail({ periods, events }: { periods: Period[]; events: Hit[] }) {
  if (periods.length === 0 && events.length === 0) return <p className="text-xs text-muted">{t("Sin actividad.")}</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted">{t("Actividad")}</p>
      <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted">
        {periods.map((period, index) => (
          <li key={`${period.subjectKind}-${period.subjectName}-${period.endedAt ?? "open"}-${index}`}>
            <span className="text-fg">{period.subjectKind === "link" ? t("Enlace público") : period.subjectName || t("Alguien")}</span>
            {" · "}
            {period.endKind === "revoked" ? t("Revocado") : period.endKind === "expired" ? t("Caducado") : t("Vigente")}
            {period.grantedAt > 0 ? ` · ${t("Desde {0}", { 0: stamp(period.grantedAt) })}` : ""}
            {period.endKind === ""
              ? ` · ${period.expiresAt ? t("Hasta {0}", { 0: stamp(period.expiresAt) }) : t("No caduca")}`
              : period.endedAt
                ? ` · ${t("Hasta {0}", { 0: stamp(period.endedAt) })}`
                : ""}
          </li>
        ))}
        {events.map((event, index) => (
          <li key={`event-${event.at}-${index}`}>
            {stamp(event.at)} · {eventLine(event)}
          </li>
        ))}
      </ul>
    </div>
  );
}
