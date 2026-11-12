import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicSignUp, signUpRefused } from "../../../src/lib/auth/signup-guard.ts";

/** Public email sign-up is refused however the path is written; the rest of /api/auth is not. */

test("el alta por correo se rechaza con cualquier forma de la ruta", () => {
  for (const path of [
    "/api/auth/sign-up/email",
    "/api/auth/sign-up/email/",
    "/api/auth//sign-up//email",
    "/API/AUTH/Sign-Up/Email",
    "/api/auth/sign-up%2Femail",
    "/api/auth/%73ign-up/email",
  ])
    assert.equal(isPublicSignUp(path), true, path);
});

test("entrar, salir y el resto de Better Auth siguen abiertos", () => {
  for (const path of [
    "/api/auth/sign-in/email",
    "/api/auth/sign-out",
    "/api/auth/get-session",
    "/api/auth/change-password",
    "/api/auth/sign-in/social",
    "/api/auth/callback/google",
    "/api/auth/oauth2/callback/sso",
    "/api/auth/sign-in/ldap",
    "/api/auth/sign-up/email-otp",
  ])
    assert.equal(isPublicSignUp(path), false, path);
});

test("una secuencia de escape rota no hace saltar la comprobación", () => {
  assert.equal(isPublicSignUp("/api/auth/sign-up/email%"), false);
  assert.equal(isPublicSignUp("/api/auth/%E0%A4%A/sign-up/email"), true);
});

test("la respuesta es un 403 con el código de Better Auth", async () => {
  const response = signUpRefused();
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    message: "Sign up is not enabled",
  });
});
