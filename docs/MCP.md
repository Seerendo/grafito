# Connecting assistants over MCP

Grafito is an MCP server: an assistant you already use reads and works on your
vault, your mail and your calendar with your own permissions. This page shows
how to add it to each client. What the tools do is in the README
([MCP server](../README.md#mcp-server)) and, for mail, in
[MAILBOX.md](MAILBOX.md#security).

## What every client needs

| Item      | Value                                                                 |
| --------- | --------------------------------------------------------------------- |
| Transport | Streamable HTTP (remote server)                                       |
| Address   | `https://your-grafito/api/mcp` (shown in **Cuenta → API**)            |
| Header    | `Authorization: Bearer gft_…`                                         |
| Token     | a personal token from **Cuenta → API** (the role needs **API y MCP**) |

- Use one token per client, so you can revoke one without touching the others
  (**Cuenta → API → Revocar**).
- Keep the token out of files you share or commit: most clients read it from
  an environment variable, as the examples below do with `GRAFITO_TOKEN`.
- Mail and calendar tools only see accounts where you turned on **Permitir
  acceso por MCP** (Cuenta → Cuentas de correo). Mail text reaches the
  assistant marked as untrusted content; no tool sends mail (drafts are kept
  for you to send).
- Clients that connect from the provider's cloud (Claude's custom connectors)
  need Grafito on a public HTTPS address on port 443. Clients that run on your
  computer (CLIs, IDEs) reach any address your computer reaches, including
  `http://127.0.0.1:8080` or the LAN address.

Set the token once in your shell (PowerShell, then bash/zsh):

```powershell
setx GRAFITO_TOKEN "gft_..."
```

```bash
export GRAFITO_TOKEN="gft_..."   # add it to ~/.bashrc or ~/.zshrc
```

## Claude Code (CLI)

```bash
claude mcp add --transport http grafito https://your-grafito/api/mcp \
  --header "Authorization: Bearer $GRAFITO_TOKEN"
```

- `--scope user` makes it available in every project; the default (`local`)
  is this project only; `--scope project` writes `.mcp.json` to share with the
  team (put `${GRAFITO_TOKEN}` there, never the token itself):

  ```json
  {
    "mcpServers": {
      "grafito": {
        "type": "http",
        "url": "https://your-grafito/api/mcp",
        "headers": { "Authorization": "Bearer ${GRAFITO_TOKEN}" }
      }
    }
  }
  ```

- `claude mcp list` shows it; inside a session, `/mcp` shows its state and
  tools.

## Claude Code in the Claude desktop app (Code tab)

The Code tab runs Claude Code and reads the same configuration: a server added
with `claude mcp add` (user scope, `~/.claude.json`) or a project's `.mcp.json`
shows up there too. Open a new session after adding it.

## Claude (desktop and web chat): custom connector

1. **Customize → Connectors → Add custom connector** (on Team and Enterprise,
   an owner adds it in **Organization settings → Connectors**).
2. Name: `Grafito`; URL: `https://your-grafito/api/mcp`.
3. Authentication: **No sign in**, and under **Request headers** add
   `Authorization` with `Bearer gft_…`.

Claude reaches the connector from Anthropic's cloud, so Grafito must be on a
public HTTPS address on port 443; a LAN or `localhost` address does not work
here (use Claude Code, which runs on your computer, for those).

## Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project). Gemini CLI
uses `httpUrl` for Streamable HTTP (`url` is its SSE transport):

```json
{
  "mcpServers": {
    "grafito": {
      "httpUrl": "https://your-grafito/api/mcp",
      "headers": { "Authorization": "Bearer $GRAFITO_TOKEN" }
    }
  }
}
```

Or from the command line:

```bash
gemini mcp add --transport http --header "Authorization: Bearer $GRAFITO_TOKEN" \
  grafito https://your-grafito/api/mcp
```

`/mcp` inside Gemini CLI lists the server and its tools.

## Gemini app (desktop or web)

The Gemini app does not offer adding your own MCP servers; use Gemini CLI or
Antigravity, which do.

## Google Antigravity

Global: `~/.gemini/config/mcp_config.json`; per workspace:
`<workspace>/.agents/mcp_config.json` (or the MCP manager: **… → MCP Servers →
Manage → View raw config**). Antigravity uses `serverUrl` (`httpUrl` is not
accepted):

```json
{
  "mcpServers": {
    "grafito": {
      "serverUrl": "https://your-grafito/api/mcp",
      "headers": { "Authorization": "Bearer gft_..." }
    }
  }
}
```

## OpenAI Codex CLI

`~/.codex/config.toml` (a trusted project may add `.codex/config.toml`). Codex
takes the bearer token from the environment variable you name:

```toml
[mcp_servers.grafito]
url = "https://your-grafito/api/mcp"
bearer_token_env_var = "GRAFITO_TOKEN"
```

`codex mcp list` shows it.

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "grafito": {
      "url": "https://your-grafito/api/mcp",
      "headers": { "Authorization": "Bearer ${env:GRAFITO_TOKEN}" }
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

`.mcp.json` at the workspace root, or `~/.copilot/mcp-config.json` for every
workspace (**Chat: Open Customizations → MCP Servers → Add Server → HTTP**
writes it for you):

```json
{
  "mcpServers": {
    "grafito": {
      "type": "http",
      "url": "https://your-grafito/api/mcp",
      "headers": { "Authorization": "Bearer ${GRAFITO_TOKEN}" }
    }
  }
}
```

Older VS Code versions use `.vscode/mcp.json` with a top-level `"servers"` key
and the same `type`, `url` and `headers`.

## Windsurf and Devin

Windsurf's Cascade documentation now lives with Devin's. Its MCP file
(`~/.config/devin/mcp_config.json`, `%APPDATA%\devin\mcp_config.json` on
Windows, or `.devin/mcp_config.json` in a project) takes `url` and `headers`:

```json
{
  "mcpServers": {
    "grafito": {
      "url": "https://your-grafito/api/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer gft_..." }
    }
  }
}
```

Older Windsurf builds read `~/.codeium/windsurf/mcp_config.json`; if the server
does not show, put the same entry there.

## Clients that only start local (stdio) servers

A bridge such as `mcp-remote` turns the remote server into a local one:

```json
{
  "mcpServers": {
    "grafito": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-grafito/api/mcp",
        "--header",
        "Authorization: Bearer ${GRAFITO_TOKEN}"
      ],
      "env": { "GRAFITO_TOKEN": "gft_..." }
    }
  }
}
```

## Checking the connection

- Ask the assistant to run `whoami`: it answers with your name and role.
- `401`: the token is missing, mistyped or revoked; `403`: the role lacks
  **API y MCP**.
- No mail tools, or none of your accounts: turn on **Permitir acceso por MCP**
  on the account, and make sure the **Correo electrónico** extension is on.
- A client that cannot reach the address: a cloud client (Claude connectors)
  needs public HTTPS on 443; a local client needs the address your computer
  uses to open Grafito.
