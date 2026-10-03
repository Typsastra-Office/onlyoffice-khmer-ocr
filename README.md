# Khmer OCR for ONLYOFFICE

An [ONLYOFFICE](https://www.onlyoffice.com/) plugin for the **PDF editor** that runs
browser-local Khmer OCR on the open PDF, lets you review the recognized text line by
line, reject the wrong lines, and export the result as a **PLU** (PDF Logical Unit)
searchable PDF.

OCR runs entirely on the user's machine. No document content is uploaded anywhere.

## Features

- **Run OCR** on every page of the open PDF. On pages with selectable text, use
  the PDF editor's line-selection geometry to crop the visible text for OCR even
  when the embedded Khmer Unicode is broken. Pages without usable selection
  geometry use the PP-OCRv6 detector.
- **Copy with Khmer OCR**: select text in the PDF editor and choose the action
  from its context menu while the plugin is open. Only the selected glyph
  regions are recognized, then their Khmer text is copied to the clipboard in
  page and line order. The editor snapshots the quads when its menu opens and
  handles the clipboard write after OCR. Requires the Typsastra PDF editor menu
  integration.
- **Preserve readable Latin text**: when a selectable line contains valid Latin
  Unicode from a Latin PDF font, take its text directly instead of re-running
  OCR. Legacy Khmer fonts still use image recognition. Adjacent selection boxes
  are bounded at the midpoint between lines before cropping for OCR. Font or
  shaping changes that split a visual line into overlapping PDF text runs are
  grouped by their shared baseline for one recognition crop. When the PDF font
  reports a wider box than the actual text, the visible ink bounds the crop and
  highlight without altering the original source PDF.
- **Per-line review** in the left panel: each recognized line is listed with its
  confidence. Click a line to highlight its PDF selection or OCR detection box in the PDF editor.
  The view centers the region: the page itself when the page fits the window, and
  the detected line when the page is taller than the window, so the line is never
  left at the top edge. The highlight stays until you press `Esc`, click the page,
  or pick another line. Reject the lines that are wrong; rejected text is excluded
  from the exported text layer.
- **Editing disabled**: this version only supports accept/reject, not manual text
  editing.
- **Save as PLU PDF**: adds an invisible `Type0`/`CIDFontType2` Unicode text layer
  with exact per-chunk `ToUnicode` mappings to the **original PDF pages**, so the
  document keeps its original quality and the Khmer text becomes selectable,
  searchable and copyable.
- **Automatic text widths**: match each recognized line to the original PDF's
  embedded font name and, when the corresponding Unicode font is installed,
  shape cluster advances with it. OCR timing is used automatically when the
  font cannot be identified or loaded; no font choice is required.
- **Parallel recognition**: the parallelism selector starts independent OCR
  workers on desktop pages without cross-origin isolation. On an isolated web
  host, one worker uses the selected number of ONNX Runtime WASM threads. The
  chosen value is saved in the plugin's local storage for subsequent sessions.

## Requirements

- ONLYOFFICE PDF editor (Document Server, Desktop Editors or cloud) with plugin
  support.
- A same-origin HTTP(S) host for the plugin assets (see *Development* below). The
  plugin needs `Worker`, `WebAssembly` and `XMLHttpRequest`.

## Installing

The plugin is a standard ONLYOFFICE plugin folder. To install it manually:

1. Place this folder under the editor's `sdkjs-plugins` directory (for Desktop
   Editors) or under the Document Server plugins directory.
2. Restart the editor. The plugin appears in the **Plugins** tab of the PDF editor
   and opens in the left panel.

## Development

The plugin loads its OCR models, the ONNX Runtime Web runtime and pdf.js with
relative HTTP requests, so it must be served over HTTP(S) — not opened from
`file://`.

```bash
# from the repository root
python -m http.server 8080
# then register http://localhost:8080/config.json as a plugin URL, or copy the
# folder into the editor's plugin directory and serve the whole editor over HTTP.
```

## Architecture

```
config.json              ONLYOFFICE plugin manifest
index.html               panel entry point
ui.css                   panel styling
code.js                  panel UI, review state, page rendering, PLU export
vendor/pdf-lib.min.js    PDF writer (pdf-lib 1.17.1)
vendor/pdfjs/            page rasterizer (pdf.js 4.10.38)
assets/                  TypsastraLogical.ttf (Type0 descriptor source)
worker/
  ocr-worker.js          web worker: detection and recognition
  models/                PP-OCRv6 detector (tiny) + AOU-CTC int8 recognizer + vocab
  vendor/ort/            ONNX Runtime Web 1.23.2 (wasm execution provider)
resources/               plugin + store icons, store screenshots
```

Pipeline: PDF page image + editor selection quads (where available), otherwise
PP-OCRv6 tiny detector + DB post-processing → perspective crop → AOU-CTC int8
recognizer → review → PLU text layer. The broken extracted text is never used
for recognition; only its selection geometry is used. The detector model loads
only when a page needs the detector fallback.

Page count and page sizes are read with the public Document Builder API
(`Asc.plugin.callCommand`); no patched editor build is required.

## Third-party components

Bundled third-party software and data:

| Component | Version | License |
| --- | --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT |
| [pdf.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.23.2 | MIT |
| TypsastraLogical.ttf | — | see `assets/` and `NOTICE` |

See [NOTICE](NOTICE) for details.

## Marketplace

Store assets live under `resources/store/`:

- `resources/store/icons/` — store listing icon.
- `resources/store/screenshots/screen_1.png`, `screen_2.png` — **placeholder**
  images; replace them with real screenshots of the plugin running in the ONLYOFFICE
  PDF editor before submitting.

Submit the plugin through the ONLYOFFICE plugin marketplace submission process,
providing the repository URL and the `store` metadata from `config.json`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
