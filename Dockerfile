# Grafito: build de producción (Vite + Nitro node-server) y una imagen final
# que solo lleva la salida compilada.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Sin DATABASE_URL en el build, `db:migrate` no hace nada: las migraciones se
# aplican al arrancar, en la primera consulta a Postgres (src/lib/db.ts).
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY --from=build /app/.output ./.output

EXPOSE 8080

CMD ["node", ".output/server/index.mjs"]
