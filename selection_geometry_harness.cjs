// Run with node selection_geometry_harness.cjs [engine.js engine.wasm source.pdf [scanned.pdf [invitation.pdf [invitation.rgba]]]].
// The optional PDF exercise uses the real editor selection-quad implementation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const window = { Asc: { plugin: {}, scope: { keep: "previous" } } };
const context = { window, console, Promise, setTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "code.js"), "utf8"), context);
const plugin = window.KhmerOcrPlugin;

const lines = [
	{ text: "សទទនុរកម", quads: [10, 20, 70, 20, 10, 30, 70, 30] },
	{ text: "ពកយចបប់", quads: [74, 20, 130, 20, 74, 30, 130, 30] },
	{ text: "next line", quads: [10, 42, 100, 42, 10, 52, 100, 52] },
	{ text: " ", quads: [10, 60, 100, 60, 10, 70, 100, 70] }
];
const image = { width: 840, height: 1190, rgba: new ArrayBuffer(840 * 1190 * 4) };
const page = { width: 420, height: 595, lines };

async function checkLazyDetector() {
	const worker = {
		URL, console, Promise, Uint8Array, Uint8ClampedArray, ArrayBuffer,
		navigator: { hardwareConcurrency: 1 },
		location: { href: "https://localhost/worker/ocr-worker.js" },
		postMessage: () => {}
	};
	worker.self = worker;
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "worker", "ocr-worker.js"), "utf8"), worker);
	const created = [];
	worker.ort = { InferenceSession: { create: async bytes => {
		const model = bytes[0] === 1 ? "recognizer" : "detector";
		created.push(model);
		return model === "recognizer" ? {
			inputNames: ["images", "widths"], outputNames: ["logits", "lengths"]
		} : { inputNames: ["x"], outputNames: ["fetch_name_0"] };
	} } };
	worker.ensureOrt = async () => {};
	worker.fetchModelManifest = async () => ({
		assets: {
			"vocab.json": { sha256: "c".repeat(64) },
			"detector_tiny.onnx": { sha256: "a".repeat(64) },
			"recognizer-int8.onnx": { sha256: "b".repeat(64) }
		}
	});
	worker.loadJson = async () => Array(4096).fill("");
	worker.loadArrayBuffer = async url => Uint8Array.of(url.includes("detector") ? 2 : 1);
	worker.recognizeDetections = async () => {};
	worker.detectPage = async () => [];
	await worker.initialize(undefined, undefined, 1);
	assert.deepEqual(created, ["recognizer"], "searchable PDFs must not load PP detection at startup");
	await worker.recognizePage({ page: 0, width: 1, height: 1,
		rgba: new ArrayBuffer(4), detections: [] }, 2, 0, 0);
	assert.deepEqual(created, ["recognizer"], "PDF selection crops bypass PP detection entirely");
	await worker.processPage({ page: 0, width: 1, height: 1, rgba: new ArrayBuffer(4) }, 3, 0, 0);
	assert.deepEqual(created, ["recognizer", "detector"], "image-only page lazily loads PP detection");
}

async function checkRealPdf(enginePath, wasmPath, pdfPath, scannedPath, invitationPath, rgbaPath) {
	const wasm = fs.readFileSync(wasmPath);
	let ready;
	const loaded = new Promise(resolve => { ready = resolve; });
	const editor = {
		console, WebAssembly, Uint8Array, Uint8ClampedArray, Int32Array,
		ArrayBuffer, DataView, TextDecoder, TextEncoder, Promise,
		setTimeout, clearTimeout, setInterval, clearInterval,
		navigator: { userAgent: "Chrome" },
		location: { protocol: "http:" },
		document: { currentScript: { src: "http://localhost/drawingfile.js" } },
		fetch: async () => new Response(wasm, { headers: { "Content-Type": "application/wasm" } }),
		AscViewer: { onLoadModule: () => ready() },
		AscCommon: { AscBrowser: {}, g_aPunctuation: {} },
		AscPDF: {}
	};
	editor.window = editor;
	editor.self = editor;
	vm.runInNewContext(fs.readFileSync(enginePath, "utf8"), editor, { filename: enginePath });
	await Promise.race([loaded, new Promise((_, reject) => setTimeout(() =>
		reject(new Error("Editor engine initialization timed out")), 30000))]);
	const sdkFile = path.join(__dirname, "..", "..", "sdkjs", "pdf", "src", "file.js");
	vm.runInNewContext(fs.readFileSync(sdkFile, "utf8"), editor, { filename: sdkFile });
	const pdf = fs.readFileSync(pdfPath);
	const file = editor.AscViewer.createFile(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength));
	assert(file && file.pages.length > 0, "source PDF must open in the editor");
	const page = file.pages[0];
	page.text = file.getText(page.originIndex);
	const sourceLines = file.copyPageTextWithQuads(0);
	assert(sourceLines.length >= 10, "source PDF should contain selectable line geometry");
	const image = { width: page.W * 2, height: page.H * 2 };
	const crops = plugin.selectionDetections({ width: page.W, height: page.H, lines: sourceLines }, image);
	assert(crops.length >= 10, "real editor selection lines should produce recognizer crops");
	assert(crops.length <= sourceLines.length);
	const title = sourceLines.find(line => line.text.includes("សទទនុរកម"));
	assert(title,
		"the original PDF should exhibit the broken Khmer extraction case");
	assert(title.quads.every((coordinate, index) => coordinate >= 0 &&
		coordinate <= (index % 2 ? page.H : page.W)),
		"selection geometry must be expressed in the editor's page dimensions");
	console.log(`Original PDF: ${sourceLines.length} selection runs -> ${crops.length} recognizer crops`);
	const glossaryPage = file.pages[2];
	glossaryPage.text = file.getText(glossaryPage.originIndex);
	const glossaryLines = file.copyPageTextWithQuads(2);
	const glossaryImage = { width: glossaryPage.W * 2, height: glossaryPage.H * 2 };
	const glossaryCrops = plugin.selectionDetections({ width: glossaryPage.W, height: glossaryPage.H,
		lines: glossaryLines }, glossaryImage);
	const english = glossaryCrops.find(crop => crop.sourceText.includes("Eng. active member"));
	const french = glossaryCrops.find(crop => crop.sourceText.includes("Fr.") && crop.sourceText.includes("membre actif"));
	assert(english && french && french.cropQuad, "overlapping English and French selection boxes must be separable");
	assert(french.cropQuad.p0.y >= (english.cropQuad || english.quad).p2.y - 1,
		"French crop must no longer include the English line above it");
	file.close();
	const pdfjs = await import(pathToFileURL(path.join(__dirname, "vendor", "pdfjs", "pdf.min.js")).href);
	pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(__dirname, "vendor", "pdfjs", "pdf.worker.min.js")).href;
	const source = await pdfjs.getDocument({ data: new Uint8Array(pdf), disableWorker: true }).promise;
	const sourcePage = await source.getPage(1);
	await sourcePage.getOperatorList();
	const textContent = await sourcePage.getTextContent();
	const viewport = sourcePage.getViewport({ scale: 2 });
	const anchors = plugin.pdfTextAnchors(textContent, viewport, pdfjs.Util, sourcePage);
	const titleQuad = plugin.selectionDetections({ width: page.W, height: page.H, lines: [title] }, image)[0].quad;
	assert.equal(plugin.sourceFontForLine({ sourceTextAnchors: anchors }, titleQuad), "Khmer OS Muol Light",
		"match the broken-Khmer title to its actual PDF embedded font name");
	console.log("Original PDF title font: Khmer OS Muol Light (automatic)");
	const glossaryPdfPage = await source.getPage(3);
	await glossaryPdfPage.getOperatorList();
	const glossaryContent = await glossaryPdfPage.getTextContent();
	const glossaryAnchors = plugin.pdfTextAnchors(glossaryContent,
		glossaryPdfPage.getViewport({ scale: 2 }), pdfjs.Util, glossaryPdfPage);
	assert.equal(plugin.extractedLatinLine(english, glossaryAnchors).rawText, "Eng. active member");
	assert.equal(plugin.extractedLatinLine(french, glossaryAnchors).rawText, "Fr. membre actif");
	const legacyKhmer = glossaryCrops.find(crop => crop.sourceText.includes("kmμiksmaCik"));
	assert(legacyKhmer && !plugin.extractedLatinLine(legacyKhmer, glossaryAnchors),
		"legacy Khmer encoded with Latin characters must still use OCR");
	console.log("Glossary page: Latin lines extracted directly; legacy Khmer stays in OCR");
	await source.destroy();
	if (scannedPath) {
		const bytes = fs.readFileSync(scannedPath);
		const scanned = editor.AscViewer.createFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		assert(scanned && scanned.pages.length > 0);
		const first = scanned.pages[0];
		first.text = scanned.getText(first.originIndex);
		const noText = scanned.copyPageTextWithQuads(0);
		assert.equal(noText.length, 0, "image-only pages should not supply text selection lines");
		assert.equal(plugin.selectionDetections({ width: first.W, height: first.H, lines: noText },
			{ width: first.W * 2, height: first.H * 2 }).length, 0);
		console.log("Scanned PDF: no selection runs -> PP detector fallback");
		scanned.close();
	}
	if (invitationPath) {
		const bytes = fs.readFileSync(invitationPath);
		const invite = editor.AscViewer.createFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		assert(invite && invite.pages.length > 0);
		const first = invite.pages[0];
		first.text = invite.getText(first.originIndex);
		const fragments = invite.copyPageTextWithQuads(0);
		const detections = plugin.selectionDetections({ width: first.W, height: first.H, lines: fragments },
			{ width: first.W * 2, height: first.H * 2 });
		const subject = detections.filter(item => Math.abs(item.quad.p0.y / 2 - 236.1) < 3);
		assert(fragments.length > 150 && detections.length < fragments.length / 3,
			"fragmented selectable Khmer runs should become full visual lines");
		assert(subject.length === 1 && (subject[0].quad.p1.x - subject[0].quad.p0.x) > 900,
			"the invitation subject must be one OCR crop, not many overlapping pieces");
		console.log(`Invitation PDF: ${fragments.length} text fragments -> ${detections.length} line crops`);
		if (rgbaPath) {
			const rgba = fs.readFileSync(rgbaPath);
			const height = first.H * 2;
			const width = rgba.length / (height * 4);
			assert(Number.isInteger(width), "RGBA raster must be 144 DPI and page-sized");
			const inkCrops = plugin.selectionDetections({ width: first.W, height: first.H, lines: fragments }, {
				width, height, rgba: rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)
			});
			const row = inkCrops.find(item => Math.abs(item.quad.p0.y / 2 - 288.4) < 3);
			assert(row && row.cropQuad && row.quad.p1.x / width * first.W > 580 &&
				row.cropQuad.p1.x / width * first.W < 560,
				"trim invitation selection to the rendered ink rather than font advance");
			console.log(`Invitation row right edge: advance ${(row.quad.p1.x / width * first.W).toFixed(1)}pt, ` +
				`ink ${(row.cropQuad.p1.x / width * first.W).toFixed(1)}pt`);
		}
		invite.close();
	}
}

async function main() {
	let getTextCalls = 0;
	const file = {
		pages: [{ W: 420, H: 595, originIndex: 0, text: null }],
		getText: () => { getTextCalls++; return Uint8Array.of(1); },
		copyPageTextWithQuads: () => lines
	};
	window.Asc.plugin.callCommand = (func, _close, _calc, callback) => {
		const scope = JSON.stringify(window.Asc.scope);
		const result = vm.runInNewContext(
			`var Asc = {scope: ${scope}}; (${func.toString()})()`,
			{ Api: { GetDocument: () => ({ Document: { GetFile: () => file } }) } }
		);
		callback(result);
	};
	const selection = await plugin.readSelectionGeometry(0);
	assert.equal(selection.width, 420);
	assert.equal(selection.lines.length, 4);
	assert.equal(window.Asc.scope.keep, "previous");
	assert.equal(window.Asc.scope.pageIndex, undefined);
	assert.equal(getTextCalls, 1, "load editor text for pages not yet viewed");

	const detections = plugin.selectionDetections(selection, image);
	assert.equal(detections.length, 2, "adjacent font runs share one recognizer crop");
	assert.deepEqual(JSON.parse(JSON.stringify(detections[0].quad)), {
		p0: { x: 20, y: 40 }, p1: { x: 260, y: 40 },
		p2: { x: 260, y: 60 }, p3: { x: 20, y: 60 }
	});
	const inkImage = { width: 840, height: 1190, rgba: new ArrayBuffer(840 * 1190 * 4) };
	const ink = new Uint8ClampedArray(inkImage.rgba);
	ink.fill(255);
	for (let y = 44; y < 56; y++) for (let x = 22; x < 225; x++) {
		const offset = (y * inkImage.width + x) * 4;
		ink[offset] = ink[offset + 1] = ink[offset + 2] = 0;
	}
	const trimmed = plugin.selectionDetections(selection, inkImage);
	assert(trimmed[0].cropQuad && trimmed[0].cropQuad.p1.x < 230 && trimmed[0].quad.p1.x === 260,
		"oversized PDF advances must not extend the actual OCR and highlight crop");
	assert.equal(plugin.selectionDetections(null, image).length, 0);
	assert.equal(plugin.selectionDetections({ width: 420, height: 595, lines: [] }, image).length, 0);
	assert.equal(plugin.selectionDetections({ ...page, rotation: 180 }, image).length, 0,
		"rotated pages must use the detector until their coordinate transform is verified");
	assert.equal(plugin.selectionDetections(page, { width: 1190, height: 840 }).length, 0,
		"rotated/mismatched page coordinates must fall back to detection");

	const messages = [];
	plugin.state.worker = { postMessage: message => messages.push(message) };
	const selectionJob = plugin.ocrPage(0, image, detections);
	assert.equal(messages[0].type, "recognize-page", "selection geometry skips PP detection");
	assert.equal(messages[0].detections.length, 2);
	plugin.state.pageWaiters[messages[0].requestId].resolve({ lines: [] });
	await selectionJob;
	const scannedJob = plugin.ocrPage(0, image, []);
	assert.equal(messages[1].type, "process-page", "scanned pages retain PP detection");
	plugin.state.pageWaiters[messages[1].requestId].resolve({ lines: [] });
	await scannedJob;
	await checkLazyDetector();
	if (process.argv.length > 2) {
		assert(process.argv.length >= 5 && process.argv.length <= 8,
			"provide engine.js engine.wasm source.pdf [scanned.pdf [invitation.pdf [invitation.rgba]]]");
		await checkRealPdf(...process.argv.slice(2));
	}
	console.log("Selection-geometry bridge, crop alignment, and fallback passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
