# Grafito production build and runtime image containing only compiled output.

FROM node:26.13.1-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Grafeno's SDK follows its latest release at every build instead of the lockfile's version.
# The app checks at runtime that it speaks the engine's API (server/graph/grafeno.ts).
RUN npm install --no-save --no-audit --no-fund @grafenodb/client@latest

COPY . .
# Without DATABASE_URL, build-time migrations are skipped.
# Runtime database initialization applies them before the first query.
RUN npm run build

FROM node:26.13.1-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY --from=build /app/.output ./.output
# The mail-sync worker (src/mail-worker), started by the mail-sync service with its own command.
COPY --from=build /app/.output-mail ./.output-mail

EXPOSE 8080

CMD ["node", ".output/server/index.mjs"]
