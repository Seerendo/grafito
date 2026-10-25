## Administración

La primera vez que se abre Grafito pide crear el administrador: eliges el usuario y la contraseña. Si la contraseña tiene menos de 8 caracteres (por ejemplo `admin`), el primer ingreso obliga a cambiarla antes de ver notas, portafolios o archivos. La instalación queda registrada en la base (`app_admin`): si ya hay un administrador elegido, el arranque muestra el ingreso.

Una vez dentro, la burbuja con las iniciales abre la cuenta, la administración y Salir. El nombre del administrador empieza como Administrador. En administración están permisos, fuentes, plugins, el plazo de la sesión y el espacio usado. Cambiar el plazo cierra las sesiones abiertas. Buscar, dentro de administración, abre la nota elegida. El rol administrador no se recorta. Editor y lector quedan preparados, sin poder entrar a esa ventana. Cada nota guarda quién la creó y quién la editó; las de documentación quedan a nombre del administrador.

Las variables de servidor están en `.env.example`. El arranque es `docker compose up -d --build` (la app corre como build de producción): Postgres, Elasticsearch, Redis, MinIO (`cgr.dev/chainguard/minio`) y la propia app en el puerto 8080. `npm run dev` no levanta Grafito. Sin Redis el plazo de sesión sigue en Postgres. La primera consulta a Postgres aplica las migraciones; si faltan, el ingreso no puede saber si ya hay administrador.

La estructura del código está descrita en [ARCHITECTURE.md](ARCHITECTURE.md).

## Organizaciones y autenticación externa

En Administración → Usuarios y permisos → Organizaciones se crean organizaciones
y sub-organizaciones con sus miembros; compartir con una organización llega
también a sus sub-organizaciones. En Administración → Autenticación se activan
LDAP / Active Directory, OAuth (Google, GitHub, Microsoft) y SSO por OpenID
Connect (Keycloak, Authentik, Okta…). Para probarlos en local:
`docker compose --profile auth-test up -d` (Keycloak y OpenLDAP de prueba).

## Asistente de IA y API

En la bóveda, el botón flotante o **Ctrl+B** abre el chat de IA, que puede leer
tus portafolios, notas y archivos y crear o editar notas. El administrador elige
en Administración → IA qué proveedores se permiten (ChatGPT, Claude, Grok,
Gemini, DeepSeek, Kimi, Ollama, LM Studio); cada persona conecta el suyo con su
propia clave en Cuenta → IA, que se guarda cifrada con `GRAFITO_ENCRYPTION_KEY`.
La bóveda vive en el servidor y tiene una API REST en `/api/v1` (tokens
personales en Cuenta → API). Detalles en ARCHITECTURE.md.
