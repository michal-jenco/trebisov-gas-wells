# Trebišov Gas Wells — Agent Reference

## Architecture Overview

Static documentary site with **no build step, no package manager, no bundler**. Open `index.html` directly in a browser. Four source files:

| File | Role |
|---|---|
| `index.html` | All HTML structure (~2249 lines). Loads CSS + 3 JS files. |
| `styles.css` | All CSS (~765 lines). Single `:root` token block at top. |
| `gallery.js` | Gallery data arrays + shared lightbox engine. Loaded first. |
| `game.js` | "Christmas Tree Operator" game engine (~3338 lines, IIFE). Loaded second. |
| `export-pdf.js` | PDF export via jsPDF CDN. Reads `window._gameExportAPI` set by `game.js`. Loaded last. |

Script load order in `index.html` (bottom of `<body>`) is **intentional and load-order dependent**:
```html
<script src="gallery.js"></script>
<script src="game.js"></script>
<script src="export-pdf.js"></script>
```

## Developer Workflow

- **Preview**: Open `index.html` in a browser — no server required.
- **Crop aerials**: `sips -c <height> <width> --cropOffset <y> <x> source.png --out images/maps/hist_*.jpg`
- **No tests, no linter, no CI.**

## Cross-File Communication

`game.js` exposes a public API object for `export-pdf.js`:
```js
window._gameExportAPI = { getSnapshot, getChartData, getGasPriceLabel, getPenaltyCount, ... };
```
`game.js` also exposes all onclick handlers as `window.*` globals (e.g. `window.gameStart`, `window.gameSetChoke`). The `game.js` IIFE uses `const $ = id => document.getElementById(id)` internally — do not confuse with jQuery.

## Section Map (`index.html`)

| Section | `id` | ~Line |
|---|---|---|
| Nav / Hero | — | 18 / 42 |
| Introduction | `#intro` | 780 |
| Featured photos | `#photos` | 819 |
| Location & satellite | `#location` | 853 |
| Annotated wellheads | `#annotated` | 930 |
| Comparison table | `#comparison` | 968 |
| Nameplate | `#nameplate` | 1046 |
| Gas flow interactive | `#gasflow` | ~1180 |
| Components | `#components` | 1161 |
| History | `#history` | 1320 |
| Timeline | `#timeline` | 1433 |
| Geology / Geothermal | `#geology` / `#geothermal` | 1519/1540 |
| Technical reference | `#technical` | 1560 |
| Full gallery | `#gallery` | 1866 |
| Sources | `#sources` | 2038 |
| Game (`#game`) + lightbox | — | ~2086 / 2077 |

## Gallery & Lightbox Pattern (`gallery.js`)

Four named arrays (`photosGallery`, `annotatedGallery`, `histGallery`, `mainGallery`). Shared state: `let _gallery = [], _galleryIdx = 0;`

```js
// With prev/next navigation:
openLightbox(gallery[i].src, gallery[i].caption, gallery, i)
// Standalone (no arrows):
openLightbox('images/foo.jpg', 'Caption text')
```

## CSS Design Tokens (`styles.css :root`)

```css
--cyan: #00d2ff   --orange: #ff5200  --dark: #07071e  --darker: #030310
--card: #0c0c28   --border: #1c1c48  --text: #d0d0ec  --silver: #9aa0bc
--yellow: #ffd200 --green: #00e676   --warm: #ffb347
--font-display: 'Barlow Condensed'   --font-body: 'Barlow'
```
Always use tokens; never hardcode colours in HTML or JS.

## Game Engine Conventions (`game.js`)

- All mutable game state in a single `const GS = { ... }` object.
- Live gas price fetched from Yahoo Finance `NG=F` on load; fallback `€35/MWh TTF`.
- Tutorial seen-state stored in `localStorage` key `gTutSeen`.
- Valve visuals driven by `VALVE_COLORS` map (`open` / `closed` / `locked`).
- Responsive layout check (`checkLayout()`) runs on load and `resize`.

## Key Conventions

- **Images**: referenced directly by relative path — `images/foo.jpg`. No hashing, no pipeline.
- **Map embed**: `<iframe src="https://mapy.com/s/fujunukude">` — use this share URL, do not change.
- **Well identity**: TR-8 = yellow + ball-valve; TR-9–12 = blue + Soviet gate-valve.
- **Verified data**: `nafta_trebisov_project_notes.json` is the source of truth for all facts and source URLs. Do not contradict it.
- **jsPDF**: loaded from cdnjs CDN (`<script>` in `<head>`), referenced as `window.jspdf.jsPDF` in `export-pdf.js`.
- Inline button styles in HTML are intentional for one-off interactive elements; shared component styles belong in `styles.css`.
