# Project rules for coding agents

Read these files before any task:

1. **CHALLENGE.md**: the official Telnyx challenge requirements. Every requirement in it is mandatory.
2. **PLAN.md**: the design, data contracts and phases. Work one phase at a time.

## Requirements

- Requirements in CHALLENGE.md are mandatory. If a suggestion would skip or postpone one
  (for example: MCP server with at least 3 tools, KV, a Stateful Actor, observability), say so explicitly.
- When a requirement and a simpler shortcut conflict, follow the requirement.

## Security

- Never use, print, log or store API keys or tokens. Secrets come from environment variables
  (e.g. `TELNYX_API_KEY`) or Edge secrets (`telnyx-edge secrets add`).
- If I paste a secret into the chat, don't use it; remind me to rotate it.
- Never log full phone numbers or personal data; mask them.
