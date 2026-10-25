import { createMiddleware } from "@tanstack/react-start";

/**
 * Middleware de auth para funciones de servidor: la forma estándar de obtener
 * el id verificado del usuario.
 *
 *   export const listar = createServerFn({ method: "GET" })
 *     .middleware([authMiddleware])
 *     .handler(async ({ context }) => {
 *       const sql = await getSql();
 *       return sql`select * from notas where user_id = ${context.userId}`;
 *     });
 *
 * Sin sesión lanza `UnauthorizedError` (ver `verify.server.ts`).
 */
export const authMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    // Si el cliente se autentica con token bearer, lo reenvía al servidor.
    const { getBearerToken } = await import("./bearer");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    // Solo módulos `*.server` aquí: este archivo se empaqueta también para el
    // navegador y Vite no debe mandarle `@tanstack/react-start/server`.
    const { assertSameSiteRequest } = await import("./isolation.server");
    const { requireUserId } = await import("./verify.server");
    assertSameSiteRequest();
    const userId = await requireUserId(context.bearerToken);
    return next({ context: { userId } });
  });
