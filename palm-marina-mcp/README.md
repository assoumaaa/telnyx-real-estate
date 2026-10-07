# palm-marina-mcp

The MCP server for the Palm & Marina Realty assistant: a TypeScript Telnyx Edge Function with a Stateful Actor,
KV and a Cloud Storage bucket bound on `env`. See the [root README](../README.md) for the full architecture.

## Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | Bearer `MCP_TOKEN` | MCP JSON-RPC: `initialize`, notifications, `ping`, `tools/list`, `tools/call` |
| `GET /health`, `/health/liveness`, `/health/readiness` | none | health checks |

## Files

| File | Job |
| --- | --- |
| `telnyx.toml` | Manifest: the `CALENDAR` actor, `KV` namespace, `FILES` bucket and the `MCP_TOKEN` and `TELNYX_API_KEY` secrets |
| `src/index.ts` | Routing, the token check and one JSON log line per request |
| `src/auth.ts` | Bearer token check; logs why it failed, never the token |
| `src/mcp.ts` | The MCP protocol |
| `src/tools/` | One file per tool group: `search.ts`, `viewings.ts`, `leads.ts`, `valuation.ts`; `index.ts` lists them and reads the listings only for the tools that use them |
| `src/listings.ts` | Listing type, KV cache over the bucket, filtering and the spoken summary |
| `src/calendar.ts` | `ViewingCalendar` actor: slots and bookings for one agent |
| `data/listings.json` | Master copy of the listings, uploaded to the bucket as `listings.json` |

## Develop and deploy

```sh
npm install
npm test            # vitest; fakes for KV, the bucket and the actor
npm run typecheck
npm run format
telnyx-edge ship
```
