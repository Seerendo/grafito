#!/usr/bin/env node
/**
 * Grafito normally starts through Docker Compose. dev and preview reject unconfigured local
 * launches. GRAFITO_FROM_DOCKER=1 is set by the image; GRAFITO_INTERNAL_DEV=1 enables local
 * development with PGLite and no external services.
 */
const allowed = process.env.GRAFITO_FROM_DOCKER === "1" || process.env.GRAFITO_INTERNAL_DEV === "1";

if (!allowed) {
  console.error("Grafito se levanta con: docker compose up --build");
  process.exit(1);
}
