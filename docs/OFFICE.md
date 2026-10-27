# Office documents (Collabora Online)

Grafito can open Word, Excel, PowerPoint and OpenDocument files (`.docx`,
`.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`, plus `.doc`, `.xls`, `.ppt`, `.rtf`,
`.csv`) in an editor inside the vault. The editor is
[Collabora Online](https://www.collaboraonline.com/), which is based on
LibreOffice.

It is **on by default**: `docker compose up -d` starts the `collabora`
service next to Grafito. It can be turned off; Grafito then works exactly the
same, and Office files can still be uploaded and downloaded.

## Turn it off

In `.env`:

```dotenv
COLLABORA_URL=
```

Then start the stack without the Collabora container:

```bash
docker compose up -d --scale collabora=0
```

Set `COLLABORA_ADMIN_PASSWORD` in `.env` to your own value either way.

| Variable | What it is | Default |
| --- | --- | --- |
| `COLLABORA_URL` | Collabora's address as the **browser** sees it. `same-origin`: on Grafito's own address, through the gateway. Set it to empty to turn the editor off. | `same-origin` |
| `COLLABORA_INTERNAL_URL` | Collabora's address as the **Grafito server** sees it | `http://collabora:9980` |
| `GRAFITO_WOPI_URL` | Grafito's address as **Collabora** sees it | `http://app:8080` |
| `GRAFITO_PUBLIC_ORIGIN`, `COLLABORA_SSL_TERMINATION` | Only for a `COLLABORA_URL` on an address of its own (see [Servers and HTTPS](#servers-and-https)) | `localhost:*`, `false` |
| `COLLABORA_ADMIN_PASSWORD` | Password for Collabora's own admin console | a placeholder; change it |

From other machines, directly or behind an HTTPS proxy, the editor needs no
settings: see [Servers and HTTPS](#servers-and-https).

## How it works

1. **Opening:** selecting an Office file opens the editor right away. If it
   is closed from the editor itself, a button reopens it. The browser asks
   Grafito for an editor session.
   - Grafito checks the permission: the user's own file, or a file shared with
     them.
   - It signs a short-lived token (10 hours) and returns Collabora's URL.
   - The editor opens in an iframe through a POST form, so the token never
     appears in the URL.
2. **Reading and saving:** Collabora reads and saves the file through Grafito's
   WOPI endpoints (`/wopi/files/:id`).
   - Every save is a new object in storage and a new version in the file's
     history (**Historial**).
   - Each time the person saves (the save button or Ctrl+S) a version of its
     own is kept. Only Collabora's automatic saves by the same person within
     10 minutes are grouped (`X-COOL-WOPI-IsAutosave`). The original upload is
     always kept.
   - Any version can be restored. After a restore, the open editor reloads
     with the restored content.
   - A save from an editor opened before the file changed (for example, before
     a restore) isn't written over it. Grafito answers with a conflict
     (`X-COOL-WOPI-Timestamp`), and Collabora asks whether to reload the
     document or overwrite it.
3. **Permissions:**
   - Without the `notes.edit` permission, or on a read-only share, the
     document opens read-only.
   - When someone edits through a share, the share is checked again on every
     save, so revoking it takes effect immediately.
4. **Track changes:** Collabora's own track-changes feature (Review → Track
   Changes) is saved inside the document, as in Word or LibreOffice.

## Offline

Everything runs on your own machine or network:

- **No internet needed:** Collabora is a local container. Once the image has
  been downloaded, nothing reaches the internet. Spanish and English
  dictionaries are included (`dictionaries: es_ES en_US`).
- **Browser connection:** the browser must reach the Grafito server and the
  Collabora container (for example, on the same LAN).
- **Without that connection:** notes keep working from the browser's local
  copy and sync later, but Office documents can't be edited in the browser.
  Download the file, edit it locally (for example with LibreOffice), then
  upload it again.

## Licensing and business use

*This is practical guidance, not legal advice. For a commercial launch, have a
lawyer review it.*

**Collabora Online:**

- **A separate program:** Collabora runs as its own service, and Grafito talks
  to it only over HTTP (the WOPI protocol).
  - Grafito doesn't include, link to or redistribute Collabora's code.
  - `docker-compose.yml` only references the official image, which each
    installation downloads itself.
  - So Collabora's license (MPL 2.0 for the source code) and Grafito's
    (AGPL-3.0) don't mix.
- **The CODE image** used here (`collabora/code`) is the free *Development
  Edition*, intended for home use, testing and small setups. It comes with no
  support.
  - The compose file enables `home_mode`, which suits personal use and limits
    concurrent connections and documents.
  - Check Collabora's current terms before using it at scale.
- **For a paid or hosted (cloud) offering,** pick one of these:
  - Buy a Collabora Online subscription (supported, no CODE limits).
  - Or build Collabora from its MPL source yourself.
  - Either way, don't use the "Collabora" or "LibreOffice" names or logos to
    brand your own product. They are trademarks.
- **Swappable:** nothing in Grafito depends on Collabora specifically. It is
  turned on and off with environment variables, and the WOPI side is standard.
  Another WOPI editor, or none, can take its place.
- **On by default** only means the compose file starts the image. If a future
  paid or cloud version mustn't ship with CODE, turn it off
  (`COLLABORA_URL=`) or point it at a licensed Collabora server. No code
  changes are needed.

**Grafito itself (AGPL-3.0):**

- **Paid options are allowed:** as the copyright holder you can sell paid
  options or run a paid hosted service. The AGPL allows charging.
- **Source obligation:** if you run a modified Grafito as a network service,
  its users must be able to get the source of that modified version.
- **Closed paid features:** keeping some paid features closed requires owning
  the copyright of all the code, so you can license it under other terms too.
  Before accepting outside contributions, ask contributors to sign a CLA (or a
  similar agreement that lets you relicense). Otherwise, keep paid features in
  separate services that don't modify Grafito.

## Servers and HTTPS

The browser loads the editor in an iframe and talks to it over a WebSocket.
With Docker Compose, the `gateway` service (nginx, `docker/gateway.conf`)
serves it on Grafito's own address and port (`COLLABORA_URL=same-origin`, the
default):

| Path | Goes to |
| --- | --- |
| `/browser/`, `/hosting/`, `/cool/` (including the WebSocket) | Collabora |
| `/browser/dist/admin/`, `/cool/adminws` | refused (Collabora's admin console) |
| everything else | Grafito |

So the editor works however Grafito is opened:

- **Directly:** `http://192.168.1.20:8080`. The editor connects with `ws://`.
- **Behind any HTTPS reverse proxy** (nginx, Caddy, Traefik…) pointed at port
  `8080`: the editor connects with `wss://`. The proxy only has to pass
  WebSocket upgrades. See the README's
  [On a server or a network](../README.md#on-a-server-or-a-network).

How the gateway does it:

- **The page's address:** the editor is opened by a POST from Grafito's page,
  so its `Origin` header gives the address the browser is on, behind any
  number of proxies. Without it, `X-Forwarded-Proto` and `X-Forwarded-Host`,
  or the request itself.
- **WebSocket address:** Collabora writes it into its page (`data-host`). The
  gateway sends Collabora a fixed host name and swaps that address for the
  page's own, `ws://` or `wss://`.
- **Embedding:** in Collabora's `Content-Security-Policy`, `frame-ancestors`
  becomes `'self'` and `connect-src` gets the page's WebSocket address. The
  editor is on Grafito's address, so no list of allowed addresses is needed.

Port `9980` only listens on the server itself (`127.0.0.1`).

**Collabora on an address of its own** (without the gateway, or without
Docker): set `COLLABORA_URL` to that address. Then:

- `GRAFITO_PUBLIC_ORIGIN` is the address Grafito is opened with, which may
  embed the editor.
- For a page on `https://`, the editor must be on `https://` too. Set
  `COLLABORA_SSL_TERMINATION=true` when a proxy provides that HTTPS, and let
  the proxy pass WebSocket upgrades for `/cool/`.
- If `COLLABORA_URL` is `127.0.0.1` or `localhost`, Grafito uses the host the
  browser used for Grafito, on that port.
- Before opening a document, Grafito checks these settings against the page's
  address (`server/office-reach.ts`). If one doesn't match, it says which
  variable to set instead of showing a blank editor.

**Browsers:** any current Chrome, Edge, Firefox or Safari. The editor needs
WebSockets and frames; extensions or company policies that block either one
leave it blank.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Text in the document is hard to read with a dark theme | Fixed in Grafito: without an explicit preference, Collabora follows the system's dark mode and left dark text on a dark page. Grafito now asks for the light theme (`ui_defaults=UITheme=light;SavedUIState=false` on the editor URL), so the editor is shown like a printed page with every Grafito theme and design. `SavedUIState=false` makes this win over a dark mode the browser remembered from an earlier session. |
| The editor doesn't open when selecting the file | `COLLABORA_URL` isn't empty for the `app` service, and the file has an Office extension |
| "The Office editor responded 404/502" | `docker compose logs collabora`; Collabora needs about 20 s to start |
| The editor shows "127.0.0.1 refused to connect" or stays blank | An old `COLLABORA_URL` in `.env` (for example `http://127.0.0.1:9980`). Remove it and run `docker compose up -d`. |
| "An insecure WebSocket connection may not be initialized from a page loaded over HTTPS" | The editor is on its own `http://` address. Remove `COLLABORA_URL` from `.env` so the gateway serves it, and run `docker compose up -d` |
| The editor loads but says it can't connect | The reverse proxy doesn't pass WebSocket upgrades. Add the `Upgrade` and `Connection` headers (README, [On a server or a network](../README.md#on-a-server-or-a-network)) |
| Blank editor on another computer or browser | Open Grafito's address + `/hosting/discovery` from that computer; it should list Collabora's actions. Also check browser extensions that block frames |
| The document opens but changes aren't saved | `GRAFITO_WOPI_URL` must be reachable from the Collabora container and match `aliasgroup1` |
| Messages about `CLONE_NEWUSER` / `coolmount` in the logs | Harmless: without extra container privileges Collabora copies its files instead of mounting them (`mount_jail_tree=false`) |
