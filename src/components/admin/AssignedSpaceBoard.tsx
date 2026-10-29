import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { UsageMeter } from "@/components/ui/UsageMeter";
import { formatBytes } from "@/domain/space";
import { assignedSpaceReport, type WorkspaceNode } from "@/server/space-report.functions";
import { t } from "@/app/i18n";

type Report = Extract<Awaited<ReturnType<typeof assignedSpaceReport>>, { ok: true }>;

const percent = (part: number, whole: number | null | undefined) => (whole ? Math.round((part / whole) * 100) : 0);

/**
 * Monitorización → Espacio asignado: el disco del entorno, lo asignado y lo
 * usado de lo asignado, con el detalle de los espacios de trabajo y de los
 * usuarios con tope. Ver `server/space-report.functions.ts`.
 */
export function AssignedSpaceBoard() {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void assignedSpaceReport()
      .then((result) => (result.ok ? setReport(result) : setFailed(true)))
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <p className="text-sm text-danger">{t("No se pudo leer el espacio asignado.")}</p>;
  if (!report) return <p className="text-sm text-faint">{t("Cargando…")}</p>;

  const total = report.disk?.total ?? null;
  return (
    <div data-ui="assigned-space" className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("Espacio total del entorno")} value={total === null ? t("Desconocido") : formatBytes(total)}>
          {report.disk ? (
            <p className="mt-1 text-xs text-faint">
              {t("{0} libres · {1}", { 0: formatBytes(report.disk.available), 1: t(report.disk.source) })}
            </p>
          ) : null}
        </Stat>
        <Stat label={t("Asignado")} value={formatBytes(report.assigned)}>
          {total ? <UsageMeter percent={percent(report.assigned, total)} label={t("Asignado del total")} /> : null}
        </Stat>
        <Stat label={t("Usado de lo asignado")} value={formatBytes(report.usedOfAssigned)}>
          {report.assigned ? (
            <UsageMeter percent={percent(report.usedOfAssigned, report.assigned)} label={t("Usado de lo asignado")} />
          ) : null}
        </Stat>
      </div>
      {total && report.assigned > total ? (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {t("Lo asignado pasa del espacio total del entorno.")}
        </p>
      ) : null}

      <Fold
        title={t("Espacios de trabajo")}
        summary={`${formatBytes(report.workspaces.used)} / ${formatBytes(report.workspaces.assigned)}`}
        empty={report.workspaces.tree.length === 0 ? t("Todavía no hay espacios de trabajo.") : null}
      >
        <Rows>
          {report.workspaces.tree.map((node) => (
            <WorkspaceRow key={node.orgId} node={node} depth={0} />
          ))}
        </Rows>
      </Fold>

      <Fold
        title={t("Usuarios")}
        summary={`${formatBytes(report.users.used)} / ${formatBytes(report.users.assigned)}`}
        empty={report.users.people.length === 0 ? t("Todavía no hay usuarios.") : null}
      >
        <Rows>
          {report.users.people.map((person) => (
            <Row
              key={person.id}
              name={person.name || person.loginName}
              detail={person.limit === null ? t("Sin tope") : person.byDefault ? t("Por defecto") : null}
              used={person.used}
              limit={person.limit}
            />
          ))}
        </Rows>
      </Fold>
    </div>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-1 font-serif text-2xl text-fg tabular-nums">{value}</p>
      {children}
    </div>
  );
}

function Fold({ title, summary, empty, children }: { title: string; summary: string; empty: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <ChevronRight className={`size-4 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</span>
        <span className="shrink-0 text-xs text-muted tabular-nums">{summary}</span>
      </button>
      {open ? empty ? <p className="border-t border-line px-4 py-3 text-sm text-faint">{empty}</p> : <div className="border-t border-line">{children}</div> : null}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        <col />
        <col className="w-28" />
        <col className="w-28" />
        <col className="w-40" />
      </colgroup>
      <thead className="text-left text-xs text-faint">
        <tr>
          <th className="px-4 py-2 font-medium">{t("Nombre")}</th>
          <th className="px-3 py-2 text-right font-medium">{t("Usado")}</th>
          <th className="px-3 py-2 text-right font-medium">{t("Asignado")}</th>
          <th className="px-4 py-2 font-medium" />
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Row({
  name,
  detail,
  used,
  limit,
  depth = 0,
}: {
  name: string;
  detail: string | null;
  used: number;
  limit: number | null;
  depth?: number;
}) {
  const value = percent(used, limit);
  return (
    <tr className="border-t border-line align-middle">
      <td className="min-w-0 px-4 py-2">
        <span className="block truncate text-fg" style={{ paddingLeft: `${depth * 1.25}rem` }}>
          {name}
        </span>
        {detail ? (
          <span className="block truncate text-xs text-faint" style={{ paddingLeft: `${depth * 1.25}rem` }}>
            {detail}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right text-muted tabular-nums">{formatBytes(used)}</td>
      <td className="px-3 py-2 text-right text-muted tabular-nums">{limit === null ? t("Sin tope") : formatBytes(limit)}</td>
      <td className="px-4 py-2">
        {limit ? (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
              <div className={`h-full rounded-full ${value >= 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.min(100, value)}%` }} />
            </div>
            <span className="w-9 text-right text-xs text-muted tabular-nums">{value} %</span>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function WorkspaceRow({ node, depth }: { node: WorkspaceNode; depth: number }) {
  return (
    <>
      <Row
        name={node.name}
        detail={node.given ? t("{0} a sus organizaciones", { 0: formatBytes(node.given) }) : null}
        used={node.used}
        limit={node.bytes === null ? null : node.bytes - node.given}
        depth={depth}
      />
      {node.children.map((child) => (
        <WorkspaceRow key={child.orgId} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
