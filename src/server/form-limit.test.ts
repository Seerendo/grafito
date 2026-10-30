import assert from "node:assert/strict";
import { test } from "node:test";
import { allowPublicForm, clientAddress, LIMITS, resetFormLimits } from "./form-limit.ts";

/** Límite de envíos de los formularios públicos. */

test("una misma dirección no puede enviar sin parar", () => {
  resetFormLimits();
  for (let index = 0; index < LIMITS.submitPerAddress; index += 1) assert.ok(allowPublicForm("submit", "t", "1.1.1.1", 1000));
  assert.equal(allowPublicForm("submit", "t", "1.1.1.1", 1000), false);
  // Otra dirección sí, y pasado el minuto también la primera.
  assert.ok(allowPublicForm("submit", "t", "2.2.2.2", 1000));
  assert.ok(allowPublicForm("submit", "t", "1.1.1.1", 62_000));
});

test("el formulario entero tiene su tope", () => {
  resetFormLimits();
  for (let index = 0; index < LIMITS.submitPerForm; index += 1) assert.ok(allowPublicForm("submit", "f", `10.0.0.${index}`, 1000));
  assert.equal(allowPublicForm("submit", "f", "10.0.1.1", 1000), false);
});

test("la dirección es la que añade el gateway, no la que manda el cliente", () => {
  assert.equal(clientAddress(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9");
  assert.equal(clientAddress(new Headers()), "desconocida");
});
