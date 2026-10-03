/** Verify the actual PLU exporter reuses semantic CIDs and geometry GIDs. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

const root = __dirname;
const PDFLib = require(path.join(root, "vendor", "pdf-lib.min.js"));
const source = fs.readFileSync(path.join(root, "code.js"), "utf8");
const marker = "})(window, undefined);";
const at = source.lastIndexOf(marker);
if (at < 0) throw new Error("Plugin IIFE not found");
const script = source.slice(0, at) +
	"\nglobalThis.pluTest = { createPdfLogicalFont, drawInvisibleLogicalLine, " +
	"measureShapedWidths, fontFamilyForPdfName, sourceFontForLine, " +
	"buildLogicalUnits, applyTextLayer, state, advanceTotalFor };\n" +
	source.slice(at);
const globals = {
	window: { PDFLib, Asc: { plugin: {} } }, console, Promise, Map, Set, Math,
	Number, Array, Object, String, Error, Uint8Array, DataView, JSON,
};
globals.globalThis = globals;
vm.runInContext(script, vm.createContext(globals), { filename: "code.js" });
const plugin = globals.pluTest;
const out = process.argv[2] || path.join(os.tmpdir(), "typsastra-plu-font-test");
fs.mkdirSync(out, { recursive: true });

const count = Number(process.argv[3] || 48223);
if (!Number.isInteger(count) || count < 45) throw new Error("Need at least 45 clusters");
const labels = ["ស", "ទ្ទា", "នុ", "ក្រ", "ម", "ពា", "ក្យ", "ច្បា", "ប់"];
const chunks = Array.from({ length: count }, (_, id) => ({
	id, unicode: labels[id % labels.length], advance: (id % 5 + 1) * 50,
	start: id / count, end: (id + 1) / count,
}));
// Exercise PDFium's adjacent-identical-CID deduplication. The second CID
// variant must retain the same Unicode and GID without losing a character.
chunks[44].unicode = chunks[43].unicode;
chunks[44].advance = chunks[43].advance;
function check(description, condition) {
	if (!condition) throw new Error(description);
	console.log("ok:", description);
}
function quad() {
	return { p0: { x: 50, y: 210 }, p1: { x: 500, y: 210 },
		p2: { x: 500, y: 240 }, p3: { x: 50, y: 240 } };
}

(async () => {
	const pdf = await PDFLib.PDFDocument.create();
	const font = plugin.createPdfLogicalFont(pdf, [{ chunks }]);
	check(count + " occurrences reduce to 46 semantic/width CIDs (including adjacent variant)",
		font.cidCount === 46);
	check("font has .notdef and only five reusable width GIDs", font.glyphCount === 6);
	check("repeated Unicode and width reuse a CID",
		font.cidFor(chunks[0]).toString() === font.cidFor(chunks[45]).toString());
	check("different semantic clusters do not share CIDs",
		font.cidFor(chunks[0]).toString() !== font.cidFor(chunks[5]).toString());
	check("a different width gives the same Unicode its own CID",
		font.cidFor(chunks[0]).toString() !== font.cidFor(chunks[9]).toString());
	check("adjacent identical clusters alternate semantic CIDs",
		font.cidFor(chunks[43]).toString() !== font.cidFor(chunks[44]).toString());

	// Show all 45 CIDs, including repeated text and shared-width geometry, in
	// a single run. PDFium must read both the right Unicode and per-CID widths.
	const first = pdf.addPage([595, 842]);
	const key = first.node.newFontDictionary("TypsastraLogical", font.ref);
	plugin.drawInvisibleLogicalLine(first, key, font.cidsFor(chunks.slice(0, 45)),
		quad(), { width: 595, height: 842 }, plugin.advanceTotalFor(chunks.slice(0, 45)));
	const second = pdf.addPage([595, 842]);
	const key2 = second.node.newFontDictionary("TypsastraLogical", font.ref);
	plugin.drawInvisibleLogicalLine(second, key2,
		font.cidsFor([chunks[43], chunks[44], chunks[43]]),
		quad(), { width: 595, height: 842 },
		plugin.advanceTotalFor([chunks[43], chunks[44], chunks[43]]));
	fs.writeFileSync(path.join(out, "plu_reuse.pdf"), await pdf.save());
	console.log("Wrote reusable-GID PDFium probe for", count, "occurrences");

	// Check automatic font matching and the safe OCR timing fallback.
	globals.document = { createElement: () => ({ getContext: () => ({
		font: "", measureText(text) {
			return { width: text.length * (this.font.includes("TypsastraMissing") ? 1 : 2) };
		},
	}) }) };
	const sample = [{ unicode: "ស" }, { unicode: "ទ្ទា" }];
	const measured = plugin.measureShapedWidths(sample, "Khmer OS Muol");
	check("installed-font widths use whole-line prefix advances",
		measured && measured[1] > measured[0]);
	check("unknown source font uses OCR timing", plugin.measureShapedWidths(sample, null) === null);
	check("PDF subset name resolves to installed CSS family",
		plugin.fontFamilyForPdfName("OFWZZA+KhmerOSMuolLight") === "Khmer OS Muol Light");
	check("generic pdf.js font does not pretend to identify a Khmer face",
		plugin.fontFamilyForPdfName("sans-serif") === null);
	globals.document.createElement = () => ({ getContext: () => ({
		font: "", measureText(text) { return { width: text.length }; },
	}) });
	check("unavailable font falls back", plugin.measureShapedWidths(sample, "Khmer OS Muol") === null);

	// The real export path generates one independent font per page.
	globals.document.createElement = () => ({ getContext: () => ({
		font: "", measureText(text) {
			return { width: text.length * (this.font.includes("TypsastraMissing") ? 1 : 2) };
		},
	}) });
	const pagesPdf = await PDFLib.PDFDocument.create();
	function sourceAnchor(name) {
		return { fontSourceName: name, bounds: { left: 50, right: 500, top: 210, bottom: 240 },
			baselineStart: { x: 50, y: 240 }, baselineEnd: { x: 500, y: 240 }, height: 30 };
	}
	plugin.state.pages = [0, 1].map((index) => ({
		index, width: 595, height: 842, pdfWidth: 595, pdfHeight: 842,
		sourceTextAnchors: [sourceAnchor(index ? "BNTIUL+KhmerOSMuol" : "OFWZZA+KhmerOSMuolLight")],
		lines: [{ status: "accepted", rawText: "សទ្ទា", ctcContentLength: 3,
			units: [
				{ rawText: "ស", timestepStart: 0, timestepEnd: 1 },
				{ rawText: "ទ្ទា", timestepStart: 1, timestepEnd: 3 },
			], quad: quad(),
		}],
	}));
	plugin.state.pages[1].sourceTextAnchors = [sourceAnchor("sans-serif")];
	plugin.buildLogicalUnits();
	check("unknown second-page font falls back per line", plugin.state.widthStats.shaped === 1 &&
		plugin.state.widthStats.fallback === 1);
	plugin.state.pages[1].sourceTextAnchors = [sourceAnchor("BNTIUL+KhmerOSMuol")];
	plugin.state.pages.forEach(() => pagesPdf.addPage([595, 842]));
	await plugin.applyTextLayer(pagesPdf);
	check("matching source fonts selected automatically on both pages", plugin.state.widthStats.shaped === 2);
	fs.writeFileSync(path.join(out, "plu_pages.pdf"), await pagesPdf.save());
	console.log("Wrote two-page complete export-path probe");
})().catch((error) => { console.error(error); process.exitCode = 1; });
