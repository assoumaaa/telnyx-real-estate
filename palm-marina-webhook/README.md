# palm-marina-webhook

The dynamic variables webhook for both Palm & Marina assistants: a TypeScript Telnyx Edge Function. Telnyx calls it at
the start of every call, and it answers with who is calling and what they did last time. See the
[root README](../README.md) for the full architecture.

It reads one KV key per call, `caller/<number>`: a session summary `palm-marina-mcp` saves after a booking, cancel or
seller lead. The webhook turns those facts into variables, so a viewing that has passed is never called upcoming.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /` | `assistant.initialization` event in, `{ dynamic_variables }` out |
| `GET /health`, `/health/liveness`, `/health/readiness` | health checks |

## Files

| File | Job |
| --- | --- |
| `telnyx.toml` | Manifest: the `KV` namespace shared with palm-marina-mcp |
| `src/index.ts` | Routing: the dynamic variables webhook and the health checks |
| `src/dynamic-variables.ts` | The webhook: reads the event, one KV read for the caller, safe new-caller defaults, one JSON log line per request |
| `src/env.ts` | The KV binding |

## Develop and deploy

```sh
npm install
npm test            # vitest; a fake KV
npm run typecheck
npm run format
telnyx-edge ship
```
