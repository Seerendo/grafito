# Email (SMTP)

Grafito can send email through any SMTP server: your company's, a provider
such as Gmail, Microsoft 365, Amazon SES or Mailgun, or one inside your
network. Email is optional. Without it, everything else keeps working, also
offline.

It is used for four things:

- **New users' access.** The account is created without a password typed by
  the administrator. Grafito emails a one-time temporary password.
- **Change notifications.** When a shared document changes, the people with
  access to it get an email.
- **A share.** When a note, file or portfolio is shared with a user or an
  organization for the first time, those people get one email with a link
  to open it. Updating an expiry does not send another. A public link sends
  none.
- **A form.** Sending a table's form to users or organizations emails them
  a link to fill it in (`/formularios/…`). The public form link (`/f/…`)
  has no recipients, so it sends none.

Share and form mail is best-effort. If SMTP is off, or a person has no
address, the share or the invitation is still saved and the screen says the
notice was not sent. These mails do not look at the change-notification
switch: the person was just invited.

## Setting it up

**Administración → Correo electrónico** (permission `mail.manage`):

| Field | What to put |
| --- | --- |
| Servidor | The SMTP host, e.g. `smtp.example.com`. Empty turns email off. |
| Seguridad | **STARTTLS** (usually port 587), **SSL/TLS** (usually 465) or **Ninguna** (no encryption; only for a server inside your network). |
| Puerto | The SMTP port. |
| Usuario / Contraseña | The SMTP account, if the server asks for one. The password is stored encrypted with `GRAFITO_ENCRYPTION_KEY`. Leave it empty to keep the saved one. |
| Correo del remitente / Nombre | Who the emails come from. |
| Dirección de Grafito | The address people use to open Grafito. It goes in the links of the emails, e.g. `https://notes.example.com`. |
| Validez del acceso de un usuario nuevo | Hours the temporary password and its link last (24 by default, up to 720). |

**Probar** sends a test email with what is in the form, before saving it.

Dates in the emails show their time zone. In Docker the server is in UTC
unless you set `TZ` for the `app` service, for example `TZ: America/Lima`.

## New users

1. In **Usuarios → Nuevo usuario**, the administrator enters the name, the
   username, the **email** (required) and the role. There is no password
   field.
2. Grafito generates a random temporary password: 16 characters from a
   56-character alphabet without look-alike characters (about 93 bits).
3. The person gets an email with their username and a **private note** link,
   valid for the hours set above.
4. The note opens **once**. Opening it destroys it: if the page is reloaded or
   closed, the password can't be seen again. The person isn't kicked out of the
   page while reading it.
5. The temporary password works for **a single sign-in**. When signing in,
   Grafito asks for a new password before anything else.

If the email didn't arrive (wrong address, spam, expired), open the user and
click **Reenviar acceso**. This sends a new password and a new link. The
previous password, link and sessions stop working.

The Users list shows each person's access state: sent (with its expiry), used
but password not changed yet, or expired.

**Without email.** If email isn't set up, or sending fails, Grafito shows the
administrator the one-time link once, to hand over another way (chat, in
person…). It opens only once and expires the same way.

### How the password is protected

- **Hashes only.** Grafito stores the temporary password only as a hash (the
  same as any password, in Better Auth's `account` table). Its plain text only
  exists inside the note.
- **The note is encrypted with the link.** The note is encrypted (AES-256-GCM)
  with a key derived from a random 256-bit token. The token goes in the link
  after `#`, a part of the URL browsers don't send to the server, so it doesn't
  end up in server or proxy logs. The page removes it from the address bar as
  soon as it reads it.
- **Nothing readable is stored.** The note is stored by a hash of the token,
  in Redis with an expiry (or in the `app_secret_note` table without Redis).
  Neither the database, Redis nor a backup can read it without the link.
- **Read once.** Reading it deletes it in the same step (`GETDEL` in Redis,
  `delete … returning` in Postgres), so it can't be read twice.
- **Single use and expiry.** These are enforced when the session is created
  (`databaseHooks.session.create.before` in `lib/auth/server.ts`). An expired
  password is refused (`TEMP_ACCESS_EXPIRED`), and so is a second sign-in with
  it (`TEMP_ACCESS_USED`). Each case shows a clear message on the sign-in
  screen.
- **Leaving the temporary state.** It ends only when the account's password
  hash is no longer the temporary one, that is, after a real password change.

If Redis restarts, notes not opened yet are lost. The administrator then uses
**Reenviar acceso**.

## Change notifications

- **When.** A document changes: a note's text or title, or an Office file saved
  from the editor, whether by its owner, by someone it was shared with, through
  the API or by the AI.
- **Who gets it.** Everyone with access to that document:
  - its owner;
  - the people and organizations (with their sub-organizations) it was shared
    with, directly or through a portfolio that contains it.

  The person who made the change doesn't get it. **A private document notifies
  nobody.** Public links don't count.
- **Grouping.** So that autosave doesn't send an email per keystroke, each
  change waits in `mail_notice`. Once all of someone's pending documents have
  gone 5 minutes without changes, they get **one email** listing the documents
  and who changed them.
- **Opting out.** Each person chooses in **Cuenta → Correo**: their address,
  and a switch to turn change notifications off. Without an address, they get
  none.

## Trying it locally

Run a fake mail server that keeps every message, such as Mailpit, next to
Grafito:

```bash
docker run -d --name mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit:v1.20.4
```

In **Administración → Correo electrónico**, set server `host.docker.internal`,
port `1025` and security **Ninguna**. Messages appear at
http://127.0.0.1:8025.

## Troubleshooting

| Message | Check |
| --- | --- |
| «No se pudo conectar con el servidor de correo» | Server name, port and security. From Docker, `localhost` is the container: use the server's name or IP. |
| «El servidor de correo rechazó el usuario o la contraseña» | The SMTP account. Gmail and Microsoft 365 need an app password. |
| «Falló la conexión segura (TLS)» | The port and the security don't match: 587 is STARTTLS, 465 is SSL/TLS. |
| The link in the email opens the wrong address | **Dirección de Grafito** in the email settings. |
| «Tu contraseña temporal venció» / «ya se usó» | Use **Reenviar acceso** on that user. |
