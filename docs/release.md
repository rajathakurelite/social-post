# Release checklist

1. `npm run verify:all` — lint, test, offline smokes, build
2. `npm run smoke:matrix` — pass/fail table
3. `node scripts/secret-scan.js` — no token-like hits in source
4. Docs updated: `docs/api-changelog.md`, `docs/errors.md`, platform docs if APIs changed
5. Bump `version` in `package.json` (shown in health + UI footer + `x-api-version`)
6. Optional: `node scripts/bundle-size.js` after `build:web`
7. Optional: `node scripts/doctor.js` on a clean machine
