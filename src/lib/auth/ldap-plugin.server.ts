import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { getSql } from "../db";
import { authenticate } from "./ldap.server";
import { domainAllowed, providerReady, readProvider, type LdapConfig } from "./providers.server";
import { provisionExternalUser } from "./provision.server";

/** Dominio para cuentas LDAP sin atributo de correo. */
const LDAP_MAIL_DOMAIN = "ldap.grafito.app";

/**
 * `POST /api/auth/ldap/sign-in` con `{ username, password }`: verifica contra el
 * directorio, crea la cuenta la primera vez (rol por defecto del proveedor) y
 * abre una sesión normal de Better Auth (cookie y, con el plugin bearer, token).
 */
export function ldapPlugin(): BetterAuthPlugin {
  return {
    id: "grafito-ldap",
    endpoints: {
      ldapSignIn: createAuthEndpoint(
        "/ldap/sign-in",
        {
          method: "POST",
          body: z.object({ username: z.string().min(1).max(120), password: z.string().min(1).max(256) }),
        },
        async (ctx) => {
          const sql = await getSql();
          const provider = await readProvider(sql, "ldap");
          if (!providerReady(provider)) throw new APIError("FORBIDDEN", { message: "LDAP no está activado." });

          let person;
          try {
            person = await authenticate(provider.config as LdapConfig, ctx.body.username, ctx.body.password);
          } catch {
            throw new APIError("SERVICE_UNAVAILABLE", { message: "No se pudo conectar con el directorio." });
          }
          if (!person) throw new APIError("UNAUTHORIZED", { message: "Usuario o contraseña incorrectos." });

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
          // Un correo que ya usa otra cuenta (local u otro proveedor) no se adopta:
          // quien controle ese atributo en el directorio se quedaría con ella.
          if (found && !linked && (found.accounts?.length ?? 0) > 0) {
            throw new APIError("CONFLICT", { message: "Ya existe otra cuenta con ese correo." });
          }
          if (!linked) {
            await adapter.linkAccount({ userId: user.id, providerId: "ldap", accountId: person.dn });
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
