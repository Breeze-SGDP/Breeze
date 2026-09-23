# Breeze Dash

One-finger Android arcade game in Kotlin, drawn on a `SurfaceView` canvas with no
engine. See README.md for gameplay and layout.

## Verifying changes

- Cloud sessions have no Android SDK (Google's Maven is blocked). CI in
  `.github/workflows/android.yml` is the compile check: push, then read the run.
- `docs/preview.html` is a browser port of `GameView.kt` and duplicates its rules
  and constants (speeds, gap widths, sizes, colours, text). Any change to those in
  `GameView.kt` must be mirrored there, or the preview stops matching the APK.
- After visual changes, regenerate the README images:
  `NODE_PATH="$(npm root -g)" node docs/render-screens.mjs`
  It exits non-zero if View B lost its dimension callouts, the page logs errors,
  or (with a second screenshot path) the page scrolls sideways at phone width.
- The same page is published as a Claude artifact at
  https://claude.ai/artifact/X3Jt7kdrMXpPUgagSBuTj9 . To update it, publish the
  file with that `url`, minus the wrapper `docs/preview.html` adds (the lines from
  `<!doctype html>` through `<body>`, and the closing `</body></html>`).

## Owner's preferences

- The owner reviews on a phone and cannot easily install builds. Ship every
  program change with something they can look at: updated screenshots or
  blueprints in the README, and the playable preview kept in sync.
- The owner writes in Korean; reply in Korean.
