# Khmer OCR for ONLYOFFICE

An [ONLYOFFICE](https://www.onlyoffice.com/) plugin for the **PDF editor** that runs
browser-local Khmer OCR on the open PDF, lets you review the recognized text line by
line, reject the wrong lines, and export the result as a **PLU** (PDF Logical Unit)
searchable PDF.

OCR runs entirely on the user's machine. No document content is uploaded anywhere.

## Features

- **Run OCR** on every page of the open PDF.
- **Per-line review** in the left panel: each recognized line is listed with its
  confidence. Reject the lines that are wrong; rejected text is excluded from the
  exported text layer.
- **Editing disabled**: this version only supports accept/reject, not manual text
  editing.
- **Save as PLU PDF**: produces a PDF whose pages keep their appearance as a raster
  image plus an invisible `Type0`/`CIDFontType2` Unicode text layer with exact
  per-chunk `ToUnicode` mappings, so Khmer text is selectable, searchable and
  copyable.

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

The plugin loads its OCR models, the ONNX Runtime Web runtime and the Khmer
segmenter with relative HTTP requests, so it must be served over HTTP(S) — not
opened from `file://`.

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
code.js                  panel UI, review state, PLU export (pdf-lib)
vendor/pdf-lib.min.js    PDF writer (pdf-lib 1.17.1)
assets/                  TypsastraLogical.ttf (Type0 descriptor source)
worker/
  ocr-worker.js          web worker: detection, recognition, segmentation
  models/                PP-OCRv6 detector (tiny) + AOU-CTC int8 recognizer + vocab
  wasm/                  Khmer segmenter (WASM)
  data/                  Khmer dictionary
  vendor/ort/            ONNX Runtime Web 1.23.2 (wasm execution provider)
resources/               plugin + store icons, store screenshots
licenses/                third-party licenses for the bundled OCR assets
```

Pipeline: PDF page image → PP-OCRv6 tiny detector → DB post-processing →
perspective crop → AOU-CTC int8 recognizer → Khmer Viterbi segmentation → review →
PLU text layer.

Page count and page sizes are read with the public Document Builder API
(`Asc.plugin.callCommand`); no patched editor build is required.

## Third-party components

Bundled third-party software and data:

| Component | Version | License |
| --- | --- | --- |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.23.2 | MIT |
| [khmer_segmenter](https://github.com/Sovichea/khmer_segmenter) | 0.2.0 | see `licenses/khmer_segmenter_LICENSE` |
| Khmer dictionary (`khmer_dictionary.kdict`) | 0.2.0 | see `licenses/khmer_dictionary_LICENSE.md` |
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
