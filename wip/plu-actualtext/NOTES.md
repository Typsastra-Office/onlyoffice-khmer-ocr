# WIP: PLU export and the legacy text layer

Not finished. This branch holds the work in progress; the official
`typsastra-rebrand` branch has the **Save as PLU PDF** button removed while the
export code stays intact.

## What is solved

The export keeps the original PDF instead of rebuilding pages from a
resolution-limited OCR raster. `readOriginalPdfBytes()` returns `{bytes, error}`,
but the exporter passed that wrapper to `PDFDocument.load()`, so loading always
failed and it silently fell back to `buildRasterPdf()`. Fixing the argument makes
the PLU render **pixel-for-pixel identical** to the source at 2x scale.

The invisible OCR stream is also written first in the page `Contents` array. A
preserved PDF can carry a legacy Khmer text layer whose `/ToUnicode` is wrong, and
when that layer comes first PDFium's hit-testing returns its garbled text instead
of the OCR text at the same coordinates.

## What is not solved

Select-all on a PLU returns the broken legacy text *and* the OCR text together.
Measured over the 104-page `2026-06-01-00007764` document:

| | count |
|---|---|
| U+FFFD replacement characters | 12,722 |
| printable mojibake (Latin-1 range) | 12,117 |
| correct Khmer | 125,598 |

The legacy text cannot simply be deleted: on page 5 there are no images and 10
embedded fonts, so the legacy text *is* what paints the visible glyphs. Removing
it blanks the page.

## Findings so far

- **Dropping `/ToUnicode` does not work.** It cut U+FFFD from 12,722 to 303 but
  raised printable mojibake from 12,117 to 12,472, because the reader then
  guesses from the encoding. Glyphs stayed crisp in every case.
- **`/Artifact` does not work.** Marking the legacy content as an artifact left
  selection unchanged (202,156 characters, 12,722 U+FFFD, identical to baseline).
  PDFium does not skip artifact content when building its text page.
- **`/ActualText` works**, including per-character selection and search, so it
  can correct extraction without touching glyphs:

  ```
  select-all          -> 'ក្នុងរយៈពេលជាងពីរទសវត្សរ៍កន្លះក្រោយទទួលបានសុ'
  substring [+12:+10] -> 'ាងពីរទសវត្'      <- correct, per character
  search inside line   -> found at (17, 8)
  ```
- **Cost is negligible.** 2,833 wrapped spans, 0.52 MB raw, **0.06 MB deflated**
  (ratio 0.11) against an 11.8 MB file, about 0.5%.
- **Wrapping alone duplicates text.** The invisible overlay still carries the same
  line, so select-all reported some lines two or four times. The overlay run for
  each wrapped line must be dropped as well.

## Open problem

`wrap_actualtext.py` matches each legacy `BT…ET` run to an OCR line by baseline
(within 3pt) and x-range, and wraps it in `/ActualText`. Baselines match exactly,
but the "is this font broken" test is unreliable. It currently flags a font whose
`/ToUnicode` targets are `U+FFFD` or in the Latin-1 range, and on page 5 that
identifies `KhmerDigitalMax` while missing `___WRD_EMBED_SUB_47`, which is the
actual source of the garbage. Only 4 of the first 10 pages were touched, leaving
pages 2, 3, 4, 7 and 10 unchanged.

Better approach: decide per text run by comparing what the legacy font extracts
against the OCR text at the same position. If they disagree the mapping is broken
and the run gets wrapped. That needs no per-font guesswork.

The scripts take absolute paths to the artefacts under test; adjust the constants
at the top of each file. Run `verify_artifact.py` last: it reports select-all
length, U+FFFD count, duplicate OCR lines and per-page pixel identity.