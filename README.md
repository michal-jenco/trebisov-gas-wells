# Trebišov Gas Field — NAFTA Gbely Wellhead Documentation

Field documentation of decommissioned natural gas wellheads operated by **NAFTA a.s. Gbely** in Trebišov, eastern Slovakia. This project records the physical equipment, engineering details, history, and future geothermal conversion plans for wells **Trebišov 8–12**.

🌐 **Live site:** `https://YOUR-USERNAME.github.io/nafta-trebisov/`

---

## What This Documents

The five natural gas wells of the Trebišov field (Trebišov 8–12) were drilled to depths of 2,250–2,607 metres into the East Slovak Basin and operated by NAFTA VÝCHOD a.s. from 1996 until decommissioning in 2015. The surface equipment — known as **Christmas trees** (vianočné stromčeky) — was left in place and photographed on-site in early 2026.

Two distinct wellhead generations are present:
- **Blue Christmas trees** — Soviet-era gate valve design (1960s–80s)
- **Yellow Christmas trees** — Ball valve design with pneumatic actuators (1996)

In February 2024, the Slovak Ministry of Environment approved NAFTA's plan to repurpose these exact wells as geothermal heat exchangers for Trebišov's district heating network — the first such project in Slovakia.

---

## Repository Structure

```
nafta-trebisov/
├── index.html                  ← main site (open this in a browser)
├── README.md                   ← this file
├── nafta_trebisov_project_notes.json   ← all verified data & source URLs
└── images/
    ├── panorama.jpg            ← field panorama, multiple wellheads
    ├── field_overview.jpg      ← access road and well pads
    ├── blue_well_full.jpg      ← blue Christmas tree, full view
    ├── blue_well_cellar.jpg    ← blue wellhead cellar & base detail
    ├── blue_annotated.jpg      ← blue tree with component labels
    ├── yellow_well_1.jpg       ← yellow Christmas tree #1
    ├── yellow_well_2.jpg       ← yellow Christmas tree #2 (ball valve design)
    ├── yellow_well_closeup.jpg ← yellow wellhead mid-section detail
    ├── yellow_annotated.jpg    ← yellow tree with component labels
    └── nameplate.jpg           ← NAFTA-UD Gbely stamped identification plate
```

---

## Deploying to GitHub Pages

1. Create a new public repository on GitHub (e.g. `nafta-trebisov`)
2. Upload all files maintaining the folder structure above — `index.html` and `README.md` at the root, all images inside an `images/` subfolder
3. Go to **Settings → Pages → Source** and select `main` branch, `/ (root)`
4. GitHub will publish the site at `https://YOUR-USERNAME.github.io/nafta-trebisov/`

That's it. No build step, no dependencies, no server required.

---

## Key Facts

| Field | Value |
|---|---|
| Location | Trebišov, Košice Region, Slovakia (48°37′N 21°42′E) |
| Operator | NAFTA VÝCHOD a.s. (subsidiary of NAFTA a.s. Gbely) |
| Wells | Trebišov 8, 9, 10, 11, 12 |
| Well depths | 2,250–2,607 m |
| Gas purity | 94–99% CH₄ |
| Max working pressure | 35 MPa (~5,000 PSI) |
| Equipment date | 28 October 1996 (per nameplate) |
| Production ended | 2015 |
| Geothermal approval | February 2024 (Slovak MŽP) |
| Projected thermal output | 0.9–1 MW |

---

## Sources

All 17 verified source URLs are listed in the site's Sources section and stored in `nafta_trebisov_project_notes.json`. Primary sources include nafta.sk, TERAZ.sk / TASR wire, SLOVGAS, RFE/RL, The Slovak Spectator, MDPI peer-reviewed geology papers, and USGS Bulletin 2204-B (Pannonian Basin Province).

---

## Photography

All field photographs were taken on-site at the Trebišov gas field in early 2026. Images are provided as original full-resolution JPEGs. The annotated wellhead diagrams (`blue_annotated.jpg`, `yellow_annotated.jpg`) were produced with AI assistance for educational and documentary purposes.

---

*Research and documentation assistance: [Claude AI](https://claude.ai) (Anthropic)*
