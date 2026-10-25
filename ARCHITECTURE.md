# Arquitectura de Grafito

Grafito es una bóveda de notas en Markdown con enlaces `[[wiki]]`, etiquetas,
portafolios, archivos adjuntos, diagramas Mermaid, grafo de relaciones y
exportación a PDF. Tiene un administrador, roles y un panel de administración.

## Stack

| Capa | Tecnología |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (React 19 + SSR + funciones de servidor) |
| Rutas | TanStack Router, rutas por archivo en `src/routes/` |
| Estilos | Tailwind CSS v4 (`src/styles.css`, temas por `data-theme`) |
| Estado de cliente | zustand (`src/app/vault/store.ts`), persistido en `localStorage` |
| Autenticación | Better Auth, usuario y contraseña locales |
| Base relacional | Postgres (`DATABASE_URL`) o PGLite embebido en `.data/pglite` |
| Búsqueda | Elasticsearch (`ELASTICSEARCH_URL`) o índice en Postgres |
| Archivos | MinIO / S3 (`S3_*`) o la bóveda del navegador |
| Sesiones | Redis (`REDIS_URL`) para el plazo de sesión, o Postgres |
| Build | Vite 8 + Nitro (preset `node-server`; `NITRO_PRESET=vercel` para Vercel) |

Cada servicio externo es opcional: si falta su variable, Grafito usa el recurso
local indicado (ver `.env.example` y `src/server/platform.ts`).

## Cómo se arranca

- **Docker (forma prevista):** `docker compose up -d --build` levanta Postgres,
  Elasticsearch, Redis, MinIO y la app en `http://127.0.0.1:8080`. La imagen
  es un **build de producción** en dos etapas: compila con `npm run build` y
  la final solo lleva `.output/` y ejecuta `node .output/server/index.mjs`
  (~356 MB de imagen, ~50 MB de memoria). Todos los servicios tienen
  `restart: unless-stopped`.
- **Local sin Docker:** `scripts/launch-guard.mjs` bloquea `npm run dev` salvo
  que exista `GRAFITO_FROM_DOCKER=1` o `GRAFITO_INTERNAL_DEV=1`. Con la segunda
  se usa PGLite y ningún servicio externo.
- `.claude/launch.json` arranca Vite directamente (sin el guard) para la vista
  previa del editor.

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo en `0.0.0.0:8080` |
| `npm run build` | `vite build` (salida en `.output/`) y luego `db:migrate` |
| `npm start` | Ejecuta el build de producción (`.output/server/index.mjs`) |
| `npm run db:migrate` | Aplica `migrations/*.sql` a `DATABASE_URL` (si existe) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Tests de `scripts/*.test.mjs` |
| `npm run lint` / `format` | ESLint / Prettier |

## Carpetas

```text
grafito/
├── migrations/          SQL versionado (se aplica una vez, por nombre de archivo)
├── public/              Estáticos: favicon, icono, manifest PWA, imagen OG
├── scripts/             Utilidades Node: launch-guard, migraciones y su test
├── src/
│   ├── routes/          Rutas (archivo = URL) — capa más delgada posible
│   ├── components/      UI de React, agrupada por pantalla/área
│   ├── app/             Estado y servicios de cliente (store, tema, perfil)
│   ├── domain/          Lógica pura, sin React ni E/S (testeable)
│   ├── server/          Funciones de servidor e integraciones externas
│   ├── lib/             Infraestructura transversal: auth, base de datos, errores
│   ├── router.tsx       Crea el router (`getRouter`)
│   ├── routeTree.gen.ts Generado por TanStack Router — no editar
│   └── styles.css       Tailwind + tokens de los temas
├── vite.config.ts       Vite + TanStack Start + Nitro + arranque de PGLite
├── docker-compose.yml   Servicios para desarrollo/despliegue con Docker
└── Dockerfile           Imagen de la app
```

### Dependencias entre capas

```text
routes ─▶ components ─▶ app ─▶ domain
                │         │
                ▼         ▼
             server ─▶ lib (auth, db)
```

- `domain/` no importa nada de la app: solo tipos y funciones puras.
- `app/` (cliente) usa `domain/` y llama a `server/` mediante funciones de servidor.
- `server/` corre solo en el servidor; los componentes lo importan únicamente a
  través de `createServerFn`, que Vite convierte en llamadas RPC.
- `lib/auth/*.server.ts` y `lib/auth/server.ts` nunca deben llegar al navegador.

### `src/routes/`

| Archivo | URL | Contenido |
| --- | --- | --- |
| `__root.tsx` | — | Documento HTML, `<head>`, script de tema sin destello, `SessionWatch` |
| `index.tsx` | `/` | `AccessGate` + `VaultApp` |
| `login.tsx` | `/login` | `AccessGate` y redirección a `/` |
| `cuenta.tsx` | `/cuenta` | `AccountScreen` |
| `admin.tsx` | `/admin` | `AdminScreen` |
| `api/auth/$.ts` | `/api/auth/*` | Handler de Better Auth |
| `compartidos/index.tsx` | `/compartidos` | `AccessGate` + lista de lo compartido conmigo |
| `compartidos/$shareId.tsx` | `/compartidos/<id>` | `AccessGate` + visor de solo lectura |
| `p/$token.tsx` | `/p/<token>` | Visor público por enlace, **sin sesión** (no pasa por `AccessGate`) |
| `api/v1/*.ts` | `/api/v1/…` | API REST de la bóveda (ver «API REST») |
| `api/ai/chat.ts` | `/api/ai/chat` | Chat de IA (respuesta NDJSON) |

### `src/components/`

| Carpeta | Contenido |
| --- | --- |
| `ui/` | Piezas reutilizables sin lógica de negocio: `TextField`, `SearchField` (búsqueda sin autofoco), `Select` (selector con flecha propia), `Switch` (interruptor; pista `bg-inset`/`border-line` y bolita `bg-muted` apagado, pista `bg-accent` y bolita `bg-accent-fg` encendido, para que se distinga en todos los temas, también Folleto), `OptionGrid` (tarjetas de secciones para móvil), `Modal`, `TextAction` (acción en texto, p. ej. «Eliminar»), `UsageMeter` (medidor de uso con porcentaje) |
| `chrome/` | Marco común: `ChromeHeader` (búsqueda, menú de cuenta), `AppFrame` (cabecera + contenido) y `SettingsNav` (barra lateral de secciones plegable a un riel de iconos, recordada en `localStorage`; la usan Administración y Cuenta) |
| `brand/` | Marca (`Mark`) |
| `access/` | `AccessGate`: primer arranque, ingreso y cambio obligatorio de contraseña |
| `account/` | `AccountScreen` por secciones (misma estructura que Administración): `ProfileForm` (datos de la cuenta), `PasswordForm` (contraseña), `AiSettings` (conexiones de IA, `ai.use`) y `ApiTokens` (API, `api.use`); las dos últimas se ocultan sin permiso |
| `admin/` | Pantalla de administración y sus tableros: `Boards` (usuarios, roles, monitor, logs), `OrgsBoard` (organizaciones) y `AuthBoards` (LDAP, OAuth, SSO) |
| `session/` | `SessionWatch`: vigila el plazo de sesión y cierra al vencer |
| `ai/` | `AiChat`: botón flotante y panel del chat (Ctrl+B) |
| `share/` | `SharedViewer` (visor de solo lectura reutilizable; dentro de la bóveda sin índice propio, `index={false}`), `shared-tree.ts` (recorrido de un elemento compartido) y `ShareScreens` (`/compartidos`, elemento compartido y vista pública) |
| `vault/` | La bóveda: `VaultApp` (layout), `Sidebar`, `EditorPane`, `MarkdownView`, `ContextPane`, `GraphView`, `CommandPalette`, `FileView`, `MermaidDiagram`, `NotePdf`, `HomeBoard`, `VaultMirror` (sincroniza con el índice del servidor) e `ingest-files.ts` |

### `src/app/` (cliente)

| Archivo | Responsabilidad |
| --- | --- |
| `vault/store.ts` | Store zustand de la bóveda (notas, portafolios, archivos), persistido en `localStorage` por usuario (`grafito.v2:<userId>`); se abre con `openVaultFor(userId)` y se cierra con `closeVault()` |
| `vault/seed.ts` | Notas de ejemplo del primer uso, agrupadas bajo el portafolio «Documentación» |
| `theme.ts` | Catálogo de temas, aplicar/ciclar tema, script de arranque generado desde `THEMES` |
| `account-profile.ts` | Perfil de la cuenta activa (nombre, iniciales, rol) |
| `vault/sync.ts` | Sincronización de la bóveda con el servidor (revisiones y huellas por documento) |
| `ai-chat.ts` | Estado del chat de IA: abierto, modelo elegido, conversación y lectura del NDJSON |
| `shares.ts` | Lo que el usuario tiene compartido (`useMyShares`, `visibilityMap`, `publicUrl`) |
| `shared-view.ts` | Elemento compartido conmigo abierto en la bóveda (`useSharedView`); abrir una nota propia, Raíz o salir lo cierra |
| `permissions.ts` | Permisos del usuario en el cliente: `can()`, `useCan()`, `usePermissions()`; los carga `AccessGate` y los refresca el pulso de `SessionWatch` |
| `actor.ts` | Nombre de quien crea/edita notas |
| `plugins.ts` | Flags de plugins activos |
| `vault-hold.ts` | Recuerda al administrador que tiene la bóveda abierta |
| `leave.ts` | Salir: revoca la sesión, limpia estado local y cierra Better Auth |

### `src/domain/` (lógica pura)

| Archivo | Responsabilidad |
| --- | --- |
| `vault/types.ts` | Tipos del modelo (Document, Portfolio, VaultFile, GraphEdge…) |
| `vault/links.ts` | Enlaces `[[wiki]]`, etiquetas, encabezados, conteo de palabras |
| `vault/graph.ts` | Aristas del grafo e intención de clic |
| `vault/portfolios.ts` | Árbol de portafolios |
| `vault/migrate.ts` | Migración de bóvedas antiguas: formato v1 y `nestSamplePortfolios` (mete los portafolios de ejemplo en «Documentación», una sola vez) |
| `session.ts` | Plazos de sesión permitidos |
| `ai.ts` | Catálogo de los 8 proveedores de IA y su protocolo |
| `orgs.ts` | Organizaciones: `childOrgs`, `orgSubtree`, `orgPath`, `wouldCycle` |
| `share.ts` | Compartir: `Visibility`, `coveredBy` / `coveredByAll` (qué cubre una nota o un portafolio con sus subportafolios) |
| `permissions.ts` | Claves de permiso de la bóveda (`PERMISSION`) y cuál aplica a borrar/exportar según el tipo |

### `src/server/` (solo servidor)

| Archivo | Responsabilidad |
| --- | --- |
| `admin.functions.ts` | Funciones de servidor de instalación, administración, usuarios, roles, plugins, fuentes e índice |
| `session.functions.ts` | Pulso de sesión, plazo, cuenta propia y espacio usado |
| `lease.ts` | "Arriendo" de sesión con plazo (Redis o Postgres). Un ingreso posterior al vencimiento recibe un plazo nuevo en vez de ser expulsado |
| `platform.ts` | Constantes del administrador y detección de motores por variables de entorno |
| `profile.ts` | Perfil y permisos de un usuario |
| `share.ts` | Acceso a datos de lo compartido: elementos, invitados, copia publicada, lectura por usuario y por enlace |
| `vault.ts` / `vault.functions.ts` | Bóveda en el servidor: sincronización (`pushChanges`/`pullChanges`) y operaciones para la API y la IA |
| `api.ts` / `api-tokens.ts` / `api-tokens.functions.ts` | API REST: autenticación (token o sesión), respuestas y tokens personales |
| `crypto.ts` | AES-256-GCM con `GRAFITO_ENCRYPTION_KEY` |
| `ai/` | IA: adaptadores (`openai`, `anthropic`, `gemini`, `ollama`), `config` (permitidos y claves), `tools` (herramientas de la bóveda) y `agent` (bucle del asistente) |
| `ai.functions.ts` | Administración → IA, Cuenta → IA y estado del chat |
| `orgs.ts` / `orgs.functions.ts` | Organizaciones: datos y funciones (permiso `orgs.manage`) |
| `auth.functions.ts` | Administración → Autenticación (`authState`, `saveAuthProvider`, `testLdap`, `testSso`) y `authMethods` (público: qué botones muestra el ingreso) |
| `share.functions.ts` | Funciones de servidor de compartir: `myShares`, `shareUsers`, `setShare`, `publishShared`, `sharedWithMe`, `openShared`, `openPublic` (esta última sin sesión) |
| `redis.ts` / `search.ts` / `storage.ts` | Clientes de Redis, Elasticsearch y MinIO/S3 |

### `src/lib/`

| Archivo | Responsabilidad |
| --- | --- |
| `db.ts` | `getSql()` sobre Postgres o PGLite, normalización de tipos y migraciones en PGLite |
| `error-component.tsx` | Pantalla de error por defecto del router |
| `auth/server.ts` | `getAuth()`: Better Auth con email/contraseña y los proveedores externos activos; se cachea y se rehace al cambiar la configuración (`invalidateAuth`) |
| `auth/providers.server.ts` | Configuración de proveedores (`auth_provider`): lectura, guardado, secretos enmascarados, dominios permitidos |
| `auth/ldap.server.ts` / `auth/ldap-plugin.server.ts` | Verificación LDAP (`ldapts`) y endpoint `POST /api/auth/ldap/sign-in` |
| `auth/provision.server.ts` | Alta de cuentas externas: rol por defecto y nombre de usuario único |
| `auth/external.ts` | Cliente: `ldapSignIn`, `signInWithProvider`, mensajes de error de proveedor |
| `auth/client.ts` | Cliente de Better Auth para el navegador y `signOut()` |
| `auth/password.ts` | `signInWithPassword` y `changePassword`, compartidos por ingreso y cuenta |
| `auth/bearer.ts` | Token de sesión en `sessionStorage` como respaldo de la cookie |
| `auth/cookies.ts` | Nombres de las cookies de sesión |
| `auth/use-current-user.ts` | Hooks `useCurrentUserState` / `useCurrentUser` |
| `auth/gates.tsx` | `RedirectToSignIn` |
| `auth/middleware.ts` | `authMiddleware` para funciones de servidor (inyecta `context.userId`) |
| `auth/verify.server.ts` | Resolución de sesión en el servidor y `UnauthorizedError` |
| `auth/isolation.server.ts` | Bloqueo de peticiones cross-site con Fetch-Metadata |
| `auth/pglite-dialect.ts` | Dialecto Kysely para que Better Auth use PGLite |

### `migrations/`

Se aplican en orden por nombre; la tabla `_migrations` guarda cuáles ya corrieron
(clave = nombre de archivo, ver `scripts/migration-plan.mjs`). Con Postgres las
aplica `npm run db:migrate`; con PGLite, `src/lib/db.ts` al primer acceso.
Nunca edites una migración ya aplicada: crea `0006_*.sql`.

| Archivo | Tablas |
| --- | --- |
| `0001_auth.sql` | Esquema de Better Auth: `user`, `session`, `account`, `verification` |
| `0002_admin.sql` | `app_admin`, roles, permisos, fuentes, plugins, `doc_index` |
| `0003`–`0005` | Ajustes, arriendos de sesión, perfiles, roles por usuario, logs |
| `0006_share.sql` | `share_item`, `share_grant`, `published_doc`, `published_portfolio` y el permiso `notes.share` |
| `0009_ai_local_per_user.sql` | La dirección de Ollama / LM Studio pasa a ser de cada usuario (`ai_credential.base_url`) |
| `0008_vault_api_ai.sql` | `vault_state`, `vault_doc`, `vault_portfolio`, `api_token`, `ai_provider`, `ai_credential` y los permisos `ai.use`, `ai.manage`, `api.use` |
| `0007_orgs_auth.sql` | `app_org`, `app_org_member`, `share_org_grant`, `auth_provider`, `app_user_role.source` y los permisos `orgs.manage` / `auth.manage` |

## Flujo de acceso

1. `AccessGate` pregunta `accessState()`: si no hay administrador, muestra
   "Primera vez" (por defecto `admin` / `admin`).
2. Tras crear o entrar, si `mustChangePassword` está activo obliga a cambiarla.
3. Con sesión válida, `VaultApp` abre la bóveda de ese usuario
   (`openVaultFor`) y no pinta nada hasta tenerla; `VaultMirror` replica solo
   esa bóveda al índice del servidor. `SessionWatch` hace un pulso
   periódico y cierra la sesión cuando vence el plazo configurado.
4. Las funciones de servidor usan `authMiddleware`, que valida origen
   (`isolation.server.ts`) y sesión (`verify.server.ts`).

## Limpieza realizada (origen: plantilla Grok App Builder)

El proyecto nació en el sandbox de Grok. Se retiró lo que pertenecía a esa
plataforma y no a Grafito; todo lo movido está en `_respaldo-grok/` con la misma
ruta relativa, para poder recuperarlo. **Bórralo cuando confirmes que todo va bien.**

- Instrucciones y skills del agente: `.grok/`, `AGENTS.md`, `startup.sh`.
- Basura de QA y artefactos: `screenshots/`, `artifacts/`, `.vercel/` (salida de
  build), `.tanstack/`, `.node_modules.lock`.
- Integraciones de la plataforma sin uso en Grafito: broker OAuth de Grok,
  sesiones "gate", popup de ingreso, puente de vista previa, reescritura de rutas
  de vista previa, conectores `app-data`, `multiplayer`, inyector PWA/branding
  (`server/`, `public/__grok/`) y sus scripts de prueba.
- Dependencias sin importar: Radix UI, react-query, react-table, recharts,
  react-hook-form, date-fns, sonner, clsx/tailwind-merge/cva, playwright, etc.

Cambios de código:

- Auth reducida a usuario/contraseña. `requireUserId` ya no tiene la rama de
  "usuario dev" (nunca se activaba: la auth siempre estaba encendida).
- `password.ts` y `bearer.ts` centralizan llamadas y token que estaban
  duplicados en `AccessGate` y `AccountScreen`.
- Componentes compartidos: `ui/TextField` (antes `Field` en dos archivos) y
  `chrome/AppFrame` (antes `Shell`/`Frame` idénticos en admin y cuenta).
- El script de tema de `__root.tsx` se genera desde `THEMES`; antes era una
  copia a mano de la tabla.
- Manifest PWA e icono propios en `public/`; metadatos Open Graph en `__root.tsx`.
- Corregido: tras entrar, crear el administrador o cambiar la contraseña la
  pantalla no avanzaba hasta recargar. `password.ts` usa `fetch` directo (para
  leer `set-auth-token`) y Better Auth solo refresca `useSession()` cuando la
  llamada pasa por `authClient`; ahora se emite `$sessionSignal` a mano.

Se conservaron a propósito los nombres heredados `__Host-grok-auth.*` (cookies)
y `grok-auth.bearer-token` (sessionStorage): cambiarlos cerraría todas las
sesiones abiertas. Están centralizados en `lib/auth/cookies.ts` y
`lib/auth/bearer.ts` por si se quiere renombrarlos más adelante.

## Pendientes conocidos

- PGLite no viaja en el build de producción (su `.wasm` no se incluye): la
  imagen siempre necesita `DATABASE_URL`. Para probar sin Postgres usa
  `npm run dev` con `GRAFITO_INTERNAL_DEV=1`.
- MinIO no aparece en "Espacio": su API de administración no responde con las
  credenciales del cubo.
- `migrations/0001_auth.sql` conserva un comentario que menciona Grok (no se
  edita una migración aplicada).

## Permisos de rol

Los roles y sus permisos se gestionan en Administración → Roles (tabla
`app_role_permission`). Se aplican en tres capas:

1. **Servidor:** las funciones de administración comprueban el permiso del
   actor (`allows()` en `server/profile.ts`); las de la bóveda filtran por
   `context.userId`.
2. **Store de la bóveda** (`app/vault/store.ts`): cada acción que modifica
   (crear, editar, renombrar, borrar, mover, vincular, subir, importar, modo
   edición, grafo) comprueba `can()` antes de cambiar nada. Es el cierre que no
   se salta con atajos de teclado ni arrastrar y soltar.
3. **Interfaz:** los controles sin permiso se ocultan (Grafo, Nueva nota,
   portafolios, subir, vincular, acciones del menú) o se deshabilitan (Editar,
   Dividir, casillas de tareas, título en solo lectura). Sin `notes.read` la
   bóveda muestra un aviso.

`sessionPulse` devuelve los permisos cada 12 s, así que un cambio de rol se
aplica sin volver a entrar; si se retira la edición o el grafo, la vista vuelve
a Leer y el grafo se cierra solo. El administrador inicial siempre tiene todos
los permisos y su rol no se puede cambiar (interfaz y servidor).

## Compartir

Cada nota o portafolio es **privado** por defecto. Su dueño puede cambiarlo con
"Compartir…" (menú "Más acciones" del editor o clic derecho en el directorio),
si su rol tiene `notes.share`:

| Visibilidad | Quién lo ve | Cómo |
| --- | --- | --- |
| Privada | Solo el dueño | No hay fila en `share_item` |
| Compartida | Los usuarios elegidos | "Compartidos conmigo": segunda raíz del directorio (`vault/SharedSection`), se abre en el área principal; `/compartidos` queda para enlaces directos |
| Pública | Cualquiera con el enlace, sin sesión | `/p/<token>` (token aleatorio de 192 bits) |

Todo lo compartido es **de solo lectura**. Compartir un portafolio incluye sus
subportafolios y documentos. El directorio y el editor marcan lo compartido (👥)
y lo público (🌐), también cuando lo heredan de un portafolio.

Como las notas viven en el navegador de su dueño, el servidor guarda una
**copia publicada** (`published_doc`, `published_portfolio`) solo de lo
compartido. `ShareMirror` la actualiza unos 2,5 s después de cada cambio del
dueño, y el servidor recalcula qué cubre cada elemento (`domain/share.ts`), así
que descarta lo que el cliente mande de más. Al pasar algo a privada se borra
su copia; al borrar una nota o un portafolio compartido se quita su elemento
compartido. El servidor solo entrega un elemento a su dueño, a sus invitados o,
si es público, a quien tenga el token.

Limitaciones: los demás ven la última versión que el dueño publicó desde su
navegador (si edita sin conexión, se publica al volver); los archivos
compartidos se guardan en Postgres como data URL (hasta ~1,5 MB cada uno).

## Organizaciones

Administración → Usuarios y permisos → Organizaciones (permiso `orgs.manage`).
Son jerárquicas: cada una puede tener sub-organizaciones (sin ciclos; borrar
una borra sus sub-organizaciones) y miembros. Al **compartir** una nota o un
portafolio con una organización, lo ven sus miembros y los de todas sus
sub-organizaciones; el servidor lo resuelve subiendo desde las organizaciones
del usuario hasta las raíces (consulta recursiva en `server/share.ts`).

## Autenticación externa

Administración → Autenticación (permiso `auth.manage`). Cada proveedor tiene:
activado, rol de las cuentas nuevas (por defecto Miembro) y dominios de correo
permitidos (vacío = cualquiera). Los secretos se guardan en `auth_provider` y
nunca vuelven al navegador; un secreto vacío al guardar conserva el anterior.

| Proveedor | Cómo entra la persona | Detalle |
| --- | --- | --- |
| LDAP / Active Directory | Pestaña «Directorio (LDAP)» del ingreso | La cuenta de servicio busca con el filtro (`{{username}}` escapado) y luego se enlaza con el DN de la persona. Botón «Probar conexión». |
| OAuth: Google, GitHub, Microsoft | Botón «Continuar con…» | Proveedores sociales de Better Auth; el panel muestra la dirección de retorno a registrar. |
| SSO (OpenID Connect) | Botón con el texto configurado (p. ej. «Keycloak») | `genericOAuth` con descubrimiento (`<emisor>/.well-known/openid-configuration`) y PKCE. Botón «Probar emisor». |

La primera vez se crea la cuenta (`provision.server.ts`) con el rol por
defecto y `app_user_role.source` = proveedor; Usuarios lo muestra con una
etiqueta. Una cuenta externa **no** se apropia de una existente por coincidir
el correo (`disableImplicitLinking`, y en LDAP se rechaza con «Ya existe otra
cuenta con ese correo»). Las cuentas LDAP sin correo usan
`<uid>@ldap.grafito.app`.

Para probar: `docker compose --profile auth-test up -d` levanta Keycloak
(`127.0.0.1:8180`) y OpenLDAP con datos de `dev/auth-test/` (ver comentarios en
`docker-compose.yml`).

**Lockfile:** tras `npm install <paquete>` con un npm distinto del de la imagen
(Node 22 / npm 10), regenera `package-lock.json` así para que `npm ci` del
`Dockerfile` no falle:

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-bookworm-slim npm install --package-lock-only
```

## Bóveda en el servidor y sincronización

Desde la migración 0008 la bóveda de cada usuario vive en Postgres
(`vault_doc`, `vault_portfolio`); el navegador guarda una copia para abrir al
instante. `app/vault/sync.ts` la sincroniza:

- Cada cambio en el servidor recibe la siguiente revisión del usuario
  (`vault_state.revision`); las bajas quedan como lápidas.
- El navegador recuerda la última revisión recibida y una huella de cada
  documento tal como quedó sincronizado. Baja lo nuevo, sube lo que cambió aquí
  y, si un documento cambió en los dos lados, gana el más reciente.
- Sincroniza al abrir la bóveda, 1,5 s después de cada cambio, cada 20 s, al
  volver a la pestaña y justo después de que la IA cambie algo.
- Primera vez en un navegador: si el servidor ya tiene la bóveda y aquí solo
  está la de ejemplo, se adopta la del servidor; si aquí había notas guardadas
  (versiones anteriores), se mezclan y se sube lo que falte.
- El servidor rechaza cambios de quien no tiene permisos de escritura y bajas
  sin el permiso de borrar.

## API REST

Autenticación: `Authorization: Bearer gft_…` (token personal, Cuenta → API; en
la base solo se guarda su SHA-256) o la sesión del navegador (solo desde el
mismo sitio). Cada operación comprueba el permiso del rol.

| Método y ruta | Permiso | Qué hace |
| --- | --- | --- |
| `GET /api/v1/me` | — | Usuario, rol y permisos |
| `GET /api/v1/portfolios` | `notes.read` | Portafolios |
| `POST /api/v1/portfolios` `{ name, parentId? }` | `portfolios.manage` | Crea un portafolio |
| `GET /api/v1/notes?portfolio=<id\|root>&q=<texto>&limit=<n>` | `notes.read` | Notas y archivos (sin contenido) |
| `POST /api/v1/notes` `{ title, content?, portfolioId? }` | `notes.create` | Crea una nota |
| `GET /api/v1/notes/:id` | `notes.read` | La nota (o los datos del archivo y su texto si es de texto) |
| `PATCH /api/v1/notes/:id` `{ title?, content?, portfolioId? }` | `notes.edit` | Cambia una nota; renombrar actualiza los `[[enlaces]]` |
| `DELETE /api/v1/notes/:id` | `notes.delete` / `files.delete` | La borra |
| `GET /api/v1/notes/:id/file` | `files.download` | Descarga el archivo |

Errores: JSON `{ "error": "…" }` con 400, 401, 403, 404 o 409.

## Asistente de IA

- **Administración → IA** (`ai.manage`): solo activa o desactiva cada
  proveedor.
- **Cuenta → IA** (`ai.use`): cada persona conecta los permitidos. En los de la
  nube, con su propia clave contra la URL oficial; en Ollama y LM Studio, con la
  dirección de **su propia instancia** y una clave opcional. Se prueba antes de
  guardarse; la clave va cifrada (AES-256-GCM con `GRAFITO_ENCRYPTION_KEY`; solo
  se muestran sus 4 últimos caracteres).
- **Direcciones propias** (`server/ai/local-url.ts`): como es el servidor quien
  las llama, solo se aceptan `http(s)` sin credenciales y se rechazan el propio
  servidor (`localhost`, `127.x`, `::1`, `0.0.0.0`) y los servicios internos
  del despliegue (`postgres`, `redis`, `elasticsearch`, `minio`, `app`…). Se
  vuelve a validar en cada uso y los adaptadores no siguen redirecciones. Una
  dirección de la red local que no sea de Grafito sí se acepta (es el caso de
  uso); si eso no conviene en tu despliegue, desactiva Ollama y LM Studio.
- **Chat**: botón flotante en la bóveda o **Ctrl+B** (dentro del editor de la
  nota Ctrl+B sigue siendo negrita; Esc lo cierra). Sin proveedor conectado lo
  dice y enlaza a Cuenta; con proveedor pero sin modelo, pide elegirlo.

| Proveedor | Protocolo | Dirección | Clave |
| --- | --- | --- | --- |
| ChatGPT (OpenAI) | Chat Completions | `https://api.openai.com/v1` | `Authorization: Bearer` |
| Claude (Anthropic) | Messages (`tool_use` / `tool_result`) | `https://api.anthropic.com` | `x-api-key` + `anthropic-version` |
| Grok (xAI) | Chat Completions | `https://api.x.ai/v1` | Bearer |
| Gemini (Google) | `generateContent` (`functionCall` / `functionResponse`) | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` |
| DeepSeek | Chat Completions | `https://api.deepseek.com` | Bearer |
| Kimi (Moonshot) | Chat Completions | `https://api.moonshot.ai/v1` | Bearer |
| Ollama | `/api/chat` nativo | la instancia de cada usuario | opcional |
| LM Studio | Chat Completions | la instancia de cada usuario (`…/v1`) | opcional |

El agente (`server/ai/agent.ts`) alterna llamadas al modelo y herramientas hasta
8 pasos. Herramientas (solo las que permite el rol): `list_portfolios`,
`list_notes`, `search_notes`, `read_note`, `create_note`, `update_note`,
`create_portfolio`; las de leer y editar aceptan id o título. La respuesta llega
como NDJSON y el chat muestra cada herramienta usada (clic para abrir la nota).

Para probar con un modelo abierto: `docker compose --profile ai-test up -d`
(Ollama con `qwen2.5:1.5b`): activa Ollama en Administración → IA y conéctalo
en Cuenta → IA con `http://ollama:11434`.
