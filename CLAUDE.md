# Trebišov Gas Wells — Claude Reference

## Project
Static documentation site for decommissioned NAFTA Gbely gas wells (Trebišov 8–12), eastern Slovakia.
**Single file:** `index.html` (~2188 lines) + `images/` folder. No build step, no dependencies.

## File structure
```
index.html          — entire site (CSS + HTML + JS in one file)
images/             — field photography
images/maps/        — historical aerial screenshots from mapy.com
nafta_trebisov_project_notes.json  — verified research data & source URLs
```

## Section map (id → line)
| Section | id | ~Line |
|---|---|---|
| Nav | — | 723 |
| Hero | — | 741 |
| Fact bar | — | 767 |
| Introduction | `#intro` | 780 |
| Featured photos | `#photos` | 819 |
| Location & satellite | `#location` | 853 |
| Annotated wellheads | `#annotated` | 930 |
| Comparison | `#comparison` | 968 |
| Nameplate | `#nameplate` | 1046 |
| Gas flow interactive | `#gasflow` | ~1180 |
| Components | `#components` | 1161 |
| History | `#history` | 1320 |
| Timeline | `#timeline` | 1433 |
| Geology | `#geology` | 1519 |
| Geothermal | `#geothermal` | 1540 |
| Technical reference | `#technical` | 1560 |
| Full gallery | `#gallery` | 1866 |
| Sources | `#sources` | 2038 |
| Lightbox HTML | — | 2077 |
| `<script>` block | — | 2086 |

## JS galleries (defined in `<script>` ~line 2086)
| Const | Count | Used in section |
|---|---|---|
| `photosGallery` | 4 | `#photos` |
| `annotatedGallery` | 2 | `#annotated` |
| `histGallery` | 4 | `#location` (historical aerials) |
| `mainGallery` | 23 | `#gallery` |

State: `let _gallery = [], _galleryIdx = 0;`

## Lightbox API
```js
// Gallery image (shows prev/next arrows):
openLightbox(gallery[i].src, gallery[i].caption, gallery, i)

// Standalone image (no arrows):
openLightbox('images/foo.jpg', 'Caption text')
```
Single shared `#lightbox` div. Keyboard: Esc closes, ← → navigates.

## CSS design tokens (`:root`)
```css
--cyan: #00d2ff    --orange: #ff5200   --dark: #07071e
--darker: #030310  --card: #0c0c28     --border: #1c1c48
--text: #d0d0ec    --silver: #9aa0bc   --yellow: #ffd200
--green: #00e676   --warm: #ffb347
--font-display: 'Barlow Condensed'     --font-body: 'Barlow'
```

## Key conventions
- Images referenced directly by path, no asset pipeline
- `mapy.com` embed uses share URL `https://mapy.com/s/fujunukude` in `<iframe>`
- Historical aerials cropped from mapy.com screenshots via `sips`, stored as `images/maps/hist_*.jpg`
- Wells: TR-8 (yellow, ball-valve), TR-9, TR-10, TR-11, TR-12 (blue, gate-valve Soviet-era)
- Decommissioned 2015; geothermal conversion approved Feb 2024
