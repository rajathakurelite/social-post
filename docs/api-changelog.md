# API changelog

## Wave-3

- **Structured error envelope** — errors return `{ error, code, requestId }` instead of ad-hoc `{ error }` only.
- **Request tracing** — every response includes `x-request-id` and `x-api-version`.
- **Health** — `status: ok|degraded|down`, uptime, armed flags, feature flags, retry counts.
- **Ops** — `/api/ops/pause`, `/api/ops/resume`, `/api/ops/backups`, `/api/ops/restore`.
- **Docs** — `/api/docs` and `/api/docs/openapi.json`.
- **Compose extras** — pack import, snippets, presets, weekly plan, broadcast lists.
- **Stats** — `GET /api/stats/publish`, publish history CSV export.

## Wave-2

- Auto-reply rules/settings CRUD, webhooks, DLQ, stats, approvals (see `docs/auto-reply.md`).

## Wave-1

- Polish / publish / upload / creatives baseline.
