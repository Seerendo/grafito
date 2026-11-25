import { CalendarDays, MapPin } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { intl, t } from "@/app/i18n";
import type { Answer } from "@/app/mail/meeting-style";
import { mailInvitation, mailRespondInvitation } from "@/server/mailbox.functions";
import { AnswerBadge, AnswerButtons } from "./meeting";

/**
 * A meeting invitation received by mail (its text/calendar part), as Zimbra shows it: what,
 * when, where, who organizes, everyone's answer, and Aceptar · Quizás · Rechazar. Answering puts
 * the event in the account's Agenda with that answer and tells the organizer.
 */

type Found = NonNullable<
  Extract<Awaited<ReturnType<typeof mailInvitation>>, { ok: true }>["invitation"]
>;

export function InvitationCard({ messageId, own }: { messageId: string; own: string }) {
  const [invitation, setInvitation] = useState<Found | null>(null);
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const answer = await mailInvitation({ data: { messageId } }).catch(() => null);
    if (!answer?.ok) {
      setPending(false);
      return false;
    }
    if ("pending" in answer && answer.pending) return true;
    setInvitation(answer.invitation);
    setPending(false);
    return false;
  }, [messageId]);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const tick = async () => {
      const again = await load();
      tries += 1;
      if (alive && again && tries < 30) setTimeout(() => void tick(), 2000);
      else if (alive && again) setPending(false);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [load]);

  if (pending)
    return (
      <p className="mx-4 mt-3 rounded-md border border-line p-3 text-sm text-faint">
        {t("Cargando la invitación…")}
      </p>
    );
  if (!invitation) return null;

  const respond = async (value: Answer) => {
    setBusy(true);
    setError("");
    setNotice("");
    const answer = await mailRespondInvitation({ data: { messageId, answer: value } }).catch(
      () => null,
    );
    setBusy(false);
    if (!answer?.ok) {
      setError(answer?.error ?? "No se pudo responder.");
      return;
    }
    setNotice(
      answer.calendar
        ? t("Respuesta enviada. Está en tu agenda ({0}).", { 0: answer.calendar })
        : t("Respuesta enviada."),
    );
    await load();
  };

  const when = invitation.allDay
    ? new Date(`${invitation.startDate}T00:00:00`).toLocaleDateString(intl(), { dateStyle: "full" })
    : `${new Date(invitation.start).toLocaleString(intl(), { dateStyle: "full", timeStyle: "short" })} – ${new Date(invitation.end).toLocaleTimeString(intl(), { hour: "2-digit", minute: "2-digit" })}`;
  const cancelled = invitation.method === "CANCEL";
  const mine = own.toLowerCase();
  const organizedByMe = invitation.organizer === mine;
  return (
    <section
      data-ui="mail-invitation"
      className={`mx-4 mt-3 flex flex-col gap-2 rounded-md border p-3 text-sm ${cancelled ? "border-danger" : "border-accent/60 bg-accent/5"}`}
    >
      <h3 className="flex items-center gap-2 font-semibold">
        <CalendarDays className="size-4 text-accent" />
        <span className={cancelled ? "line-through" : ""}>
          {invitation.title || t("(sin título)")}
        </span>
        {cancelled ? <span className="text-xs text-danger">{t("Reunión cancelada")}</span> : null}
      </h3>
      <p>{when}</p>
      {invitation.location ? (
        <p className="flex items-center gap-1.5 text-muted">
          <MapPin className="size-4 text-faint" />
          {invitation.location}
        </p>
      ) : null}
      {invitation.organizer ? (
        <p className="text-xs text-faint">
          {t("Organiza")}: {invitation.organizer}
        </p>
      ) : null}
      {invitation.attendees.length ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {invitation.attendees.map((item) => (
            <li key={item.address} className="flex flex-wrap items-center gap-2">
              {item.name || item.address}
              <AnswerBadge
                status={item.address === mine ? invitation.mine || item.status : item.status}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {!cancelled && !organizedByMe && invitation.method !== "REPLY" ? (
        <AnswerButtons
          mine={invitation.mine}
          busy={busy}
          onAnswer={(value) => void respond(value)}
        />
      ) : null}
      {notice ? <p className="text-xs text-accent">{notice}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {t(error)}
        </p>
      ) : null}
    </section>
  );
}
