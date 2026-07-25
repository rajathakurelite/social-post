# UI design system

Design tokens for the Airepro operator console live in `web/src/tokens.css` (imported at the top of `web/src/styles.css`). All values are CSS custom properties on `:root` — change a token once and every component follows. Legacy variable names from the old `:root` block (`--bg0`, `--magenta`, `--radius`, `--font`, `--shadow`, `--focus`, …) are aliased to the new tokens, so both spellings work.

## Color

| Token | Value | Use |
|-------|-------|-----|
| `--color-bg` / `--color-bg-deep` | pale lilac `#faf7fc` → `#f3eef8` | page background gradient |
| `--color-surface` | translucent white (78%) | glassy panels over the gradient |
| `--color-surface-solid` | white | cards, inputs, modals |
| `--color-surface-tint` | faint lavender `#f8f4fb` | image preview wells |
| `--color-text` / `--color-text-muted` | near-black plum / dusty mauve | body text / secondary text |
| `--color-border` / `--color-border-strong` | translucent purple / translucent magenta | resting vs. emphasized borders |
| `--color-accent` / `--color-accent-bright` | deep magenta `#c2186a` / vivid magenta `#e11d8f` | brand accent, active states |
| `--color-violet` / `--color-violet-soft` / `--color-violet-deep` | violet `#6d28d9` / lavender / dark violet | gradient partner colors, links |
| `--color-ok` / `--color-fail` / `--color-warn` | emerald / red / amber | status pills, results, errors |

Shared tints: `--tint-ok-border`, `--tint-ok-bg`, `--tint-warn-border`, `--tint-warn-bg`, `--tint-fail-border`, `--tint-accent-border` (magenta hover borders), `--tint-accent-deep-border` (dropzone/edited-card border). Overlays: `--overlay-scrim` (modal backdrop) and `--overlay-scrim-strong` (lightbox).

Gradients: `--gradient-accent` (magenta → violet, primary buttons and the active step index) and `--gradient-accent-soft` (the same hues at ~10% alpha, selected chips and the current step).

## Typography

- `--font-display` — Fraunces (serif): brand mark, panel `h2`, card `h3`, modal titles.
- `--font-body` — Sora (sans): everything else. `--font-mono` for the `.digit` keyboard hints.
- Type ramp (rem): `--text-caption-2` 0.7 · `--text-caption` 0.72 · `--text-label` 0.78 · `--text-hint` 0.8 · `--text-ui` 0.88 · `--text-body` 0.9 · `--text-body-lg` 0.95 · `--text-title-sm` 1 · `--text-title` 1.2 · `--text-title-lg` 1.25 · `--text-brand` clamp(2.6rem–3.6rem). A few in-between sizes (0.75, 0.76, 0.82, 0.92, 1.02) are intentional one-offs and stay literal.
- Weights: `--weight-medium` 500, `--weight-semibold` 600, `--weight-bold` 700, `--weight-black` 800 (brand mark only).

## Spacing

Quarter-rem grid: `--space-1` 0.25 · `--space-2` 0.5 · `--space-3` 0.75 · `--space-4` 1 · `--space-5` 1.25 · `--space-6` 1.5 · `--space-8` 2 · `--space-9` 2.25 (rem). The UI also uses many in-between micro-gaps (0.35–0.65rem); those are deliberate optical adjustments and remain literal rather than forced onto the scale.

## Radii

`--radius-xs` 4px (kbd digits) · `--radius-sm` 8px (skeleton bars, log rows) · `--radius-md` 10px (rule list, small images) · `--radius-lg` 12px (inputs, toasts, results) · `--radius-xl` 14px (cards, dropzone) · `--radius-2xl` 16px (panels, modal, sticky bar) · `--radius-pill` 999px (buttons, pills, chips) · `--radius-round` 50% (spinner, step index).

## Shadows

`--shadow-card` (soft purple, panels) · `--shadow-sticky` (sticky action bar) · `--shadow-toast` · `--shadow-modal` · `--shadow-btn-primary` (magenta glow) · `--shadow-btn-danger` (red glow) · `--shadow-focus` (3px magenta ring — the single focus treatment for inputs, buttons, dropzone, active rule).

## Motion

Durations: `--dur-fast` 0.12s (button/platform transforms) · `--dur-base` 0.15s (border/shadow transitions) · `--dur-med` 0.2s (dropzone, modal backdrop) · `--dur-slow` 0.28s (toast-in) · `--dur-enter` 0.45s (card-in) · `--dur-rise` 0.5s / `--dur-rise-lg` 0.55s (panel/brand rise-in) · `--dur-spin` 0.7s · `--dur-shimmer` 1.2s. Easings: `--ease-default` (ease), `--ease-in-out` (shimmer). Keyframes: `rise-in`, `card-in`, `toast-in`, `shimmer`, `spin`. All motion collapses under `prefers-reduced-motion: reduce`.

## Component conventions (`web/src/styles.css`)

- **Buttons** — `.btn` base (pill radius, `--weight-semibold`, fast hover lift) with variants: `.btn-primary` (`--gradient-accent` + `--shadow-btn-primary`), `.btn-secondary` (solid surface + border), `.btn-ghost` (transparent, muted), `.btn-danger` (red gradient, live-publish confirm only). Small round actions: `.btn-clear`, `.btn-copy`, `.btn-pill`.
- **Pills / badges** — `.pill` status chips with `.ok` / `.warn` tint variants; `.step` stepper chips (`.current` uses `--gradient-accent-soft` + `--color-accent`, `.done` uses `--color-ok`); `.edited-badge` uppercase magenta marker; `.digit` mono keyboard hints.
- **Cards & panels** — `.panel` (glassy `--color-surface`, `--radius-2xl`, `--shadow-card`, rise-in) contains `.post-card` review cards (`--color-surface-solid`, `--radius-xl`, card-in; `.edited` gets the deep-magenta border). `.skeleton-card` + `.skel` shimmer placeholders mirror the card shape.
- **Toasts** — fixed `.toast-stack` bottom-right; `.toast` rows (`--radius-lg`, `--shadow-toast`) with `.ok` / `.fail` / `.info` color variants and a `.toast-dismiss` close button.
- **Focus states** — one ring everywhere: `box-shadow: var(--shadow-focus)` on `:focus-visible` for buttons/inputs/dropzone, `:focus-within` for platform chips, plus `--color-border-strong` on focused inputs. Never remove the ring without a replacement.
- **Overlays** — `.modal-backdrop` / `.modal` (confirm dialogs) and `.lightbox` (image zoom) share the scrim tokens and z-index 80.

When adding UI, pull from these tokens first; introduce a new literal only for a genuine one-off, and promote it into `tokens.css` once it appears twice.
