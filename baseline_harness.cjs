/**
 * Focused checks for PLU line placement.
 *
 * OCR detector and PDF-selection quads are bounding boxes, not baselines. The
 * writer needs a text origin inside the box so the PDF reports the same box.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CODE = path.join(__dirname, "code.js");

function loadPlugin() {
  const window = {
    localStorage: null,
    console,
    setTimeout,
    clearTimeout,
    location: { href: "file:///c/" },
    Uint8ClampedArray,
    Int32Array,
    Uint8Array,
    Math,
    Number,
    Promise,
  };
  window.window = window;
  const sandbox = {
    window,
    document: { addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    navigator: { userAgent: "node" },
    console,
    setTimeout,
    clearTimeout,
    Uint8ClampedArray,
    Int32Array,
    Uint8Array,
    Math,
    Number,
    Promise,
    URL,
    location: window.location,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE, "utf8"), sandbox, { filename: "code.js" });
  return window.KhmerOcrPlugin;
}

function quad(left, top, right, bottom) {
  return {
    p0: { x: left, y: top }, p1: { x: right, y: top },
    p2: { x: right, y: bottom }, p3: { x: left, y: bottom }
  };
}

/**
 * Reproduce drawInvisibleLogicalLine: the glyph box spans 0.26S below the
 * origin quad.p3 and 0.74S above it, with S = verticalLength * growth.
 */
function writtenGlyphBox(box, growth) {
  const vertical = Math.abs(box.p0.y - box.p3.y);
  const size = growth * vertical;
  return { size, top: box.p3.y - 0.74 * size, bottom: box.p3.y + 0.26 * size };
}

const plugin = loadPlugin();
const { quadForDetectorBox, detectorBoxGrowth } = plugin;
const OLD_GROWTH = 1.38;

// PDF-selection geometry is a rectangle, not a baseline. Its bottom corner
// must be converted to the font's baseline in exactly the same way as a
// detector box. PDF-text already comes from a preserved source text layer.
{
  const q = quad(20, 40, 180, 60);
  const result = plugin.pluPlacement({}, { source: 'pdf-selection', quad: q });
  const box = writtenGlyphBox(result.quad, result.growth);
  assert.ok(Math.abs(box.top - 40) < 0.01 && Math.abs(box.bottom - 60) < 0.01,
    'PDF selection must reproduce the source selection rectangle');
}

// An existing PDF text anchor must not replace the detector's geometry.
{
  const q = quad(20, 40, 180, 60);
  const placed = plugin.pluPlacement({ sourceTextAnchors: [{
    bounds: { left: 20, right: 180, top: 43, bottom: 52 },
    baselineStart: { x: 20, y: 51 }, baselineEnd: { x: 180, y: 51 },
    height: 9
  }] }, { source: 'ocr', quad: q });
  const box = writtenGlyphBox(placed.quad, placed.growth);
  assert.ok(Math.abs(box.top - 40) < 0.01 && Math.abs(box.bottom - 60) < 0.01,
    'PDF text anchors must not override the detector box');
}

// 1. The origin moves up by 0.26 of the box height, and nothing else moves.
{
  const q = quad(10, 20, 190, 54);            // height 34
  const box = quadForDetectorBox(q);
  assert.strictEqual(box.p0.y, 20, "top edge stays on the box top");
  assert.strictEqual(box.p1.y, 20, "top edge stays on the box top");
  assert.strictEqual(box.p0.x, q.p0.x, "x is untouched");
  assert.strictEqual(box.p3.x, q.p3.x, "x is untouched");
  assert.strictEqual(box.p3.y, 54 - 0.26 * 34, "origin sits 0.26H above the box bottom");
  console.log("  origin moved from", q.p3.y, "to", box.p3.y.toFixed(2), "(box height 34)");
}

// 2. The invariant: the glyph box the PDF reports equals the detector box.
{
  const cases = [34, 28, 20.5, 13.5, 6, 47.25];
  cases.forEach(function (h) {
    const q = quad(10, 100 - h, 190, 100);   // image coords: top is the smaller y
    const box = quadForDetectorBox(q);
    const g = writtenGlyphBox(box, detectorBoxGrowth);
    const boxTop = 100 - h, boxBottom = 100;
    assert.ok(Math.abs(g.top - boxTop) < 0.01,
      "glyph box top " + g.top.toFixed(3) + " must equal box top " + boxTop);
    assert.ok(Math.abs(g.bottom - boxBottom) < 0.01,
      "glyph box bottom " + g.bottom.toFixed(3) + " must equal box bottom " + boxBottom);
    assert.ok(Math.abs(g.size - h) < 0.01, "size must be the box height, got " + g.size.toFixed(3));
    console.log("  box height " + h + "pt -> glyph box [" + g.top.toFixed(2) + ", " + g.bottom.toFixed(2) + "] size " + g.size.toFixed(2));
  });
}

// 3. This is what the old geometry did, and it is the bug being removed.
{
  const h = 33.5;
  // Image coordinates: a larger y is lower on the page.
  const q = quad(10, 100 - h, 190, 100);
  const old = writtenGlyphBox(q, OLD_GROWTH);              // anchored at the box bottom
  const now = writtenGlyphBox(quadForDetectorBox(q), detectorBoxGrowth);
  const boxCentre = (q.p0.y + q.p3.y) / 2;
  const oldCentre = (old.top + old.bottom) / 2;
  const newCentre = (now.top + now.bottom) / 2;
  assert.ok(oldCentre > boxCentre, "the old geometry sat below the box centre");
  assert.ok(Math.abs(newCentre - boxCentre) < 0.01, "the new geometry is centred on the box");
  console.log("  old selection centre " + oldCentre.toFixed(2) + " vs box centre " + boxCentre.toFixed(2) +
    " -> " + (oldCentre - boxCentre).toFixed(2) + "pt low (this is the -5.7pt offset)");
  console.log("  new selection centre " + newCentre.toFixed(2) + " -> " + (newCentre - boxCentre).toFixed(2) + "pt");
}

// 4. Rotated boxes retain their orientation and geometry.
{
  const q = {
    p0: { x: 20, y: 20 }, p1: { x: 180, y: 30 },
    p2: { x: 176, y: 50 }, p3: { x: 16, y: 40 }
  };
  const box = quadForDetectorBox(q);
  assert.strictEqual(box.p3.x, 16 + 0.26 * 4);
  assert.strictEqual(box.p3.y, 40 - 0.26 * 20);
  assert.strictEqual(box.p2.x, 176 + 0.26 * 4);
  assert.strictEqual(box.p2.y, 50 - 0.26 * 20);
  assert.ok(Math.abs(Math.hypot(box.p0.x - box.p3.x, box.p0.y - box.p3.y) * detectorBoxGrowth -
    Math.hypot(q.p0.x - q.p3.x, q.p0.y - q.p3.y)) < 0.01);
}

// 5. A degenerate box must not produce a NaN origin.
{
  const flat = quad(10, 20, 190, 20);
  const box = quadForDetectorBox(flat);
  assert.ok(Number.isFinite(box.p3.y), "origin must stay finite, got " + box.p3.y);
  console.log("  flat box origin:", box.p3.y, "(unchanged)");
}

console.log("Detector-box placement checks passed");
