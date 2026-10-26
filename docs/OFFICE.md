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
| `COLLABORA_URL` | Collabora's address as the **browser** sees it. Set it to empty to turn the editor off. | `http://127.0.0.1:9980` |
| `COLLABORA_INTERNAL_URL` | Collabora's address as the **Grafito server** sees it | `http://collabora:9980` |
| `GRAFITO_WOPI_URL` | Grafito's address as **Collabora** sees it | `http://app:8080` |
| `GRAFITO_PUBLIC_ORIGIN` | The address people open Grafito with, which is allowed to embed the editor. One value, no spaces. `127.0.0.1` is always allowed. | `localhost:*` (so both `localhost` and `127.0.0.1` work) |
| `COLLABORA_ADMIN_PASSWORD` | Password for Collabora's own admin console | a placeholder; change it |

When Grafito is used from other machines, set `COLLABORA_URL` and
`GRAFITO_PUBLIC_ORIGIN` to addresses those machines can reach. Ideally put both
behind the same HTTPS reverse proxy.

## How it works

1. **Opening:** the browser asks Grafito for an editor session.
   - Grafito checks the permission: the user's own file, or a file shared with
     them.
   - It signs a short-lived token (10 hours) and returns Collabora's URL.
   - The editor opens in an iframe through a POST form, so the token never
     appears in the URL.
2. **Reading and saving:** Collabora reads and saves the file through Grafito's
   WOPI endpoints (`/wopi/files/:id`).
   - Every save is a new object in storage and a new version in the file's
     history (**Historial**).
   - Consecutive saves by the same person within 10 minutes are grouped. The
     original upload is always kept.
   - Any version can be restored.
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

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No "Open in the editor" button | `COLLABORA_URL` isn't empty for the `app` service, and the file has an Office extension |
| "The Office editor responded 404/502" | `docker compose logs collabora`; Collabora needs about 20 s to start |
| The editor shows "127.0.0.1 refused to connect" or stays blank | Collabora refuses to be embedded from that address. Set `GRAFITO_PUBLIC_ORIGIN` to the address in the browser's address bar (for example `http://192.168.1.20:8080`) and run `docker compose up -d collabora`. |
| The document opens but changes aren't saved | `GRAFITO_WOPI_URL` must be reachable from the Collabora container and match `aliasgroup1` |
| Messages about `CLONE_NEWUSER` / `coolmount` in the logs | Harmless: without extra container privileges Collabora copies its files instead of mounting them (`mount_jail_tree=false`) |
