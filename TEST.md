# Pruebas de Grafito

Registro de la prueba completa con Docker Compose después de la limpieza de
arquitectura (ver [ARCHITECTURE.md](ARCHITECTURE.md)).

- **Fecha:** 2026-10-25
- **Entorno:** Windows 11, Docker Desktop 29.6.1, Compose v5.3.0, imagen
  `node:22-bookworm-slim` (npm 10.9.9)
- **Servicios:** postgres 16, elasticsearch 8.15.3, redis 7, MinIO (Chainguard)
- **Navegador:** panel de navegador integrado (Chromium), escritorio y móvil 375×812

## Cómo se hizo

1. Se borró la build anterior: `docker compose down`, se eliminó la imagen
   `grafito-app` y la salida local (`.vercel/`).
2. `docker compose build --no-cache app`.
3. Para no tocar los datos existentes (los volúmenes `grafito_*` ya tenían un
   administrador y 2 usuarios), el e2e corrió en un **proyecto aislado** con
   volúmenes vacíos:

   ```bash
   docker compose -p grafito-e2e up -d --build
   ```

   Al terminar se desmontó con `docker compose -p grafito-e2e down -v` (borra
   solo los volúmenes de prueba).
4. Se volvió a levantar el stack normal (`docker compose up -d`) con la imagen
   nueva: 5 servicios sanos, `GET /` → 200, pantalla de ingreso con los datos
   existentes intactos.

Credenciales usadas solo en el stack desechable: administrador `admin` (inicial
`admin`) y un usuario `e2e` con rol Miembro.

## Resultado general

| Área | Resultado |
| --- | --- |
| Build de la imagen | ✅ (tras corregir el lockfile, ver hallazgo 1) |
| Arranque de servicios y salud | ✅ |
| Migraciones en Postgres | ✅ `0001`–`0005` aplicadas |
| Primer arranque y cambio obligatorio de contraseña | ✅ |
| Ingreso, errores de ingreso y salida | ✅ |
| Notas: crear, editar, enlaces, etiquetas, tareas | ✅ |
| Réplica al servidor (Postgres `doc_index` + Elasticsearch) | ✅ |
| Paleta de búsqueda | ✅ (busca por título y etiquetas) |
| Administración: fuentes, espacio, monitor, logs | ✅ (con observaciones) |
| Usuarios: alta de Miembro y log de auditoría | ✅ |
| Plazo de sesión (Redis) y cierre de sesiones | ✅ |
| Permisos: Miembro sin acceso a administración | ✅ UI y servidor |
| Cuenta: perfil y validación de correo | ✅ |
| Móvil 375×812 | ✅ sin desbordamiento horizontal |
| Aislamiento de datos entre usuarios del mismo navegador | ✅ corregido y verificado (hallazgo 2) |

## Casos probados

### Infraestructura

| Caso | Esperado | Obtenido |
| --- | --- | --- |
| `docker compose -p grafito-e2e up -d --build` | 5 servicios sanos, `minio-init` termina en 0 | ✅ |
| `GET /` | 200 | ✅ 200 |
| `/manifest.webmanifest`, `/icon-180.png`, `/favicon.svg`, `/og.jpg` | 200 | ✅ |
| `/api/auth/get-session` sin sesión | 200 (`null`) | ✅ |
| Rutas retiradas de Grok: `/__grok/manifest.webmanifest`, `/auth/popup`, `/__app-env` | 404 | ✅ |
| `_migrations` en base vacía | `0001`–`0005` | ✅ |
| Índice `grafito-docs` en Elasticsearch | creado | ✅ |

### Acceso

| Caso | Esperado | Obtenido |
| --- | --- | --- |
| Base vacía muestra "Primera vez" con `admin`/`admin` | Sí | ✅ |
| Crear administrador | Pasa a "Cambia la contraseña" **sin recargar** | ✅ (fallo previo ya corregido) |
| Nueva contraseña de menos de 8 caracteres | "necesita al menos 8 caracteres" | ✅ |
| Contraseña actual incorrecta | "No se cambió. Revisa la contraseña actual." | ✅ |
| Cambio válido | Entra a la bóveda | ✅ |
| Ingreso con contraseña incorrecta | "Usuario o contraseña incorrectos." | ✅ |
| Ingreso con usuario inexistente | Mismo mensaje (no revela si existe) | ✅ |
| Ingreso del Miembro | Entra a la bóveda | ✅ |
| Salir | Vuelve al ingreso, 0 filas en `session` | ✅ |

### Bóveda

| Caso | Esperado | Obtenido |
| --- | --- | --- |
| "Nueva nota" | Crea "Sin título" | ✅ |
| Título con teclado + Enter | Se guarda y se replica | ✅ Postgres y Elasticsearch con "Prueba E2E" |
| Cuerpo con `[[Bienvenida]]`, `#e2e #docker`, `- [ ]` | Enlace, etiquetas, casilla, esquema y "escritos en la nota" | ✅ |
| Recargar | La nota persiste | ✅ (`localStorage`) |
| Paleta "Prueba" | Encuentra el documento | ✅ |
| Paleta "docker" | Encuentra la etiqueta | ✅ |
| Paleta "end-to-end" (texto del cuerpo) | — | Sin resultados: la paleta no busca en el cuerpo |
| Grafo | Renderiza | ✅ 14 documentos · 31 vínculos |

### Administración

| Caso | Esperado | Obtenido |
| --- | --- | --- |
| Fuentes → Comprobar | Responden los tres motores | ✅ "Elasticsearch 8.15.3", "MinIO listo. Cubo «grafito»", Postgres |
| Espacio | Tamaños por motor | ✅ con observaciones (hallazgo 6) |
| Monitor de sistema | CPU, memoria, carga | ✅ |
| Nuevo usuario (Miembro) | Aparece en la lista | ✅ |
| Logs de sistema | Registra el alta | ✅ "Crea a e2e · Usuarios · admin" |
| Sesión → 15 min → "Aplicar y salir" | Guarda el plazo y cierra todas las sesiones | ✅ `session_ttl_seconds=900`, Redis sin `grafito:lease:*`, 0 sesiones |
| Miembro abre `/admin` | Bloqueado | ✅ "Sin permiso" |
| Miembro llama a `adminState` en el servidor | Sin datos de administración | ✅ devuelve listas vacías e `isAdmin: false` |

Revisión del código de las funciones de servidor sin comprobación de rol:
`createInitialAdmin` rechaza si ya existe un administrador; `syncDocuments`,
`searchDocuments`, `sessionPulse`, `revokeOwnLease`, `accountState` y
`updateAccount` filtran por `context.userId`. El resto comprueba permisos.

### Cuenta y móvil

| Caso | Esperado | Obtenido |
| --- | --- | --- |
| Correo inválido | Validación del navegador | ✅ |
| Guardar nombre y correo | "Guardado" y las iniciales cambian | ✅ "MR" |
| Móvil 375×812 | Barra inferior, sin scroll horizontal | ✅ `scrollWidth = 375` |

### Consola y logs

- Errores de consola esperados: 401 ×2 (los dos ingresos fallidos a propósito)
  y 400 (cambio con contraseña actual incorrecta).
- 504 "Outdated Optimize Dep" y un import dinámico fallido en la primera visita:
  el optimizador de Vite del modo dev recarga la página una vez (hallazgo 4).
- Logs del contenedor: avisos de Better Auth por el secreto débil (hallazgo 3)
  y `notFoundError` de TanStack Router (hallazgo 7). Ningún error de aplicación.

## Hallazgos

### 1. Lockfile incompatible con el npm de la imagen — corregido

`docker compose build` fallaba en `npm ci` con "Missing: lru-cache@11.5.3 from
lock file". El `package-lock.json` se había regenerado con npm 11 (Node 24
local) al quitar dependencias, y npm 11 no anota el peer opcional `lru-cache@^11`
de `unstorage` que npm 10 (Node 22, el de la imagen) sí exige.
**Corrección:** se regeneró con el npm de la imagen:

```bash
docker run --rm -v "$PWD:/app" -w /app node:22-bookworm-slim npm install --package-lock-only
```

El lockfile resultante vale para `npm ci` con npm 10 y con npm 11.
Recomendación: usar Node 22 también en local (por ejemplo con `.nvmrc`).

### 2. Los usuarios de un mismo navegador compartían la bóveda — **crítico, corregido**

**Problema:** la bóveda se guardaba en `localStorage` con una clave global
(`grafito.v2`), cargada al importar el store, antes de saber quién era el
usuario. Al salir el administrador y entrar el Miembro en el mismo navegador,
el Miembro veía las notas del administrador, y `VaultMirror` las replicaba a su
índice: `doc_index` quedó con 14 documentos (incluida la nota del admin) a
nombre de cada uno. Venía del diseño original, no de la limpieza.

**Corrección:**

- `src/app/vault/store.ts`: cada usuario guarda en `grafito.v2:<userId>`. El
  store arranca vacío (`owner: null`) y `openVaultFor(userId)` carga la bóveda
  de ese usuario, o la de ejemplo si no tiene. `closeVault()` la guarda y la
  descarga. La clave compartida antigua (`grafito.v2` / `grafito.v1`) solo la
  hereda el administrador (`heldAdminId() === userId`), una vez, y después se
  borra.
- `VaultApp` no pinta nada hasta que la bóveda cargada sea la del usuario con
  sesión. `AdminScreen` y la búsqueda de la cabecera también la abren.
- `VaultMirror` solo replica si la bóveda pertenece a la sesión actual.
- `leaveApp` y `SessionWatch` cierran la bóveda al salir o al vencer la sesión.

**Verificación** (stack aislado `grafito-e2e`, base vacía, mismo navegador):

| Paso | Esperado | Obtenido |
| --- | --- | --- |
| Navegador con la clave compartida antigua (nota "Nota heredada"); entra el admin | El admin la hereda y la clave compartida se borra | ✅ solo queda `grafito.v2:<adminId>` |
| El admin escribe `CONTENIDO-SECRETO-ADMIN`, crea un Miembro y sale | — | ✅ |
| Entra el Miembro | Bóveda de ejemplo, sin notas del admin | ✅ no ve "Nota heredada" ni el contenido secreto |
| El Miembro escribe `CONTENIDO-MIEMBRO` | Clave propia `grafito.v2:<miembroId>` | ✅ |
| `doc_index` en el servidor | Cada usuario solo con lo suyo | ✅ admin: 2 docs (heredada + secreto); Miembro: 14 (ejemplo + suya); sin cruces |
| Sale el Miembro y vuelve el admin | Su bóveda, sin la nota del Miembro | ✅ |
| Búsqueda de la cabecera en `/cuenta` | Lista las notas del usuario actual | ✅ |

`npm run typecheck`, `npm test` y `npm run lint` siguen sin errores (los 5
avisos de lint son anteriores).

**Datos ya contaminados:** si en tu instalación un usuario llegó a replicar
notas de otro, se corrige solo: `syncDocuments` borra y reescribe el índice de
cada usuario en su siguiente sincronización (unos 8 s después de abrir su
bóveda). En el navegador donde entre primero el administrador, este heredará la
bóveda compartida antigua; las demás cuentas empiezan con la de ejemplo.

### 3. Secreto de Better Auth débil en `docker-compose.yml`

`BETTER_AUTH_SECRET: grafito-dev-secret-cambia-esto` produce avisos de
longitud y entropía. Para cualquier uso real hay que generar uno
(`openssl rand -base64 32`) y sacarlo del compose (por ejemplo a un `.env`).

### 4. La imagen ejecuta el servidor de desarrollo — corregido (ronda 2)

El `Dockerfile` arranca `npm run dev`: la primera visita recarga la página
(optimizador de Vite), el proceso usa ~2,4 GB de memoria y se sirve sin
minificar. Lo correcto es `npm run build` en la imagen y servir la salida de
Nitro con el preset `node-server` (hoy es `vercel`).

### 5. `app` arrancaba sin sus dependencias tras reiniciar Docker — corregido (ronda 2)

Antes de esta prueba, el contenedor `app` (de la build anterior) estaba en
bucle de reinicio con `getaddrinfo ENOTFOUND postgres`. Docker Desktop se
reinició y solo `app` tiene `restart: unless-stopped`, así que volvió a
arrancar sin los demás servicios. Arreglo: `restart: unless-stopped` en
postgres, elasticsearch, redis y minio.

### 6. Panel "Espacio" incompleto o con datos raros — en parte corregido (ronda 2)

Para Elasticsearch indicaba "base 59 GB" cuando el índice ocupa ~64 kB: era el
espacio usado del disco del nodo. **Corregido:** ahora "base" es el tamaño del
índice (`/_stats/store`). MinIO sigue sin aparecer.

### 7. Sin página 404 propia

Una URL inexistente devuelve el genérico `<p>Not Found</p>` de TanStack Router
y genera avisos `notFoundError` en el log. Falta `defaultNotFoundComponent` en
`src/router.tsx`.

### 8. Observaciones menores

- ~~En "Primera vez" el campo de contraseña es `type="text"`: la contraseña se ve
  en claro.~~ Corregido en la ronda 2.
- Los usuarios creados desde administración no tienen que cambiar la
  contraseña en el primer ingreso (el administrador sí).
- Elasticsearch queda en estado `yellow` porque el índice pide 1 réplica en un
  único nodo; conviene `number_of_replicas: 0`.
- El README habla de roles "editor" y "lector", pero los roles que se ofrecen
  son Administrador, Anónimo y Miembro.
- La paleta de búsqueda no busca en el cuerpo de las notas; la búsqueda de
  texto completo está en administración.

## Ronda 2 — ingreso, administración y permisos

Prueba con la **imagen de producción** nueva, en el stack aislado
`grafito-e2e` con base vacía; al terminar se borró la imagen y se recreó el
stack normal con `docker compose up -d --build` (5 servicios sanos, datos
existentes intactos).

### Ingreso lento o que "se queda cargando"

**Causa 1, el arriendo de sesión:** `assertLease` (`src/server/lease.ts`)
borraba **todas** las sesiones del usuario si su arriendo anterior había
vencido, incluida la que se acababa de crear al entrar. Pasa cada vez que
alguien cierra el navegador sin "Salir" y su plazo vence. El ingreso entraba un
instante y el pulso (12 s) lo expulsaba; el segundo intento funcionaba porque
el arriendo viejo ya estaba borrado. Reproducido: tras entrar quedaban 0
sesiones. **Arreglo:** si existe una sesión creada después del vencimiento, se
borran solo las anteriores y se concede un arriendo nuevo.

**Causa 2, la imagen en modo desarrollo:** Vite dev compilaba cada módulo y
función de servidor en la primera petición (~0,8 s cada una) y forzaba una
recarga de la página en la primera visita ("Outdated Optimize Dep"). **Arreglo:**
`Dockerfile` en dos etapas con build de producción (Nitro `node-server`).

| Medida | Antes (dev) | Después (producción) |
| --- | --- | --- |
| Imagen | 1,35 GB | 356 MB |
| Memoria de `app` | ~2,4 GB | ~48 MB |
| Carga de la página de ingreso | recarga forzada en la 1.ª visita | 120 ms, sin recarga |
| Crear administrador → "Cambia la contraseña" | 665 ms (en caliente) | 462 ms |
| Cambiar contraseña → bóveda | 432 ms | 329 ms |
| Ingreso con arriendo vencido | expulsado a los ~12 s | 211 ms y sigue dentro (1 sesión, arriendo renovado) |

Medido por función de servidor (curl, en caliente): `accessState` ~10 ms,
`sign-in` ~170 ms (hash de la contraseña), `get-session` ~20 ms,
`sessionProfile` ~15–30 ms.

### Casos probados

| Caso | Resultado |
| --- | --- |
| "Primera vez": contraseña inicial oculta | ✅ `type="password"` |
| Espacio y Monitor: medidor nuevo (`ui/UsageMeter`) | ✅ pista redondeada con el % escrito; ya no parece un campo de texto |
| Elasticsearch "base" | ✅ 17 KB (tamaño real del índice; antes "59 GB", que era el disco) |
| Roles sin barra fija de "Nuevo rol" | ✅ el campo solo aparece al pulsar "Nuevo rol" |
| Usuarios: búsqueda | ✅ "lect" → solo "Lector Uno"; no toma el foco al abrir (foco en `BODY`) |
| Usuarios: "Eliminar" como texto | ✅ enlace de texto rojo → "¿Eliminar? Sí · No" → eliminado |
| Rol del administrador | ✅ el formulario muestra "Administrador" fijo, sin selector (el servidor ya lo rechazaba) |
| Logo desde administración con una nota abierta antes | ✅ vuelve a `/` sin nota abierta |
| Directorio: plegar | ✅ el botón está en la barra del directorio (flecha «); la cabecera ya no lo tiene |
| Directorio plegado | ✅ queda un riel de 36 px con la flecha » para desplegarlo |
| Miembro con solo "Notas → Leer" | ✅ sin Grafo, Nueva nota, Nuevo portafolio, Subir, Importar, Vincular ni Quitar vínculo; Editar y Dividir deshabilitados; título de solo lectura; casillas de tareas deshabilitadas; "Más acciones" → "Sin acciones para tu rol." |
| Atajos con ese rol (Ctrl+N, Ctrl+G, Ctrl+E) | ✅ no crean nota, no abren grafo ni editor |
| Dar "Ver grafo" y "Editar" en vivo | ✅ aparecen en ≤ 14 s sin recargar |
| Quitarlos en vivo estando en Editar | ✅ el editor se cierra solo, vuelve a Leer y el grafo desaparece |

## Ronda 3 — Compartir (privada, compartida, pública)

Imagen de producción en el stack aislado `grafito-e2e` con base vacía; al final
se recreó el stack normal con `docker compose up -d --build`: la migración
`0006_share.sql` se aplicó sobre los datos existentes sin perder nada (1
administrador, 2 usuarios).

Usuarios de prueba: administrador, Ana y Beto (Miembro; el rol incluye
`notes.share`).

| Caso | Esperado | Obtenido |
| --- | --- | --- |
| Admin: "Más acciones → Compartir…" en «Bienvenida» → Compartida con Ana | Se guarda y la nota muestra 👥 | ✅ el diálogo lista a Ana y Beto; icono «Compartida» visible |
| Admin: clic derecho en el portafolio «Atlas» → Compartir… → Pública | Genera un enlace `/p/<token>` | ✅ enlace de 32 caracteres con botón «Copiar» |
| Copia publicada | Solo lo compartido | ✅ «Bienvenida» + las 4 notas y el archivo de Atlas; nada más |
| Admin edita «Bienvenida» | Se publica sola | ✅ el texto nuevo aparece en la copia en ~2,5 s |
| Enlace público **sin sesión** (0 sesiones) | Índice de Atlas en solo lectura | ✅ 5 documentos, el archivo se ve, 0 campos editables, título «Atlas · Grafito»; no incluye «Bienvenida» |
| Enlace inventado | Aviso | ✅ «Este enlace no existe o dejó de ser público.» |
| `/compartidos` sin sesión | Pide entrar | ✅ muestra el ingreso y, tras entrar, la lista |
| Ana: Compartidos conmigo | Solo «Bienvenida» (Atlas es por enlace) | ✅ «Bienvenida · Nota · de Administrador» |
| Ana abre la nota | Versión actualizada, solo lectura | ✅ «Compartido por Administrador · Solo lectura»; sin Editar/Dividir/Eliminar |
| Beto abre la URL de la nota de Ana | Denegado por el servidor | ✅ «No existe o ya no está compartido contigo.»; su lista está vacía |
| Admin pasa Atlas a Privada | El enlace deja de funcionar y se borra la copia | ✅ 0 portafolios publicados; el enlace muestra el aviso |
| Admin borra «Bienvenida» (compartida) | Se deja de compartir | ✅ 0 elementos, 0 invitaciones, 0 documentos publicados |

`npm run typecheck`, `npm test`, `npm run lint` (0 errores, 5 avisos previos)
y `vite build` pasan; el bundle del navegador no contiene código de servidor
(`node:crypto`, SQL de compartir).

## Ronda 4 — Ajustes puntuales

| Caso | Resultado |
| --- | --- |
| Pantalla "Entrar" | ✅ el usuario empieza vacío (antes traía «admin») y con el foco; "Primera vez" mantiene `admin`/`admin` a propósito |
| Selector de rol (`ui/Select`) | ✅ flecha propia a 12 px del borde, texto con 40 px de margen derecho |
| Notas de ejemplo en una bóveda nueva | ✅ Atlas, Diario, Inicio, Personal y Taller cuelgan de «Documentación» |

Las bóvedas ya guardadas no cambian: el nuevo orden aplica a las bóvedas
nuevas o tras «Restaurar notas de ejemplo».

## Ronda 5 — Editor, panel de detalles, Documentación y primera vez

| Caso | Resultado |
| --- | --- |
| Clic en la línea bajo Editar / Dividir / Leer | ✅ antes el editor empezaba en ese mismo píxel y el clic ponía el cursor; ahora hay un margen no editable de 6 px (comprobado con `elementFromPoint` en la línea y hasta 6 px por debajo) |
| Línea vertical de Dividir | ✅ tampoco cae en el editor |
| Panel de detalles | ✅ secciones separadas por línea, con icono, título, contador y una frase que explica su contenido; «Escritos en la nota» pasa a «Enlaces en el texto»; «Vincular» es una acción en la cabecera; los enlaces a notas que no existen dicen «sin crear» |
| Bóveda guardada antes de «Documentación» (incluido el administrador) | ✅ al abrirla, Atlas, Diario, Inicio, Personal y Taller pasan dentro de «Documentación»; un portafolio propio en la raíz («Mi proyecto») no se toca; se aplica una sola vez |
| «Primera vez» | ✅ usuario y contraseña vacíos; con una contraseña de 8+ caracteres entra directo (346 ms) sin pedir cambiarla; con una corta o «admin» sigue pidiendo el cambio |

## Ronda 6 — Botones de icono sin fondo al pasar el ratón

Logo, grafo, cuenta, plegar/desplegar el directorio, nuevo portafolio, cerrar /
fijar / más acciones de la nota y los controles del grafo ya no muestran un
recuadro de fondo al pasar el ratón: el icono cambia de color (el logo y el
avatar se atenúan). El grafo abierto se marca solo con el color de acento. Las
filas de listas y menús conservan su fondo, porque indica qué fila se elige.
Comprobado en el navegador: ninguno de esos botones tiene `hover:bg-*`.

## Ronda 7 — Organizaciones y autenticación externa (LDAP, OAuth, SSO)

Stack aislado `grafito-e2e` con base vacía y el perfil `auth-test` (Keycloak 26
y OpenLDAP con los datos de `dev/auth-test/`). Al final se recreó el stack
normal: `0007_orgs_auth.sql` aplicada sobre los datos existentes (1 admin, 2
usuarios).

### Autenticación

| Caso | Resultado |
| --- | --- |
| Menú «Autenticación» con LDAP, OAuth y SSO | ✅ |
| LDAP: «Probar conexión» buscando a `carla` | ✅ «Encontrado: Carla Directorio (carla@empresa.test) · uid=carla,ou=people,dc=grafito,dc=test» |
| SSO: «Probar emisor» `http://keycloak:8080/realms/grafito` | ✅ emisor y URL de inicio de sesión leídos |
| Guardar: secretos | ✅ guardados en `auth_provider`; al reabrir el panel el campo llega vacío («guardado; vacío lo conserva») y la página no contiene el secreto |
| Ingreso | ✅ pestañas «Cuenta de Grafito / Directorio (LDAP)» y botón «Keycloak» |
| LDAP: `diego` (`otro.test`, dominio no permitido) | ✅ «Tu dominio de correo no tiene acceso.»; no se crea la cuenta |
| LDAP: contraseña incorrecta | ✅ «Usuario o contraseña incorrectos.» |
| LDAP: `carla` | ✅ entra; cuenta creada como Miembro, `source = ldap`, cuenta `ldap` vinculada |
| SSO: `sofia` en Keycloak (PKCE, retorno `/api/auth/oauth2/callback/sso`) | ✅ vuelve ya dentro; cuenta creada como Miembro, `source = sso` |
| SSO: `intruso@otro.test` | ✅ vuelve a `/login?error=unable_to_create_user` con «Tu cuenta no tiene acceso a Grafito (dominio no permitido).»; 0 cuentas `otro.test` |
| OAuth Google/GitHub/Microsoft | ⚠️ configuración y botones listos; no probado de punta a punta porque requiere credenciales reales de cada proveedor |

### Organizaciones

| Caso | Resultado |
| --- | --- |
| Usuarios y permisos → Organizaciones | ✅ tarjeta nueva junto a Usuarios y Roles |
| Crear «Empresa» y la sub-organización «Ventas»; Carla en Ventas | ✅ árbol con contadores; «1 miembros directos · 1 con sus sub-organizaciones» |
| Diálogo Compartir | ✅ sección «Organizaciones · incluye sus sub-organizaciones» con rutas («Empresa › Ventas») y luego Usuarios |
| Compartir «Bienvenida» solo con «Empresa» | ✅ `share_org_grant` = Empresa, 0 usuarios directos |
| Carla (miembro de Ventas, sub-organización de Empresa) | ✅ la ve en «Compartidos conmigo» y la abre en solo lectura |
| Sofía (sin organización) | ✅ lista vacía; la URL directa responde «No existe o ya no está compartido contigo.» |

### Observaciones

- **Lockfile:** `npm install ldapts` con el npm 11 local volvió a dejar el
  lockfile incompatible con el npm 10 de la imagen; se regeneró con el npm del
  contenedor (comando en ARCHITECTURE.md → Autenticación externa).
- **Salir no cierra la sesión del proveedor:** tras salir de Grafito, Keycloak
  conserva su sesión y el siguiente «Keycloak» entra sin pedir contraseña (es
  el comportamiento normal de SSO; el cierre global sería una mejora aparte).
- **Límite de peticiones:** Better Auth avisa de que no puede saber la IP del
  cliente y usa un único contador compartido por ruta. Detrás de un proxy
  inverso conviene configurar `advanced.ipAddress.ipAddressHeaders`.

## Ronda 8 — Bóveda en el servidor, API REST y asistente de IA

Stack aislado `grafito-e2e` con base vacía y el perfil `ai-test` (Ollama 0.6.8
con `qwen2.5:1.5b`). Al final se recreó el stack normal: `0008_vault_api_ai.sql`
aplicada sobre los datos existentes y `GRAFITO_ENCRYPTION_KEY` presente.

### Tests automáticos

`npm test`: 17 pruebas. Además de las 5 de antes, 8 de los adaptadores (con
cuerpos de ejemplo reales de cada API: herramientas, llamadas, resultados,
URL y cabeceras de OpenAI, Anthropic, Gemini y Ollama, y errores legibles) y 4
del cifrado (ida y vuelta, cifrados distintos, manipulación detectada, otra
clave, sin clave).

### Sincronización

| Caso | Resultado |
| --- | --- |
| Primer ingreso: la bóveda sube sola | ✅ 13 documentos y 6 portafolios en `vault_doc` / `vault_portfolio`, revisión 1 |
| Nota creada por la IA aparece en el navegador | ✅ sin recargar (sincronización tras la respuesta) |
| Nota creada y editada por la API aparece en el navegador | ✅ revisión del navegador = revisión del servidor (4) |
| Edición en el navegador llega al servidor | ✅ en ~1,5 s (revisión 5) |

### API REST (con token personal y `curl`)

| Caso | Resultado |
| --- | --- |
| Cuenta → API: crear token | ✅ `gft_…` de 47 caracteres, mostrado una sola vez; en la lista solo el prefijo |
| `GET /me`, `/portfolios`, `/notes?q=grafo` | ✅ |
| `POST /notes` en un portafolio y `PATCH` | ✅ |
| `GET /notes/:id/file` (SVG de ejemplo) | ✅ 200 `image/svg+xml` (antes 404: los data URL con `;charset=utf-8` no se decodificaban; corregido) |
| Token inválido / sin autenticación | ✅ 401 con mensaje |
| Cookie desde otro sitio | ✅ 403 |
| JSON roto | ✅ 400 |

### IA

| Caso | Resultado |
| --- | --- |
| Chat sin proveedores permitidos | ✅ «El administrador todavía no ha activado proveedores de IA.» |
| Admin → IA: los 8 proveedores; Ollama y LM Studio «Probar» | ✅ «Responde. 1 modelos: qwen2.5:1.5b» |
| Chat con proveedores permitidos pero sin conectar | ✅ «Todavía no has conectado…» con enlace a Cuenta |
| Cuenta → IA: clave falsa de ChatGPT | ✅ llamada real a OpenAI, «respondió 401. La clave no es válida…»; **no se guarda** |
| Conectar Ollama y LM Studio | ✅ |
| Chat con proveedor pero sin modelo | ✅ «Selecciona un modelo para empezar.» y caja deshabilitada |
| Ollama: «¿Qué portafolios tengo?» | ✅ usa `list_portfolios` y responde los 6 reales (15 s, CPU) |
| Ollama: crear «Resumen IA» | ✅ en conversación nueva: `create_note`, nota en el servidor (autor «Administrador (IA)») y en el directorio |
| LM Studio (adaptador OpenAI contra `ollama:11434/v1`): leer «Resumen IA» | ✅ usa `read_note` y cita el contenido real |
| Chip de herramienta | ✅ abre la nota |
| Ctrl+B / Esc | ✅ abre y cierra; dentro del editor Ctrl+B pone negrita y no abre el chat |
| Móvil 375×812 | ✅ panel a pantalla completa; botón encima de la barra inferior |
| Conversación tras recargar | ✅ se conserva en la pestaña |

### Hallazgos

- **Modelos muy pequeños:** `qwen2.5:1.5b`, con historial largo, una vez
  respondió «nota creada» sin llamar a la herramienta (no había nada en la
  base). En conversación nueva sí la usa. Para trabajo real conviene un modelo
  de 7B o más, o los de la nube.
- **Título en vez de id:** el modelo pasó el título a `read_note`; las
  herramientas de leer y editar ahora aceptan id o título exacto.
- **Claude, Gemini, Grok, DeepSeek y Kimi** no se probaron de punta a punta
  por falta de claves; su formato está cubierto por los tests y el error con
  clave inválida se probó contra OpenAI de verdad.

## Ronda 9 — Interruptores, panel de IA e instancias locales propias

| Caso | Resultado |
| --- | --- |
| Interruptores de Administración → IA | ✅ antes la bolita era `absolute` sin `left` y se salía de la pista; ahora `ui/Switch` (flex) en IA, Plugins, Fuentes y Autenticación; comprobado midiendo bolita y pista en las tres pantallas |
| Lista de proveedores | ✅ solo el nombre y el interruptor (sin empresa debajo ni «Guardado.»; solo aparece un aviso si falla) |
| Administrador y proveedores locales | ✅ ya no hay campo de dirección: solo activa o desactiva |
| Cuenta → IA, Ollama | ✅ «Conectar» pide la dirección de tu instancia (sugerida `http://host.docker.internal:11434`) y una clave opcional |
| `http://localhost:11434` | ✅ rechazada: «localhost sería el propio servidor de Grafito…» |
| `http://postgres:5432` | ✅ rechazada: «Esa dirección es un servicio interno de Grafito.» |
| `file:///etc/passwd` | ✅ rechazada |
| Equipo inexistente | ✅ «No se pudo conectar…»; no se guarda |
| `http://ollama:11434` (instancia del usuario) | ✅ «Conectado. 1 modelos disponibles.»; guardada en `ai_credential.base_url` de ese usuario |
| Chat con la instancia propia | ✅ solo aparece Ollama (lo conectado); usa `list_portfolios` y responde los 6 portafolios |
| `npm test` | ✅ 20 pruebas (3 nuevas de validación de direcciones) |
| Migración `0009` sobre tus datos | ✅ `ai_provider.base_url` eliminada, `ai_credential.base_url` creada |

## Ronda 10 — Temas en interruptores, ajustes por secciones

Imagen nueva (se borró `grafito-app` y se reconstruyó), probada en el stack
aislado `grafito-e2e` con base vacía; al terminar `down -v` y vuelta al stack
normal con tus datos.

| Caso | Resultado |
| --- | --- |
| Interruptor en tema Folleto, encendido | ✅ pista `accent` y bolita `accent-fg` (clara) |
| Interruptor en tema Folleto, apagado | ✅ pista `inset` (crema), borde `line` (negro) y bolita `muted` (gris oscuro): antes todo se veía negro |
| Administración → Plugins y resto de tarjetas | ✅ sin descripciones («Piezas que se pueden pausar», etc.) |
| Raíz | ✅ sin «Cuatro miradas, sin manual» |
| Administración: barra lateral | ✅ se pliega a un riel de iconos y se despliega (`chrome/SettingsNav`, recordado en `localStorage`) |
| Cuenta por secciones | ✅ Datos de la cuenta, Contraseña, Conexiones de IA y API, con la misma barra plegable que Administración |
| Cuenta sin permiso `ai.use` / `api.use` | ✅ esas secciones no aparecen |
| Cuenta en móvil (375 px) | ✅ tarjetas, «Atrás» y sin desplazamiento horizontal |
| `npm run typecheck`, `eslint`, `npm test` | ✅ sin errores; 20 pruebas |

## Ronda 11 — «Compartidos conmigo» dentro de la bóveda

Stack aislado `grafito-e2e` con base vacía: administrador y una usuaria de
prueba «Lectora» (rol Miembro). El administrador compartió con ella el
portafolio «Atlas» y la nota «Ritual de la mañana».

| Caso | Resultado |
| --- | --- |
| Directorio de Lectora | ✅ «Compartidos conmigo» aparece como segunda raíz, bajo sus propias notas (ya no es un enlace a otra página) |
| Desplegar «Atlas» | ✅ muestra sus notas y archivos (Bitácora de campo, Fuentes, Hipótesis de Atlas, Mapa del proyecto Atlas, Plano del obrador), con el propietario al lado |
| Abrir una nota compartida | ✅ se ve en el área principal, en solo lectura («Compartido por Administrador · Solo lectura») y marcada en el directorio |
| Abrir una nota propia, o pulsar Raíz | ✅ se cierra la vista compartida y vuelve el editor / la página de inicio |
| Nota compartida suelta | ✅ se abre con un clic |
| Móvil (375 px) | ✅ desde «Notas» abre la nota compartida en la pestaña «Nota», sin desplazamiento horizontal |
| Tamaño de Raíz | ✅ 40 px de alto (antes 56) con icono de 16 px; «Compartidos conmigo» igual |
| Plegado de «Compartidos conmigo» | ✅ se recuerda en el navegador (`grafito.shared-open`) |
| Al salir | ✅ se cierra la vista compartida (`leaveApp`) |
| `/compartidos` y `/compartidos/$id` | ✅ siguen funcionando para enlaces directos |

## Comandos útiles

```bash
docker compose build --no-cache app
docker compose up -d
docker compose ps
docker compose logs -f app
docker compose -p grafito-e2e up -d --build
docker compose -p grafito-e2e down -v
npm run typecheck
npm test
```
