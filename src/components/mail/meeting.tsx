import { Check, CircleHelp, Clock, Repeat, Users, X } from "lucide-react";
import { t } from "@/app/i18n";
import { ANSWER_LABEL, ANSWER_TONE, type Answer } from "@/app/mail/meeting-style";

/**
 * How a meeting looks by this account's answer, as in Zimbra: accepted (or organized) solid,
 * «maybe» striped, waiting for an answer outlined, declined struck through. Shared by the Agenda
 * and the invitation card of a message.
 */

/** Small icons of an event: repeats, has guests, this account's answer. */
export function EventIcons({
  recurring,
  meeting,
  mine,
}: {
  recurring: boolean;
  meeting: boolean;
  mine: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 text-faint">
      {recurring ? <Repeat aria-label={t("Se repite")} className="size-3" /> : null}
      {meeting ? <Users aria-label={t("Reunión")} className="size-3" /> : null}
      {mine === "ACCEPTED" ? (
        <Check
          aria-label={t("Aceptada")}
          className="size-3"
          style={{ color: ANSWER_TONE.ACCEPTED }}
        />
      ) : mine === "TENTATIVE" ? (
        <CircleHelp
          aria-label={t("Quizás")}
          className="size-3"
          style={{ color: ANSWER_TONE.TENTATIVE }}
        />
      ) : mine === "DECLINED" ? (
        <X aria-label={t("Rechazada")} className="size-3" style={{ color: ANSWER_TONE.DECLINED }} />
      ) : mine === "NEEDS-ACTION" ? (
        <Clock aria-label={t("Sin responder")} className="size-3" />
      ) : null}
    </span>
  );
}

/** A guest's answer as a colored dot and its name. */
export function AnswerBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs" data-answer={status}>
      <span
        className="size-2 rounded-full"
        style={{ background: ANSWER_TONE[status] ?? ANSWER_TONE["NEEDS-ACTION"] }}
      />
      {t(ANSWER_LABEL[status] ?? "Sin responder")}
    </span>
  );
}

/** Aceptar · Quizás · Rechazar, with the current answer marked. */
export function AnswerButtons({
  mine,
  busy,
  onAnswer,
}: {
  mine: string;
  busy: boolean;
  onAnswer: (answer: Answer) => void;
}) {
  const options: { answer: Answer; label: string; icon: React.ReactNode }[] = [
    { answer: "ACCEPTED", label: "Aceptar", icon: <Check className="size-4" /> },
    { answer: "TENTATIVE", label: "Quizás", icon: <CircleHelp className="size-4" /> },
    { answer: "DECLINED", label: "Rechazar", icon: <X className="size-4" /> },
  ];
  return (
    <div role="group" aria-label={t("Responder a la reunión")} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.answer}
          type="button"
          disabled={busy}
          aria-pressed={mine === option.answer}
          onClick={() => onAnswer(option.answer)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm disabled:opacity-50"
          style={
            mine === option.answer
              ? {
                  borderColor: ANSWER_TONE[option.answer],
                  background: `${ANSWER_TONE[option.answer]}22`,
                }
              : undefined
          }
        >
          <span style={{ color: ANSWER_TONE[option.answer] }}>{option.icon}</span>
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}
