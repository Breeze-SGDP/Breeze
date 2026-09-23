# Breeze Dash II

Space-freight roguelike. The game is one HTML/JS source in
`app/src/main/assets/game/` (`game.js`, `game.css`, `index.html`); the Android
app only hosts it in a WebView (`MainActivity.kt`). See README.md.

## Verifying changes

- Cloud sessions have no Android SDK (Google's Maven is blocked). CI in
  `.github/workflows/android.yml` is the compile check: push, then read the run.
- `node --check app/src/main/assets/game/game.js` catches syntax errors fast.
- Game logic has no DOM dependency: `require('./app/src/main/assets/game/game.js')`
  in Node exposes `globalThis.BreezeGame` (`Flight`, `newRun`, `genRoutes`, ...).
  Use it for balance simulations before changing numbers in `BAL`.
- `docs/preview.html` is generated. Edit `docs/preview.template.html` or the game,
  then `node docs/build-preview.mjs`. Never hand-edit the generated file.
- After visual changes, regenerate the README images:
  `NODE_PATH="$(npm root -g)" node docs/render-screens.mjs "" /tmp/mobile.png`
  It fails on page errors or if the page scrolls sideways at 390px width. Grid
  containers holding wide tables need `grid-template-columns: minmax(0, 1fr)`;
  this bug has bitten twice.
- The preview is published as a Claude artifact at
  https://claude.ai/artifact/X3Jt7kdrMXpPUgagSBuTj9 . Update it by running
  `node docs/build-preview.mjs --artifact <path>` and publishing `<path>` with that `url`.
- The Table 6 simulation numbers in the template and README are hand-copied from
  a bot run; rerun and update them when balance changes. The bot must trade
  (sell all, buy best margin per cell, avoid hazardous adjacency) and fly with
  human-like reaction, or the numbers mean nothing.
- Balance lessons so far: anything paid per second favours the long detour;
  losing more than one cargo piece per hit made the direct route pointless.

## Owner's preferences

- The owner reviews on a phone and cannot easily install builds. Ship every
  program change with something they can look at: updated screenshots or
  blueprints in the README, and the playable preview kept in sync.
- The owner writes in Korean; reply in Korean.
