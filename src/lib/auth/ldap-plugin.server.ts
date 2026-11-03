import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { getSql } from "../db";
import { authenticate } from "./ldap.server";
import { domainAllowed, providerReady, readProvider, type LdapConfig } from "./providers.server";
import { provisionExternalUser } from "./provision.server";

/** Fallback domain for LDAP accounts without email attributes. */
const LDAP_MAIL_DOMAIN = "ldap.grafito.app";

/**
 * POST /api/auth/ldap/sign-in verifies username/password against the directory, provisions an
 * account with the provider's default role on first login, and opens a normal Better Auth
 * cookie/bearer session.
 */
export function ldapPlugin(): BetterAuthPlugin {
  return {
    id: "grafito-ldap",
    endpoints: {
      ldapSignIn: createAuthEndpoint(
        "/ldap/sign-in",
        {
          method: "POST",
          body: z.object({
            username: z.string().min(1).max(120),
            password: z.string().min(1).max(256),
          }),
        },
        async (ctx) => {
          const sql = await getSql();
          const provider = await readProvider(sql, "ldap");
          if (!providerReady(provider))
            throw new APIError("FORBIDDEN", { message: "LDAP no está activado." });

          let person;
          try {
            person = await authenticate(
              provider.config as LdapConfig,
              ctx.body.username,
              ctx.body.password,
            );
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", {
              message: "No se pudo conectar con el directorio.",
            });
          }
          if (!person)
            throw new APIError("UNAUTHORIZED", { message: "Usuario o contraseña incorrectos." });

          const email = person.email ?? `${person.uid.toLowerCase()}@${LDAP_MAIL_DOMAIN}`;
          if (!domainAllowed(provider, email)) {
            throw new APIError("FORBIDDEN", { message: "Tu dominio de correo no tiene acceso." });
          }

          const adapter = ctx.context.internalAdapter;
          const found = await adapter.findUserByEmail(email, { includeAccounts: true });
          let user = found?.user;
          if (!user) {
            user = await adapter.createUser({ email, name: person.name, emailVerified: true });
          }
          const linked = found?.accounts?.some((account) => account.providerId === "ldap");
          // Do not adopt an existing local or external account by matching email; control of a directory attribute must not enable account takeover.
          if (found && !linked && (found.accounts?.length ?? 0) > 0) {
            throw new APIError("CONFLICT", { message: "Ya existe otra cuenta con ese correo." });
          }
          if (!linked) {
            await adapter.linkAccount({
              userId: user.id,
              providerId: "ldap",
              accountId: person.dn,
            });
          }
          await provisionExternalUser(sql, {
            userId: user.id,
            source: "ldap",
            login: person.uid,
            roleId: provider.defaultRole,
          });

          const session = await adapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true, token: session.token });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
