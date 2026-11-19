import { useUploads } from "@/app/files";
import { t } from "@/app/i18n";
import {
  cancelUpload,
  dismissUpload,
  pauseUpload,
  resumeUpload,
  useUploadQueue,
  type JobView,
} from "@/app/upload-queue";

/**
 * Background uploads, bottom right on every page: progress, pause, resume and cancel while it
 * runs; when it ends, a summary to check that the whole folder arrived and what did not.
 */
export function UploadQueuePanel() {
  const jobs = useUploadQueue((state) => state.jobs);
  if (jobs.length === 0) return null;
  return (
    <section
      data-ui="upload-queue"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-40 max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] space-y-2 overflow-y-auto"
    >
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </section>
  );
}

const STATE_LABEL = {
  skipped: "Omitido",
  infected: "Antivirus",
  failed: "Error",
  pending: "Sin subir",
  done: "Subido",
} as const;

function heading(job: JobView): string {
  if (job.status === "running") return t("Subiendo a «{0}»", { 0: job.label });
  if (job.status === "paused") return t("En pausa: «{0}»", { 0: job.label });
  if (job.status === "cancelled") return t("Carga cancelada: «{0}»", { 0: job.label });
  return t("Carga terminada: «{0}»", { 0: job.label });
}

function JobCard({ job }: { job: JobView }) {
  const uploads = useUploads((state) => state.uploads);
  const { files, folders } = job.counts;
  const handled = files.done + files.skipped + files.infected + files.failed;
  const percent = files.total > 0 ? Math.round((handled / files.total) * 100) : 100;
  const name = job.current.split("/").pop() ?? "";
  const live = uploads.find((upload) => upload.name === name);
  const filePercent = live && live.total > 0 ? Math.round((live.sent / live.total) * 100) : null;
  const active = job.status === "running" || job.status === "paused";
  return (
    <article
      data-job={job.status}
      className="rounded-lg border border-line bg-surface p-4 text-sm shadow-2xl"
    >
      <h2 className="truncate font-medium">{heading(job)}</h2>
      <p data-ui="upload-counts" className="mt-1 text-xs text-muted tabular-nums">
        {folders.total > 0
          ? t("{0} de {1} archivos · {2} de {3} carpetas", {
              0: files.done,
              1: files.total,
              2: folders.done,
              3: folders.total,
            })
          : t("{0} de {1} archivos", { 0: files.done, 1: files.total })}
      </p>
      {active ? (
        <>
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-inset">
            <span
              className="block h-full bg-accent transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </span>
          {job.status === "running" && job.current ? (
            <p className="mt-1 flex gap-2 text-xs text-faint">
              <span className="min-w-0 flex-1 truncate">{job.current}</span>
              {filePercent !== null ? (
                <span className="shrink-0 tabular-nums">{filePercent}%</span>
              ) : null}
            </p>
          ) : null}
        </>
      ) : (
        <Summary job={job} />
      )}
      {job.error ? <p className="mt-2 text-xs text-danger">{t(job.error)}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {job.status === "running" ? (
          <QueueButton onClick={() => pauseUpload(job.id)}>{t("Pausar")}</QueueButton>
        ) : null}
        {job.status === "paused" ? (
          <QueueButton onClick={() => resumeUpload(job.id)}>{t("Reanudar")}</QueueButton>
        ) : null}
        {active ? (
          <QueueButton tone="danger" onClick={() => cancelUpload(job.id)}>
            {t("Cancelar")}
          </QueueButton>
        ) : (
          <QueueButton onClick={() => dismissUpload(job.id)}>{t("Cerrar")}</QueueButton>
        )}
      </div>
    </article>
  );
}

function Summary({ job }: { job: JobView }) {
  const { files, folders } = job.counts;
  const lines: [string, number, string][] = [
    [t("Archivos subidos"), files.done, ""],
    [t("Carpetas creadas o ya existentes"), folders.done, ""],
    [t("Omitidos por su extensión"), files.skipped, "text-muted"],
    [t("Rechazados por el antivirus"), files.infected, "text-danger"],
    [t("Con error"), files.failed + folders.failed, "text-danger"],
    [t("Sin subir"), files.pending, "text-muted"],
  ];
  const problems = job.problems;
  return (
    <div data-ui="upload-summary" className="mt-2 space-y-1">
      <ul className="space-y-0.5 text-xs">
        {lines
          .filter(
            ([, value], index) => index === 0 || (index === 1 && folders.total > 0) || value > 0,
          )
          .map(([label, value, tone]) => (
            <li key={label} className={`flex justify-between gap-3 ${tone}`}>
              <span>{label}</span>
              <span className="tabular-nums">{value}</span>
            </li>
          ))}
      </ul>
      {problems.length > 0 || files.pending > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">{t("Ver detalle")}</summary>
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {problems.map((problem) => (
              <li key={problem.path} data-state={problem.state}>
                <span className="font-medium">{problem.path}</span>
                <span className="text-muted">
                  {" "}
                  · {t(STATE_LABEL[problem.state])}: {t(problem.reason)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function QueueButton({
  onClick,
  children,
  tone,
}: {
  onClick: () => void;
  children: string;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 rounded-md border border-line px-3 text-sm hover:bg-elevated ${tone === "danger" ? "text-danger" : ""}`}
    >
      {children}
    </button>
  );
}
