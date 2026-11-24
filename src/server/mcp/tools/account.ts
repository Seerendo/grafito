import { PERMISSION } from "@/domain/permissions";
import type { Tool } from "./tool.ts";

/** Who the token belongs to and what its role allows. */
export const accountTools: Tool[] = [
  {
    permission: PERMISSION.apiUse,
    spec: {
      name: "whoami",
      description:
        "Dice a quién pertenece el token: nombre, usuario, rol y permisos. Úsalo para saber qué puede hacer esta persona.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    run: (_vault, _args, context) =>
      Promise.resolve({
        result: {
          id: context.userId,
          name: context.profile.displayName,
          login: context.profile.loginName,
          role: context.profile.roleName,
          permissions: context.profile.permissions,
        },
        event: { label: "Consultó la cuenta", ok: true },
      }),
  },
];
