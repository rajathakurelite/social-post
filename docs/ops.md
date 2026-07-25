# Ops runbook (Wave-3)

Localhost operator ops for pause, backups, rotation, quarantine, and shutdown.

## Panic pause (205)

```powershell
# Halt all outbound publish + auto-reply sends
Invoke-RestMethod -Method POST http://127.0.0.1:8787/api/ops/pause
# Resume
Invoke-RestMethod -Method POST http://127.0.0.1:8787/api/ops/resume
```

State file: `output/ops-paused.flag`. Paused publish returns HTTP 503 with code `PAUSED`.

## Config backups / restore (179–180)

Saving auto-reply rules/settings copies the previous file into `config/backups/`.

- `GET /api/ops/backups` — list
- `POST /api/ops/restore` body `{ "name": "<backup filename>" }`

## Log rotation (185–186)

Settings: `config/log_rotation.json` (`maxBytes`, `keep`). JSONL writers use crash-safe append + rotate.

## Webhook quarantine (178)

Malformed webhook payloads land in `output/webhook-quarantine.jsonl` (review offline). Valid traffic is unchanged.

## Shutdown (181–182)

`Ctrl+C` / SIGTERM drains in-flight polish/publish up to 5s, then exits 0 with a `shutdown:` log line. PID file: `output/api.pid`.

## Healthcheck script (223)

```powershell
node scripts/healthcheck.js
# exit 0=ok, 1=degraded, 2=down
```

## Doctor (270)

```powershell
node scripts/doctor.js
```

## Related scripts

| Script | Purpose |
|--------|---------|
| `scripts/secret-scan.js` | Token-like pattern lint |
| `scripts/prune-output.js` | Retention dry-run / delete |
| `scripts/smoke-matrix.js` | All smokes table |
| `scripts/queue-runner.js` | Scheduled queue (dry-run unless `QUEUE_ARMED=true`) |
