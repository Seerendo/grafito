import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import { DESIGN_IDS } from "@/domain/design";
import { readDesign, writeDesign } from "@/server/design";
import { requireLease } from "@/server/lease";
import { readUserProfile } from "@/server/profile";

/** Public installation design used by sign-in as well as authenticated pages. */
export const currentDesign = createServerFn({ method: "GET" }).handler(async () => {
  const { getSql } = await import("@/lib/db");
  return readDesign(await getSql());
});

/** Change the installation-wide appearance design. */
export const setDesign = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ design: z.enum(DESIGN_IDS) }).parse(input))
  .handler(async ({ context, data }) => {
    const sql = await requireLease(context.userId);
    const profile = await readUserProfile(sql, context.userId);
    if (!profile.canAdmin) return { ok: false as const, error: "Sin permiso." };
    await writeDesign(sql, data.design);
    return { ok: true as const };
  });
