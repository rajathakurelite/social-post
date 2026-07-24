# WhatsApp Business

## What the skill does

`skills/post_whatsapp.js` sends a **session text** message via Meta WhatsApp Cloud API:

`POST https://graph.facebook.com/{version}/{phone-number-id}/messages`

Recipients come from `WHATSAPP_TO` (comma-separated). Default Graph version is `v21.0`.

**Compliance:** recipients must opt in. Free-form text is for the **24-hour session window**; outside that window Meta usually requires **approved templates** (this codebase sends session text only).

## Required `.env` vars

| Variable | Purpose |
|----------|---------|
| `WHATSAPP_ACCESS_TOKEN` | Meta WhatsApp access token (temp or System User) |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone **number ID** from API Setup (not the display number) |
| `WHATSAPP_TO` | E.164 digits only, no `+`; comma-separated for multiple |

Optional: `WHATSAPP_GRAPH_VERSION` (default `v21.0`).

## Toggles

| Control | Role |
|---------|------|
| `WHATSAPP_ENABLED` | Hard on/off. Unset → enabled. `false` / `0` / `no` / `off` → skip. |
| `PLATFORMS` | Include `whatsapp` in the comma list (when not using `--only=`). |
| `--only=whatsapp` | Selects WhatsApp for this run **only if** `WHATSAPP_ENABLED` is not disabled. |

See [docs/README.md](./README.md) for how selection and enable flags combine.

## Credential collection (short)

1. Meta app → add **WhatsApp** product → **API Setup**.
2. Copy **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`; token → `WHATSAPP_ACCESS_TOKEN` (prefer System User for production).
3. Set `WHATSAPP_TO` to opted-in test/prod numbers (E.164 digits only, e.g. `15551234567`).
4. Confirm legal/compliance opt-in; vault-label exact env names.

**Detail:** root [README.md → Plugin: WhatsApp Business](../README.md#plugin-whatsapp-business).

## Dry-run / live verify

```bash
node scripts/run.js --dry-run --only=whatsapp "whatsapp smoke"

# WHATSAPP_ENABLED=false → expect skip
node scripts/run.js --dry-run --only=whatsapp "whatsapp smoke"

# Live sends real messages to WHATSAPP_TO
node scripts/run.js --only=whatsapp "whatsapp live topic"
```

## Common errors

| Symptom | Likely cause |
|---------|----------------|
| Skipped: missing config | Empty token, phone number id, or `WHATSAPP_TO` |
| Template / session-window errors | Outside 24h window without an approved template |
| Invalid recipient | `WHATSAPP_TO` has `+`/spaces, wrong country code, or number not allowed in app |
| Auth / permission errors | Expired temporary token or wrong WhatsApp asset assignment |
| Skipped: `WHATSAPP_ENABLED=false` | Flag off |
