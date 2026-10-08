// Run with node selection_geometry_harness.cjs [engine.js engine.wasm source.pdf [scanned.pdf [invitation.pdf [invitation.rgba [certificate.pdf certificate.rgba]]]]].
// The optional PDF exercise uses the real editor selection-quad implementation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");

const window = { Asc: { plugin: {}, scope: { keep: "previous" } } };
const context = { window, console, Promise, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "code.js"), "utf8"), context);
const plugin = window.KhmerOcrPlugin;

function checkLatinSourceRestoration() {
	assert(plugin.isPluPdfMetadata({ Creator: plugin.pdfReconstructionTool,
		Producer: plugin.pdfReconstructionTool + " using pdf-lib 1.17.1" }));
	assert.equal(plugin.isPluPdfMetadata({ Creator: "Other editor", Producer: "pdf-lib" }), false,
		"arbitrary searchable PDFs must not be treated as PLU PDFs");
	const mixedSource = "អ៊ីមែល : www.mptc.gov.kh";
	const latinStart = mixedSource.indexOf("www.");
	const charWidth = character => /[\u1780-\u17FF]/.test(character) ? 2 : character === " " ? 0.5 : 1;
	const totalWidth = Array.from(mixedSource).reduce((sum, character) => sum + charWidth(character), 0);
	const anchors = plugin.pdfTextAnchors({ items: [{ str: mixedSource, transform: [1, 0, 0, 1, 0, 0],
		width: totalWidth, fontName: "test-font" }] }, { transform: [], scale: 1 },
		{ transform: () => [1, 0, 0, 10, 0, 20] }, { commonObjs: { get: () => ({
			name: "Arial", charsToGlyphs: text => Array.from(text).map(character => ({ width: charWidth(character) }))
		}) } });
	const anchor = anchors[0];
	const latinStartStep = anchor.characterFractions[latinStart] * 100;
	const units = [
		{ rawText: "អ៊ីមែល : ", timestepStart: 0, timestepEnd: latinStartStep },
		{ rawText: "Wwww.mptC.gov.kh", timestepStart: latinStartStep, timestepEnd: 100 }
	];
	const quad = { p0: { x: 0, y: 10 }, p1: { x: totalWidth, y: 10 },
		p2: { x: totalWidth, y: 20 }, p3: { x: 0, y: 20 } };
	const line = { units, rawText: units.map(unit => unit.rawText).join(""),
		alignmentQuad: quad, ctcContentLength: 100 };
	const detection = { quad };
	plugin.restoreSourceLatin(line, detection, anchors);
	assert.equal(line.rawText, "អ៊ីមែល : www.mptc.gov.kh",
		"mixed-script source runs should restore Latin text by glyph position");
	const wrongScriptLine = { rawText: "LEXICON DIGITAL TERMINOLOGY", units: [{ rawText: "LEXICON DIGITAL TERMINOLOGY" }], confidence: 0.99 };
	plugin.restoreNativeKhmerWhenOcrChangesScript(wrongScriptLine,
		{ sourceText: "សទា្ទនុ្រកមបេច្ចកសព្ទឌីជីថល" }, true);
	assert.equal(wrongScriptLine.rawText, "សទា្ទនុ្រកមបេច្ចកសព្ទឌីជីថល",
		"for a verified PLU, when OCR switches Khmer into Latin, prefer source script text");
	assert.equal(wrongScriptLine.confidence, null);
	const untrustedLayer = { rawText: "LEXICON DIGITAL TERMINOLOGY", units: [], confidence: 0.99 };
	plugin.restoreNativeKhmerWhenOcrChangesScript(untrustedLayer,
		{ sourceText: "សទា្ទនុ្រកមបេច្ចកសព្ទឌីជីថល" }, false);
	assert.equal(untrustedLayer.rawText, "LEXICON DIGITAL TERMINOLOGY",
		"do not trust ordinary PDF Khmer extraction without the PLU provenance marker");
	const plainLatinLine = { units: [{ rawText: "ServlceEntrance", timestepStart: 0, timestepEnd: 100 }],
		rawText: "Servlce Entrance", alignmentQuad: quad, ctcContentLength: 100 };
	plugin.restoreSourceLatin(plainLatinLine, { quad, sourceText: "Service Entrance" }, [{
		corruptText: "Service Entrance", fontSourceName: "UnlistedSubsetFont",
		bounds: { left: 0, right: 100, top: 0, bottom: 20 }
	}]);
	assert.equal(plainLatinLine.rawText, "Service Entrance",
		"OCR agreement should validate ordinary Latin source without a font-family allowlist");
	const khmerFontLine = { units: units.map(unit => ({ ...unit })), rawText: units.map(unit => unit.rawText).join(""),
		alignmentQuad: quad, ctcContentLength: 100 };
	plugin.restoreSourceLatin(khmerFontLine, detection, [{ ...anchor, fontSourceName: "KhmerOSSystem" }]);
	assert.equal(khmerFontLine.rawText, "អ៊ីមែល : www.mptc.gov.kh",
		"mixed Unicode Khmer/Latin runs should preserve Latin even when the PDF uses a Khmer family font");
	const officeQuad = { p0: { x: 0, y: 0 }, p1: { x: 100, y: 0 },
		p2: { x: 100, y: 20 }, p3: { x: 0, y: 20 } };
	const officeFontLine = { units: [
		{ rawText: "អ៊ីមែល ", timestepStart: 0, timestepEnd: 42 },
		{ rawText: ": info@mptc.gOv.kh", timestepStart: 42, timestepEnd: 100 }
	], rawText: "អ៊ីមែល : info@mptc.gOv.kh", alignmentQuad: officeQuad, ctcContentLength: 100 };
	plugin.restoreSourceLatin(officeFontLine, { quad: officeQuad }, [{
		corruptText: ": info@mptc.gov.kh", fontSourceName: "SomeCustomEmbeddedSubset",
		baselineStart: { x: 42, y: 10 }, baselineEnd: { x: 100, y: 10 },
		bounds: { left: 42, right: 100, top: 0, bottom: 20 }
	}]);
	assert.equal(officeFontLine.rawText, "អ៊ីមែល : info@mptc.gov.kh",
		"Office-embedded Latin source runs should preserve email spelling");
	const smallUrl = "https://go.gov.kh/mptc/lexicon-digital";
	const smallUrlLine = { id: 1, sourceText: smallUrl,
		quad: { p0: { x: 0, y: 0 }, p1: { x: 64, y: 0 },
			p2: { x: 64, y: 5 }, p3: { x: 0, y: 5 } },
		order: { region: 0, line: 1, position: 0 } };
	const directlyExtractedUrl = plugin.extractedLatinLine(smallUrlLine, [{
		corruptText: smallUrl, fontSourceName: "AnotherUnlistedEmbeddedFont",
		bounds: { left: 0, right: 64, top: 0, bottom: 5 }
	}]);
	assert.equal(directlyExtractedUrl.rawText, smallUrl,
		"small structured source text should be extracted directly instead of sent to Khmer OCR");
	const titleSource = "LEXICON DIGITAL TERMINOLOGY";
	const titleExtraction = plugin.extractedLatinLine({ id: 2, sourceText: titleSource,
		quad: { p0:{x:0,y:0}, p1:{x:100,y:0}, p2:{x:100,y:12}, p3:{x:0,y:12} },
		order:{region:0,line:2,position:0} }, [{ corruptText:titleSource,
		fontSourceName:"UnlistedKhmerSubset", bounds:{left:0,right:100,top:0,bottom:12} }]);
	assert.equal(titleExtraction.rawText, titleSource,
		"matching native source text and geometry should preserve ordinary Latin without a font list");
	const khmerCrop = { p0:{x:0,y:0}, p1:{x:100,y:0}, p2:{x:100,y:12}, p3:{x:0,y:12} };
	const subtitleLeak = { rawText:"LEXICON DGITAL TERMOLOGY",
		units:[{rawText:"LEXICON DGITAL TERMOLOGY",timestepStart:0,timestepEnd:100}],
		alignmentQuad:khmerCrop, ctcContentLength:100 };
	plugin.restoreSourceLatin(subtitleLeak, { quad:khmerCrop, cropQuad:khmerCrop }, [{
		corruptText:titleSource, fontSourceName:"UnknownSubset",
		baselineStart:{x:0,y:10}, baselineEnd:{x:100,y:10},
		bounds:{left:0,right:100,top:10,bottom:24}
	}]);
	assert.equal(subtitleLeak.rawText, "LEXICON DGITAL TERMOLOGY",
		"a neighboring subtitle with only a sliver of vertical overlap must not replace the Khmer crop");
	const legacyFont = [{ corruptText: "kmμiksmaCik", fontSourceName: "KhmerOS",
		bounds: { left: 42, right: 100, top: 0, bottom: 20 } }];
	const untouched = { units, rawText: units.map(unit => unit.rawText).join(""),
		alignmentQuad: quad, ctcContentLength: 100 };
	plugin.restoreSourceLatin(untouched, detection, legacyFont);
	assert.notEqual(untouched.rawText, "អ៊ីមែល : kmμiksmaCik",
		"legacy Khmer encoded as Latin characters must not be restored from source");
	console.log("Latin source-text preservation passed");
}

checkLatinSourceRestoration();

function checkInkGapCropSeparation() {
	const width = 30, height = 30;
	const rgba = new Uint8ClampedArray(width * height * 4);
	rgba.fill(255);
	for (const [top, bottom] of [[6, 13], [18, 25]]) {
		for (let y = top; y < bottom; y++) for (let x = 2; x < 28; x++) {
			const offset = (y * width + x) * 4;
			rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
		}
	}
	const detections = plugin.selectionDetections({ width, height, lines: [
		{ text: "Khmer line", quads: [0, 5, 30, 5, 0, 20, 30, 20] },
		{ text: "Latin subtitle", quads: [0, 10, 30, 10, 0, 25, 30, 25] }
	] }, { width, height, rgba: rgba.buffer });
	assert.equal(detections.length, 2, "overlapping font boxes on different baselines stay separate");
	assert(detections[0].cropQuad && detections[1].cropQuad);
	assert(detections[0].cropQuad.p2.y <= detections[1].cropQuad.p0.y,
		"use the rendered blank row to split overlapping selection boxes");
	const singleWidth = 40, singleHeight = 50;
	const singleRgba = new Uint8ClampedArray(singleWidth * singleHeight * 4);
	singleRgba.fill(255);
	for (let y = 16; y < 35; y++) for (let x = 6; x < 35; x++) {
		const offset = (y * singleWidth + x) * 4;
		singleRgba[offset] = singleRgba[offset + 1] = singleRgba[offset + 2] = 0;
	}
	const selectedLine = plugin.selectionDetections({ width:singleWidth, height:singleHeight, lines:[
		{text:"selected glyph line",quads:[5,20,35,20,5,30,35,30]}
	]}, {width:singleWidth,height:singleHeight,rgba:singleRgba.buffer})[0];
	assert(selectedLine.cropQuad.p0.y <= 15 && selectedLine.cropQuad.p3.y >= 35,
		"full-page OCR can expand a source box to visible ink");
	const manualLine = plugin.selectedDetections({width:singleWidth,height:singleHeight,
		quads:[[5,20,35,20,5,30,35,30]]},
		{width:singleWidth,height:singleHeight,rgba:singleRgba.buffer})[0];
	const manualCrop = manualLine.cropQuad || manualLine.quad;
	assert.equal(manualCrop.p0.y, 20);
	assert.equal(manualCrop.p3.y, 30,
		"manual selection must not include neighboring ink above or below its selected row");
	const pageLines = [
		{text:"preceding line",quads:[5,8,35,8,5,22,35,22]},
		{text:"selected line",quads:[5,20,35,20,5,30,35,30]},
		{text:"next line",quads:[5,25,35,25,5,38,35,38]}
	];
	plugin.attachSourceTextToRegions([manualLine], {width:singleWidth,height:singleHeight,lines:pageLines},
		{width:singleWidth,height:singleHeight,rgba:singleRgba.buffer});
	const pageCrop = plugin.selectionDetections({width:singleWidth,height:singleHeight,lines:pageLines},
		{width:singleWidth,height:singleHeight,rgba:singleRgba.buffer})[1].cropQuad;
	assert.equal(manualLine.sourceText, "selected line");
	assert.equal(manualLine.cropQuad.p3.y, Math.min(30, pageCrop.p3.y),
		"manual OCR should use the matching page line's neighbor-aware vertical bound");
	console.log("Ink-gap separation for overlapping text boxes passed");
}

checkInkGapCropSeparation();

function checkSevereBoxOverlapFallback() {
	const boxes = [
		{ p0:{x:0,y:100}, p1:{x:100,y:100}, p2:{x:100,y:135}, p3:{x:0,y:135} },
		{ p0:{x:5,y:118}, p1:{x:95,y:118}, p2:{x:95,y:137}, p3:{x:5,y:137} }
	];
	assert(plugin.hasSevereTextBoxOverlap(boxes.map(quad => ({ quad }))),
		"overlapping source text lines should select image-based page detection");
	assert.equal(plugin.hasSevereTextBoxOverlap([
		{ quad:boxes[0] }, { quad:{ p0:{x:0,y:145}, p1:{x:100,y:145}, p2:{x:100,y:160}, p3:{x:0,y:160} } }
	]), false, "separate source line boxes continue using their text geometry");
	console.log("Severe source-box overlap detection passed");
}

checkSevereBoxOverlapFallback();

async function checkFullPageLatinRestoration() {
	const source = fs.readFileSync(path.join(__dirname, "code.js"), "utf8");
	const marker = "})(window, undefined);";
	const probe = `
		window.runFullPageLatinProbe = function(anchor) {
			var quad = { p0: {x:0,y:10}, p1: {x:100,y:10},
				p2: {x:100,y:20}, p3: {x:0,y:20} };
			var detection = { id: 0, quad: quad, sourceText: 'អ៊ីមែល : www.mptc.gov.kh',
				order: { region: 0, line: 0, position: 0 } };
			setPageProgress = function() {};
			setStatus = function() {};
			renderPages = function() {};
		readSelectionGeometry = function() { return Promise.resolve({ width:420, height:595,
			lines:[{text:'អ៊ីមែល : www.mptc.gov.kh',quads:[10,20,60,20,10,30,60,30]}] }); };
			selectionDetections = function() { return [detection]; };
			selectionInkCoverage = function() { return 1; };
			extractedLatinLine = function() { return null; };
			ocrPage = function() { return Promise.resolve({ lines: [{ detectionId: 0,
				rawText: 'អ៊ីមែល : Wwww.mptC.gov.kh', units: [
					{rawText:'អ៊ីមែល : ', timestepStart:0, timestepEnd:42},
					{rawText:'Wwww.mptC.gov.kh', timestepStart:42, timestepEnd:100}
				], alignmentQuad:quad, ctcContentLength:100 }] }); };
			var image = { width:100, height:20, dataUrl:'data:image/png;base64,AA==',
				pdfWidth:100, pdfHeight:20, sourceTextAnchors:[anchor] };
			return processPage(0,0,1,{kind:'pdfjs',render:function(){ return Promise.resolve(image); }})
				.then(function(){ return state.pages[0].lines[0].rawText; });
		};
		window.runSmallSourceOnlyProbe = function(anchor) {
			state.pages = [];
			setPageProgress = function() {};
			setStatus = function() {};
			renderPages = function() {};
			readSelectionGeometry = function() { return Promise.resolve(null); };
			selectionDetections = function() { return []; };
			ocrPage = function() { return Promise.resolve({ lines: [] }); };
			var image = { width:100, height:20, dataUrl:'data:image/png;base64,AA==',
				pdfWidth:100, pdfHeight:20, sourceTextAnchors:[anchor] };
			return processPage(0,0,1,{kind:'pdfjs',render:function(){ return Promise.resolve(image); }})
				.then(function(){ return state.pages[0].lines.map(function(line){return line.rawText;}).join(''); });
		};
		window.runOverlapFallbackProbe = function() {
			state.pages = [];
			var calls = [];
			var boxes = [
				{p0:{x:0,y:100},p1:{x:100,y:100},p2:{x:100,y:135},p3:{x:0,y:135}},
				{p0:{x:5,y:118},p1:{x:95,y:118},p2:{x:95,y:137},p3:{x:5,y:137}}
			];
			var regions = boxes.map(function(quad,index) { return {id:index,quad:quad,
				sourceText:index ? 'English subtitle' : 'Khmer source line'}; });
			setPageProgress = function() {};
			setStatus = function() {};
			renderPages = function() {};
			readSelectionGeometry = function() { return Promise.resolve({}); };
			selectionDetections = function() { return regions; };
			selectionInkCoverage = function() { return 1; };
			extractedLatinLine = function() { return null; };
			ocrPage = function(index,image,detections) {
				calls.push(detections.length);
				return Promise.resolve({lines:[{rawText:'image-recognized lines',quad:boxes[0],units:[]} ]});
			};
			var image = {width:100,height:150,dataUrl:'data:image/png;base64,AA==',
				pdfWidth:100,pdfHeight:150,sourceTextAnchors:[],isPlu:false};
			return processPage(0,0,1,{kind:'pdfjs',render:function(){return Promise.resolve(image);}})
				.then(function(){return {calls:calls,geometry:state.pages[0].geometrySource};});
		};
	`;
	const probeWindow = { Asc: { plugin: {} } };
	const sandbox = { window: probeWindow, console, Promise, setTimeout, clearTimeout,
		atob: value => Buffer.from(value, "base64").toString("binary") };
	vm.runInNewContext(source.replace(marker, probe + marker), sandbox);
	const text = "អ៊ីមែល : www.mptc.gov.kh";
	const latinStart = text.indexOf("www.");
	const fractions = new Array(text.length + 1);
	for (let i = 0; i <= text.length; i++) fractions[i] = i <= latinStart
		? 0.42 * i / latinStart : 0.42 + 0.58 * (i - latinStart) / (text.length - latinStart);
	const anchor = { corruptText:text, fontSourceName:"Unknown Embedded Typeface", characterFractions:fractions,
		baselineStart:{x:0,y:15}, baselineEnd:{x:100,y:15},
		bounds:{left:0,right:100,top:10,bottom:20} };
	assert.equal(await probeWindow.runFullPageLatinProbe(anchor), "អ៊ីមែល : www.mptc.gov.kh",
		"Run OCR on the page should restore the source Latin run in mixed-script lines");
	const tinyUrl = "https://go.gov.kh/mptc/lexicon-digital";
	const tinyUrlQuad = { p0:{x:10,y:10}, p1:{x:90,y:10},
		p2:{x:90,y:15}, p3:{x:10,y:15} };
	assert.equal(await probeWindow.runSmallSourceOnlyProbe({ id:4, corruptText:tinyUrl,
		fontSourceName:"UnlistedEmbeddedFont", bounds:{left:10,right:90,top:10,bottom:15},
		baselineStart:{x:10,y:15}, baselineEnd:{x:90,y:15}, quad:tinyUrlQuad }), tinyUrl,
		"small structured Latin source text must be included even when the OCR detector misses it");
	const overlapFallback = await probeWindow.runOverlapFallbackProbe();
	assert.deepEqual(Array.from(overlapFallback.calls), [0],
		"full-page OCR should use image detection rather than overlapping source boxes");
	assert.match(overlapFallback.geometry, /overlapping source boxes/);
	console.log("Full-page mixed Khmer/Latin OCR restoration passed");
}

function checkSavedWorkerPreference() {
	const values = new Map();
	window.localStorage = {
		getItem: key => values.has(key) ? values.get(key) : null,
		setItem: (key, value) => values.set(key, value)
	};
	plugin.saveWorkerPreference(6);
	function openPlugin(storage) {
		const reopened = { Asc: { plugin: {} }, localStorage: storage };
		vm.runInNewContext(fs.readFileSync(path.join(__dirname, "code.js"), "utf8"),
			{ window: reopened, console, Promise, setTimeout, clearTimeout });
		return reopened.KhmerOcrPlugin.state.threads;
	}
	assert.equal(openPlugin(window.localStorage), 6, "reopening restores the saved worker count");
	values.set("typsastra.khmer-ocr.parallel-workers", "99");
	assert.equal(openPlugin(window.localStorage), 4, "invalid saved counts use the default");
	assert.equal(openPlugin({ getItem: () => { throw new Error("restricted storage"); } }), 4,
		"storage denial must not prevent plugin startup");
	window.localStorage = { getItem: () => null,
		setItem: () => { throw new Error("restricted storage"); } };
	assert.doesNotThrow(() => plugin.saveWorkerPreference(3),
		"saving must not interrupt OCR when local storage is denied");
	delete window.localStorage;
	console.log("Worker-count persistence and storage fallback passed");
}

async function checkSelectionCopyFlow() {
	const source = fs.readFileSync(path.join(__dirname, "code.js"), "utf8");
	const marker = "})(window, undefined);";
	const probe = `
		window.runSelectedCopyProbe = function(pages) {
			var copies = [], rendered = [], regionsSeen = [], destroyed = false;
			ensureWorker = function () { return Promise.resolve(); };
			readDocumentInfo = function () { return Promise.resolve({ sizes: [] }); };
			createPdfJsRenderer = function () { return Promise.resolve({
				render: function (index) {
					rendered.push(index);
					return Promise.resolve({ width: 840, height: 1190, sourceTextAnchors: [{
						corruptText: 'www.mptc.gov.kh', fontSourceName: 'Unknown Embedded Typeface',
						bounds: { left: 62, right: 120, top: 40, bottom: 60 }
					}] });
				}, destroy: function () { destroyed = true; }
			}); };
			readSelectionGeometry = function() { return Promise.resolve({ width:420, height:595,
				lines:[{text:'អ៊ីមែល : www.mptc.gov.kh',quads:[10,20,60,20,10,30,60,30]}] }); };
			ocrPage = function (index, image, regions) {
				regionsSeen.push({ page: index, regions: regions.length,
					width: regions[0].quad.p1.x - regions[0].quad.p0.x });
				var units = [
					{ rawText: 'អ៊ីមែល', timestepStart: 0, timestepEnd: 30 },
					{ rawText: ' ', timestepStart: 30, timestepEnd: 34 },
					{ rawText: ':', timestepStart: 34, timestepEnd: 38 },
					{ rawText: ' ', timestepStart: 38, timestepEnd: 42 },
					{ rawText: 'Wwww.mptC.gov.kh', timestepStart: 42, timestepEnd: 100 }
				];
				return Promise.resolve({ lines: [{ detectionId: regions[0].id,
					rawText: units.map(unit => unit.rawText).join(''), units: units,
					alignmentQuad: regions[0].quad, ctcContentLength: 100 }] });
			};
			copyRecognizedSelection = function (text) {
				copies.push(text); return Promise.resolve();
			};
			return window.Asc.plugin.event_onContextMenuClick({
				id: 'khmer-ocr-copy-selection', pages: pages
			}).then(function () {
				return { copies: copies, rendered: rendered, regions: regionsSeen,
					destroyed: destroyed, busy: state.running };
			});
		};
		window.copySelectedTextProbe = copyRecognizedSelection;
	`;
	const probeWindow = { Asc: { plugin: {} } };
	const sandbox = { window: probeWindow, console, Promise, setTimeout, clearTimeout,
		navigator: { clipboard: { writeText: text => { sandbox.copied = text; return Promise.resolve(); } } } };
	vm.runInNewContext(source.replace(marker, probe + marker), sandbox);
	assert.equal(typeof probeWindow.Asc.plugin.event_onContextMenuClick, "function",
		"the plugin must register the event_ callback used by ONLYOFFICE's event bridge");
	assert.equal(probeWindow.Asc.plugin.onContextMenuClick, undefined);
	await sandbox.window.copySelectedTextProbe("សួស្តី");
	assert.equal(sandbox.copied, "សួស្តី", "recognized text is written to clipboard");
	const quads = [[10, 20, 60, 20, 10, 30, 60, 30]];
	const result = await probeWindow.runSelectedCopyProbe([
		{ index: 1, width: 420, height: 595, rotation: 0, quads },
		{ index: 0, width: 420, height: 595, rotation: 0, quads }
	]);
	assert.deepEqual(Array.from(result.rendered), [0, 1]);
	assert.deepEqual(Array.from(result.copies), [
		"អ៊ីមែល : www.mptc.gov.kh\nអ៊ីមែល : www.mptc.gov.kh"
	]);
	assert.deepEqual(Array.from(result.regions, entry => ({ ...entry })), [
		{ page: 0, regions: 1, width: 100 }, { page: 1, regions: 1, width: 100 }
	]);
	assert(result.destroyed && !result.busy, "rendering resources and busy state are released");
	console.log("Selected-region recognition, page order and clipboard passed");
}

async function checkEditorClipboardBridge() {
	const editorWrites = [];
	const iframeWrites = [];
	const iframe = { Asc: { plugin: { executeMethod: (name, args, callback) => {
		assert.equal(name, "CopyKhmerOcrText");
		editorWrites.push(args[0]);
		callback(true);
	} } } };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "code.js"), "utf8"), {
		window: iframe, console, Promise,
		navigator: { clipboard: { writeText: text => {
			iframeWrites.push(text); return Promise.reject(new Error("iframe clipboard denied"));
		} } }
	});
	await iframe.KhmerOcrPlugin.copyRecognizedSelection("សួស្តី");
	assert.deepEqual(editorWrites, ["សួស្តី"]);
	assert.equal(iframeWrites.length, 0, "successful editor copy must not use iframe clipboard");
	console.log("Asynchronous OCR text copied through editor-frame clipboard bridge");
}

const lines = [
	{ text: "សទទនុរកម", quads: [10, 20, 70, 20, 10, 30, 70, 30] },
	{ text: "ពកយចបប់", quads: [74, 20, 130, 20, 74, 30, 130, 30] },
	{ text: "next line", quads: [10, 42, 100, 42, 10, 52, 100, 52] },
	{ text: " ", quads: [10, 60, 100, 60, 10, 70, 100, 70] }
];
const image = { width: 840, height: 1190, rgba: new ArrayBuffer(840 * 1190 * 4) };
const page = { width: 420, height: 595, lines };

async function checkLazyDetector() {
	const workerEvents = [];
	const worker = {
		URL, console, Promise, Uint8Array, Uint8ClampedArray, ArrayBuffer,
		navigator: { hardwareConcurrency: 1 },
		location: { href: "https://localhost/worker/ocr-worker.js" },
		postMessage: message => workerEvents.push(message)
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
	await worker.processPage({ page: 0, width: 1, height: 1, rgba: new ArrayBuffer(4) }, 4, 0, 0, true);
	assert(workerEvents.some(event => event.type === "detections-ready" && event.requestId === 4),
		"detector-only mode returns boxes for recognition in the parallel pool");
}

async function checkParallelWorkers() {
	const previousLocation = window.location;
	window.location = { href: "http://localhost/plugins/khmer-ocr/index.html", protocol: "http:" };
	context.URL = URL;
	context.navigator = { hardwareConcurrency: 8 };
	const detections = [0, 1, 2, 3, 4, 5, 6].map(id => ({ id, quad: {
		p0: { x: 10, y: id * 20 }, p1: { x: 50, y: id * 20 },
		p2: { x: 50, y: id * 20 + 10 }, p3: { x: 10, y: id * 20 + 10 }
	}, order: { region: 0, line: id, position: 0 } }));
	class FakeWorker {
		static instances = [];
		static wasmThreads = 1;
		constructor() { this.id = FakeWorker.instances.length; this.listeners = []; this.requests = [];
			this.terminated = false; FakeWorker.instances.push(this); }
		addEventListener(name, callback) { if (name === "message") this.listeners.push(callback); }
		emit(message) { this.listeners.forEach(callback => callback({ data: message })); }
		postMessage(message) {
			this.requests.push(message);
			if (message.type === "init") {
				setTimeout(() => this.emit({ type: "ready", requestId: message.requestId,
					wasm: { threads: FakeWorker.wasmThreads } }), 0);
			} else if (message.type === "detect-page") {
				setTimeout(() => this.emit({ type: "detections-ready", requestId: message.requestId,
					detections }), 0);
			} else if (message.type === "recognize-page") {
				const delay = this.id % 4 === 0 ? 15 : 1;
				setTimeout(() => {
					this.emit({ type: "recognition-progress", requestId: message.requestId,
						completed: message.detections.length, total: message.detections.length });
					this.emit({ type: "page-ready", requestId: message.requestId,
						lines: message.detections.map(item => ({ detectionId: item.id,
							rawText: String(item.id), quad: item.quad, order: item.order })) });
				}, delay);
			}
		}
		terminate() { this.terminated = true; }
	}
	context.Worker = FakeWorker;
	plugin.state.worker = null;
	plugin.state.pageWaiters = {};
	plugin.state.threads = 4;
	await plugin.ensureWorker();
	assert.equal(plugin.state.workers.length, 4, "desktop opens four single-thread recognizers");
	assert.equal(plugin.state.effectiveThreads, 4);
	let result = await plugin.ocrPage(0, image, detections);
	assert.deepEqual(Array.from(result.lines, line => line.detectionId), [0, 1, 2, 3, 4, 5, 6],
		"out-of-order worker completions must restore page reading order");
	assert.equal(plugin.state.parallelProgress, null);
	result = await plugin.ocrPage(0, image, []);
	assert.deepEqual(Array.from(result.lines, line => line.detectionId), [0, 1, 2, 3, 4, 5, 6],
		"scanned pages detect once and recognize across the worker pool");
	assert.equal(plugin.state.workers.filter(worker => worker.requests.some(req => req.type === "detect-page")).length, 1);

	const oldWorkers = plugin.state.workers.slice();
	plugin.state.threads = 2;
	plugin.resetWorker();
	await plugin.state.workerInitPromise;
	assert(oldWorkers.every(worker => worker.terminated), "changing the selector retires the previous pool");
	assert.equal(plugin.state.workers.length, 2, "new selector value controls the worker count");

	FakeWorker.wasmThreads = 4;
	plugin.state.threads = 4;
	plugin.resetWorker();
	await plugin.state.workerInitPromise;
	assert.equal(plugin.state.workers.length, 1, "isolated hosts use one multi-threaded WASM worker");
	assert.equal(plugin.state.effectiveThreads, 4);
	plugin.state.workers.forEach(worker => worker.terminate());
	plugin.state.workers = [];
	plugin.state.worker = null;
	window.location = previousLocation;
	console.log("Desktop worker pool, detection fallback, order and selector changes passed");
}

async function checkRealPdf(enginePath, wasmPath, pdfPath, scannedPath, invitationPath, rgbaPath,
	certificatePath, certificateRgbaPath) {
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
	editor.Asc = { editor: { getPDFDoc: () => ({ activeDrawing: null }) } };
	file.Selection = { IsSelection: true, quads: [], Page1: 0, Page2: 0,
		Line1: 3, Line2: 3, Glyph1: 0, Glyph2: 6 };
	const partial = file.getSelectionQuads();
	assert.equal(partial.length, 1);
	assert.equal(partial[0].page, 0);
	assert.equal(partial[0].quads.length, 1);
	assert(partial[0].quads[0][2] - partial[0].quads[0][0] <
		sourceLines[3].quads[2] - sourceLines[3].quads[0],
		"editor selection quads should isolate a glyph range within the original line");
	file.Selection.IsSelection = false;
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
			const coverage = plugin.selectionInkCoverage(inkCrops, {
				width, height, rgba: rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)
			});
			assert(coverage > 0.4, "genuine selectable invitation lines cover most page ink");
			const row = inkCrops.find(item => Math.abs(item.quad.p0.y / 2 - 288.4) < 3);
			assert(row && row.cropQuad && row.quad.p1.x / width * first.W > 580 &&
				row.cropQuad.p1.x / width * first.W < 560,
				"trim invitation selection to the rendered ink rather than font advance");
			console.log(`Invitation row right edge: advance ${(row.quad.p1.x / width * first.W).toFixed(1)}pt, ` +
				`ink ${(row.cropQuad.p1.x / width * first.W).toFixed(1)}pt`);
		}
		invite.close();
	}
	if (certificatePath && certificateRgbaPath) {
		const bytes = fs.readFileSync(certificatePath);
		const certificate = editor.AscViewer.createFile(bytes.buffer.slice(bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength));
		assert(certificate && certificate.pages.length === 1);
		const page = certificate.pages[0];
		page.text = certificate.getText(page.originIndex);
		const fragments = certificate.copyPageTextWithQuads(0);
		const raw = fs.readFileSync(certificateRgbaPath);
		const height = page.H * 2;
		const width = raw.length / (height * 4);
		assert(Number.isInteger(width));
		const image = { width, height,
			rgba: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) };
		const regions = plugin.selectionDetections({ width: page.W, height: page.H, lines: fragments }, image);
		const coverage = plugin.selectionInkCoverage(regions, image);
		console.log(`Lens certificate: ${fragments.length} phantom runs, ${(coverage * 100).toFixed(1)}% ink coverage`);
		assert(regions.length > 0 && coverage < 0.4,
			"garbled scanner text must trigger full-page image detection");
		certificate.close();
	}
}

async function main() {
	checkSavedWorkerPreference();
	await checkFullPageLatinRestoration();
	await checkSelectionCopyFlow();
	await checkEditorClipboardBridge();
	let getTextCalls = 0;
	const selectionQuads = [[10, 20, 60, 20, 10, 30, 60, 30]];
	const file = {
		pages: [{ W: 420, H: 595, originIndex: 0, text: null }],
		getText: () => { getTextCalls++; return Uint8Array.of(1); },
		copyPageTextWithQuads: () => lines,
		Selection: { IsSelection: true },
		getSelectionQuads: () => [{ page: 0, quads: selectionQuads }]
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
	const selected = await plugin.readSelectedQuads();
	assert.equal(selected[0].quads.length, 1, "the PDF exposes the exact selected region");
	const selectionCrops = plugin.selectedDetections(selected[0], image);
	assert.equal(selectionCrops.length, 1);
	assert.equal(selectionCrops[0].quad.p1.x, 120,
		"selected-region OCR must stop at the selected glyph, not the full PDF line");
	file.Selection.IsSelection = false;
	assert.equal((await plugin.readSelectedQuads()).length, 0,
		"no selected PDF text cannot produce OCR regions");
	file.Selection.IsSelection = true;

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
	await checkParallelWorkers();
	if (process.argv.length > 2) {
		assert(process.argv.length >= 5 && process.argv.length <= 10,
			"provide engine.js engine.wasm source.pdf [scanned.pdf [invitation.pdf [invitation.rgba [certificate.pdf certificate.rgba]]]]");
		await checkRealPdf(...process.argv.slice(2));
	}
	console.log("Selection-geometry bridge, crop alignment, and fallback passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
