# spare-email-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
[spare.email](https://spare.email) mailboxes (works with any
[cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) deployment).

It lets MCP-aware agents (Claude, Cursor, Codex, ...) look inside a mailbox you
already created: list the inbox, read a parsed mail, and wait for a
verification code. It is deliberately **read-only**: it cannot create
mailboxes, delete mail, or send anything, and it holds no credentials of its
own — it uses the same Address JWT you can copy from the web UI.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `mailbox_info` | Returns the mailbox address the server is authenticated as. Use first to verify the JWT works. |
| `list_mails` | List recent mails, newest first (`limit` 1-100, `offset`). |
| `read_mail` | Read one mail in full by id: from/to/subject/date, plain-text body, attachment metadata. |
| `wait_for_otp` | Poll until a **new** mail arrives after the call starts, then extract the most likely verification code. Supports `timeout_seconds` (10-600), `poll_seconds` (3-30), and `subject_contains` filtering. |

Code extraction runs locally in the server using the multilingual rule-based
extractor ported verbatim from the upstream worker (`extract_code.ts`, MIT) —
keyword-anchored patterns in about a dozen languages, with guards against
dates, amounts, phone numbers, and URLs. No AI model and no extra API calls.

No mail arrives within the timeout? `wait_for_otp` returns a structured
"nothing arrived" result instead of hanging or guessing.

## Configuration

The server is configured entirely through environment variables:

| Variable | Required | Meaning |
| -------- | -------- | ------- |
| `SPARE_EMAIL_JWT` | yes | Address JWT, copied from the spare.email web UI (settings). |
| `SPARE_EMAIL_BASE_URL` | no | API base URL. Defaults to `https://spare.email`; point it at your own deployment if self-hosting. |
| `SPARE_EMAIL_SITE_PASSWORD` | no | Only if the deployment enabled the site-wide access password (`x-custom-auth`). |
| `SPARE_EMAIL_LANG` | no | Error-message language, `en` (default) or `zh`. |

Every tool reports an actionable error on failure — for example, an expired
JWT returns a hint to copy a fresh one from the web UI.

## Usage

### Claude Code

```bash
claude mcp add spare-email -e SPARE_EMAIL_JWT=eyJ... -- node /path/to/spare-email-mcp/dist/index.js
```

### Claude Desktop / Cursor / generic `mcpServers` block

```json
{
  "mcpServers": {
    "spare-email": {
      "command": "node",
      "args": ["/path/to/spare-email-mcp/dist/index.js"],
      "env": {
        "SPARE_EMAIL_JWT": "eyJ...",
        "SPARE_EMAIL_BASE_URL": "https://spare.email"
      }
    }
  }
}
```

### Security notes

- The JWT grants full **read** access to that one mailbox only. Treat it like
  a password in your MCP config; rotate it by opening a fresh mailbox (or
  changing its password) in the web UI.
- The mailbox lifetime rules of the deployment apply: on spare.email a default
  mailbox auto-expires, so point long-lived agent workflows at a mailbox with
  the retention you want and keep a copy of its JWT.
- The server is stateless and never writes: no mailbox creation, no send, no
  deletes. Rate limits are honored (429 responses back off a poll cycle).

## Typical agent workflow

1. Human creates a mailbox in the web UI and copies the Address JWT into the
   MCP server config.
2. Agent signs up somewhere using that mailbox address.
3. Agent calls `wait_for_otp` (optionally filtering by subject) and gets the
   verification code without any human copy-pasting.

## Underlying REST API

The tools are a thin layer over the deployment's read-only parsed-mail
endpoints (`GET /api/settings`, `GET /api/parsed_mails`, `GET
/api/parsed_mail/:id`). Build your own client with plain HTTP if you prefer —
usage notes, response shapes and the polling pattern are documented at
<https://spare.email/temp-email-mcp>.

## Development

```bash
npm install
npm run build    # tsc -> dist/
SPARE_EMAIL_JWT=... SPARE_EMAIL_BASE_URL=... npm run smoke
```

## Provenance

Developed as part of the spare.email stack (https://spare.email); this
repository is the canonical home of the published package.
