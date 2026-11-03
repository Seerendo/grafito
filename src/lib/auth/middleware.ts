import { createMiddleware } from "@tanstack/react-start";

/**
 * Standard server-function authentication middleware supplies a verified context.userId. Scope
 * SQL queries to that ID. Missing sessions throw UnauthorizedError from verify.server.ts.
 */
export const authMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    // Forward the client's bearer token to the server when present.
    const { getBearerToken } = await import("./bearer");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    // Import server APIs only through .server modules here; this middleware is also bundled for browsers.
    const { assertSameSiteRequest } = await import("./isolation.server");
    const { requireUserId } = await import("./verify.server");
    assertSameSiteRequest();
    const userId = await requireUserId(context.bearerToken);
    return next({ context: { userId } });
  });
