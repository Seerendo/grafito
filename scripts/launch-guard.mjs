#!/usr/bin/env node
/**
 * Grafito se levanta con Docker Compose. `npm run dev` / `npm run preview`
 * se niegan en una terminal normal para no arrancar un Node a medio configurar.
 * La imagen define GRAFITO_FROM_DOCKER=1; GRAFITO_INTERNAL_DEV=1 lo permite
 * para desarrollo local (con PGLite y sin servicios externos).
 */
const allowed =
  process.env.GRAFITO_FROM_DOCKER === "1" || process.env.GRAFITO_INTERNAL_DEV === "1";

if (!allowed) {
  console.error("Grafito se levanta con: docker compose up --build");
  process.exit(1);
}
