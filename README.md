# FingerPrint

Designs sets of laser-cut, finger-jointed drawer trays and organizers, and
exports manufacturing files.

**Live:** https://janovetz.github.io/fingerprint/

**Run it:** open `index.html` in a browser. No install or build step. The 3D preview
and ZIP export load three.js / JSZip from a CDN, so they need an internet connection.

**Workflow**
1. *Layout:* enter the drawer's inside size, then split and drag to lay out the trays.
   Add dividers to any tray from the inspector.
   Trays with the same size share a letter.
2. *3D preview:* the real cut geometry, assembled. Use the explode slider to see the joints.
3. *Cut sheets:* parts nested on your stock, with grain running along the walls.
4. *Export files:* a ZIP with nested sheets (SVG + DXF), one DXF/SVG per unique part
   (quantity in the file name), a CSV cut list, a README for the cutting service, and
   `project.json` (re-open it with **Open**).

**Joinery:** finger joints at the four corners. The floor has edge tabs that pass through slots
near the bottom of each wall and finish flush outside. The floor is raised by the "floor
lift" so every slot keeps a bridge of wood under it.

**Dividers:** select a tray and set its compartments (wide × deep), then drag the dividers in
the drawing to move them. Their ends tab through the walls, like the floor tabs, and their
bottoms tab into floor slots. Crossing dividers half-lap. "Divider drop" in Joinery lowers
every divider below the rim.

**Engraving:** type a label per compartment in the tray inspector. Font, letter height and
style (area = solid burn, line = outline burn) are set under Engraving. The arrow on each
label box rotates that label in 90° steps. Text is converted to
vector outlines, so the cutter needs no fonts. Colors follow Ponoko's recommendation, and you
assign them after upload: blue stroke = cut, gray fill = area engrave, red stroke = line engrave.
Floors are drawn as seen from above, so an engraved floor reads correctly and its slots line up
when it's installed engraved face up.

**Split floors:** a floor bigger than the stock is cut into pieces (toggle under Sheets). If a
divider is in range, the seam runs under it: the seam is hidden, and the divider's floor tabs
straddle it and tie the pieces together. Otherwise the pieces join with glued T-shaped puzzle
keys. Seams avoid floor-edge tab corners, divider slots and engraved labels.

**Kerf:** leave it at 0 if your service compensates for kerf itself. Confirm this with the service.
On your own laser, set it to the beam width (~0.15–0.2 mm). Outlines then grow and slots
shrink by half the kerf each.

**Tests:** `node test/run.js`. These include a voxel assembly check confirming every
tray's parts interlock with no overlaps or gaps.

| File | Role |
|---|---|
| `js/geometry.js` | tray parts, finger/slot geometry, kerf offset, units |
| `js/layout.js` | drawer layout tree (split / merge / resize) |
| `js/nest.js` | multi-sheet MaxRects nesting with grain lock |
| `js/engrave.js` | compartment label layout, glyph outlines, curve flattening |
| `js/export.js` | SVG, DXF (R12), CSV writers |
| `js/app.js` | UI |
