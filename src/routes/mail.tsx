import { createFileRoute } from "@tanstack/react-router";
import { MailScreen } from "@/components/mail/MailScreen";

export type MailSearch = {
  /** inbox (default), flagged, sent, drafts, archive, junk, trash */
  box?: string;
  folder?: string;
  account?: string;
  /** Agenda: day, week, month (default), list; and the date it shows (YYYY-MM-DD). */
  view?: string;
  date?: string;
};

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

export const Route = createFileRoute("/mail")({
  component: MailScreen,
  validateSearch: (search: Record<string, unknown>): MailSearch => ({
    box: text(search.box),
    folder: text(search.folder),
    account: text(search.account),
    view: text(search.view),
    date: text(search.date),
  }),
});
