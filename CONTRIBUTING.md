# Contributing

## Setup

```powershell
npm install
copy .env.example .env   # fill locally; never commit .env
npm run dev              # API + Vite UI
```

## Dry-run rules

- Default is dry-run. Never live-post unless you intentionally arm credentials and confirm.
- `UI_FORCE_DRY_RUN=true` pins the console.
- Queue runner stays dry-run unless `QUEUE_ARMED=true`.
- Auto-reply sends only when `AUTO_REPLY_ENABLED=true`.

## Test commands

| Command | Purpose |
|---------|---------|
| `npm run lint` | ESLint |
| `npm test` | Vitest unit/API |
| `npm run smoke:auto-reply` | Offline auto-reply smoke |
| `npm run smoke:ui` | API dry-run smoke (set `MOCK_OLLAMA=true` offline) |
| `npm run build:web` | Production web build |
| `npm run verify:all` | lint → test → smokes → build |
| `npm run smoke:matrix` | All smokes with timings |
| `node scripts/secret-scan.js` | Token-like pattern scan |
| `node scripts/doctor.js` | Local environment doctor |

## Checklist workflow

Feature IDs live in `.cursor/agents/platform-wave3.md`. Mark ✅ when the item's test note is satisfied. Use the `finish-wave` subagent to complete remaining batches.
