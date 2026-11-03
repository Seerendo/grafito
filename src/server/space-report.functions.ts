import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { minioSpace } from "@/server/storage";
import { defaultUserLimit, portfolioUsage } from "@/server/space";
import { workspaceChildren, workspaces } from "@/server/workspace";

/**
 * Allocated-storage monitoring requires space.manage. Report environment disk, top-level
 * workspace and personal quota allocations, and usage with per-allocation details.
 */

/** File-storage disk: MinIO/S3 when configured, otherwise local volume. */
async function environmentDisk(): Promise<{
  total: number;
  available: number;
  source: string;
} | null> {
  const minio = await minioSpace();
  if (minio) return { total: minio.total, available: minio.available, source: "MinIO" };
  try {
    const { statfsSync } = await import("node:fs");
    const stat = statfsSync(".");
    const block = Number(stat.bsize);
    const total = Number(stat.blocks) * block;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, available: Number(stat.bavail) * block, source: "Disco local" };
  } catch {
    return null;
  }
}

export type WorkspaceNode = {
  orgId: string;
  name: string;
  bytes: number | null;
  used: number;
  /** Child organization allocations deducted from bytes. */
  given: number;
  children: WorkspaceNode[];
};

export const assignedSpaceReport = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!allows(profile, "space.manage")) return { ok: false as const };

    const disk = await environmentDisk();
    const orgs = await sql<{
      id: string;
      name: string;
      parent_id: string | null;
    }>`select id, name, parent_id from app_org`;
    const rows = await workspaces(sql);
    const children = workspaceChildren(orgs, rows);
    const nested = new Set([...children.values()].flat().map((row) => row.org_id));
    const build = async (row: (typeof rows)[number]): Promise<WorkspaceNode> => {
      const below = await Promise.all((children.get(row.org_id) ?? []).map(build));
      return {
        orgId: row.org_id,
        name: orgs.find((org) => org.id === row.org_id)?.name ?? "",
        bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
        used: (await portfolioUsage(sql, row.owner_id, row.root_portfolio_id)).total,
        given: below.reduce((sum, child) => sum + (child.bytes ?? 0), 0),
        children: below.sort((a, b) => a.name.localeCompare(b.name)),
      };
    };
    // Count only top-level workspaces; descendants consume their allocation.
    const tree = await Promise.all(rows.filter((row) => !nested.has(row.org_id)).map(build));
    tree.sort((a, b) => a.name.localeCompare(b.name));
    // Top-level workspace usage includes descendants.
    const totalUsed = (node: WorkspaceNode): number =>
      node.used + node.children.reduce((sum, child) => sum + totalUsed(child), 0);

    const fallback = await defaultUserLimit(sql);
    const users = await sql<{
      id: string;
      name: string;
      login: string | null;
      limit: unknown;
      used: unknown;
    }>`
      select u.id, u.name, coalesce(r.login_name, a.login_name) as login, s.bytes as limit,
        (select coalesce(sum(d.file_size), 0)::bigint from vault_doc d
          where d.kind = 'file' and coalesce(d.uploaded_by, d.user_id) = u.id
            and d.user_id not in (select owner_id from workspace)) as used
      from "user" u
      left join app_user_role r on r.user_id = u.id
      left join app_admin a on a.user_id = u.id
      left join space_user s on s.user_id = u.id
      where u.id not in (select owner_id from workspace)
      order by u.name
    `;
    const people = users.map((row) => {
      const own = row.limit === null || row.limit === undefined ? null : Number(row.limit);
      return {
        id: row.id,
        name: row.name?.trim() || row.login || "",
        loginName: row.login ?? "",
        limit: own ?? fallback,
        byDefault: own === null && fallback !== null,
        used: Number(row.used),
      };
    });

    const workspaceAssigned = tree.reduce((sum, node) => sum + (node.bytes ?? 0), 0);
    const workspaceUsed = tree
      .filter((node) => node.bytes !== null)
      .reduce((sum, node) => sum + totalUsed(node), 0);
    const usersAssigned = people.reduce((sum, person) => sum + (person.limit ?? 0), 0);
    const usersUsed = people
      .filter((person) => person.limit !== null)
      .reduce((sum, person) => sum + person.used, 0);
    return {
      ok: true as const,
      disk,
      assigned: workspaceAssigned + usersAssigned,
      usedOfAssigned: workspaceUsed + usersUsed,
      workspaces: {
        assigned: workspaceAssigned,
        used: tree.reduce((sum, node) => sum + totalUsed(node), 0),
        tree,
      },
      users: {
        assigned: usersAssigned,
        used: people.reduce((sum, person) => sum + person.used, 0),
        people,
      },
    };
  });
