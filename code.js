/*
 * Khmer OCR — PDF editor plugin.
 *
 * Runs browser-local Khmer OCR over the open PDF, lists the recognized lines in
 * the side panel so each one can be accepted or rejected, and exports a PLU
 * (PDF Logical Unit) file: the original page appearance flattened to an image
 * plus an invisible Type0/CID Unicode text layer with per-chunk ToUnicode
 * mappings.
 *
 * Text editing is intentionally disabled in this version.
 */

(function (window, undefined) {
	"use strict";

	var WORKER_URL = "worker/ocr-worker.js";
	var WORKER_VERSION = "pdf-parallel-workers-17";
	// Bump whenever code.js changes, and keep it in step with the ?v= query in
	// index.html/config.json. A stale WebView cache silently keeps the old build,
	// so the running build is shown in the panel header.
	var PLUGIN_BUILD = "selection-crop-48";
	var COPY_SELECTION_MENU_ID = "khmer-ocr-copy-selection";
	var PARALLELISM_KEY = "typsastra.khmer-ocr.parallel-workers";

	function readWorkerPreference() {
		try {
			var value = Number(window.localStorage.getItem(PARALLELISM_KEY));
			if (Number.isInteger(value) && value >= 1 && value <= 8) return value;
		} catch (error) {
			// Local storage may be unavailable in a restricted plugin host.
		}
		return 4;
	}

	function saveWorkerPreference(value) {
		try {
			window.localStorage.setItem(PARALLELISM_KEY, String(value));
		} catch (error) {
			// The chosen value still applies for the current plugin session.
		}
	}

	var RASTER_MAX_SIDE = 1800;
	var REVIEW_CONFIDENCE = 0.82;

	// Khmer subscript coengs (្, ុ, ា and the subjoined consonants they pull down)
	// hang well below the baseline, and the upper vowel marks (ិ ី ឹ and the
	// prepended vowels) reach well above it, so a box built with Descent 0 stops
	// at the baseline and cuts through the glyphs. Measured against the real ink
	// on a sample page, the worst line needs roughly 81% of its box height above
	// the baseline and 32% below. One split has to serve Khmer and Latin alike, so
	// this leans toward the ascent: the tall upper marks are the part that was
	// still clipping, while the descent only needs enough to clear the coengs.
	// Must sum to 1000, since the font box is 1 em and the size that sets the box
	// height is derived from it.
	var LOGICAL_ASCENT = 740;
	var LOGICAL_DESCENT = 260;
	// Legacy fallback when a detector line has no explicit placement override.
	var LOGICAL_BOX_GROWTH = 1.38;
	// Growth for an OCR bounding box. quadForDetectorBox moves the origin 0.26 of
	// the box height above the box bottom, so verticalLength spans the remaining
	// 0.74 of the ascent; this factor turns that into a glyph box exactly one box
	// height tall, which makes the reported selection coincide with the box the
	// detector produced instead of sitting 0.169H below its centre.
	var LOGICAL_ASCENT_GROWTH = 1000 / LOGICAL_ASCENT;

	var PDF_RECONSTRUCTION_TOOL = "Typsastra Khmer Document Reconstruction";
	var PDF_RECONSTRUCTION_URL = "https://ocr.typsastra.com/";
	var PDF_RECONSTRUCTION_DESCRIPTION =
		"Reconstructed by Typsastra. Original page appearance is preserved as raster images; " +
		"the searchable Unicode text layer was generated with browser-local Khmer OCR and explicit review decisions.";

	var state = {
		worker: null,
		workers: [],
		workerSourcePromise: null,
		workerReady: false,
		workerError: null,
		workerInitPromise: null,
		engineMessage: "",
		readyWaiters: {},
		pageWaiters: {},
		parallelProgress: null,
		requestId: 0,
		running: false,
		pages: [],
		status: "Ready",
		previewMode: "lines",
		widthStats: null,
		threads: readWorkerPreference(),
		effectiveThreads: 0,
		pdfjs: null,
		pdfjsPromise: null,
		rendererError: "",
		usedPdfJs: false,
		cancelRequested: false,
		runBase: 0,
		runSpan: 1
	};

	var el = {};

	/* ------------------------------------------------------------------ utils */

	function byId(id) {
		return document.getElementById(id);
	}

	function setStatus(text) {
		state.status = text;
		if (el.statusText) el.statusText.textContent = text;
	}

	function describeOcrError(error) {
		var message = error && error.message ? error.message : String(error);
		if (/does not support pdf input/i.test(message))
			return "The OCR model reads rendered page images, not PDF files. This PDF could not be rendered as an image; check that it opens in the editor.";
		return message;
	}

	function setProgress(fraction, text) {
		if (!el.progressWrap) return;
		var visible = fraction != null;
		el.progressWrap.hidden = !visible;
		if (!visible) return;
		var clamped = Math.max(0, Math.min(1, fraction));
		el.progressFill.style.width = (clamped * 100).toFixed(1) + "%";
		if (text != null) el.progressText.textContent = text;
	}

	/**
	 * Progress within the page currently being processed, mapped onto the overall
	 * run so the bar accumulates across pages.
	 */
	function setPageProgress(fraction, text) {
		var base = state.runBase || 0;
		var span = state.runSpan || 1;
		setProgress(base + span * Math.max(0, Math.min(1, fraction)), text);
	}

	function setEngine(kind, text) {
		if (!el.engine) return;
		el.engine.classList.remove("is-ready", "is-busy", "is-error");
		if (kind) el.engine.classList.add("is-" + kind);
		if (text != null) el.engineText.textContent = text;
	}

	function setNotice(text) {
		if (!el.notice) return;
		el.notice.hidden = !text;
		el.notice.textContent = text || "";
	}

	function copyTextFallback(text) {
		try {
			var area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "true");
			area.style.position = "fixed";
			area.style.top = "-1000px";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			document.execCommand("copy");
			document.body.removeChild(area);
			setStatus("Copied.");
		} catch (error) {
			setStatus("Copy failed.");
		}
	}

	function copyText(text) {
		if (!text) {
			setStatus("Nothing to copy.");
			return;
		}
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(function () {
				setStatus("Copied.");
			}).catch(function () {
				copyTextFallback(text);
			});
			return;
		}
		copyTextFallback(text);
	}

	function pageText(page) {
		return page.lines
			.filter(function (line) { return line.status !== "rejected"; })
			.map(function (line) { return line.rawText || ""; })
			.join("\n");
	}

	function buildCopyButton(text, title) {
		var button = document.createElement("button");
		button.type = "button";
		button.className = "copy";
		button.textContent = "Copy";
		button.title = title;
		button.addEventListener("click", function (event) {
			event.stopPropagation();
			copyText(typeof text === "function" ? text() : text);
		});
		return button;
	}

	function updateButtons() {
		var hasPages = state.pages.length > 0;
		var busy = state.running;
		if (el.btnRun) el.btnRun.disabled = busy || !state.workerReady;
		if (el.btnRunPage) el.btnRunPage.disabled = busy || !state.workerReady;
		if (el.btnStop) el.btnStop.hidden = !busy;
		if (el.btnSave) el.btnSave.disabled = busy || !hasPages;
		if (el.btnClear) el.btnClear.disabled = busy || !hasPages;
		if (el.threadsSelect) el.threadsSelect.disabled = busy ||
			(!state.workerReady && !state.workerError);
		if (el.toolbar) el.toolbar.hidden = !hasPages;
		if (el.empty) el.empty.hidden = hasPages;
	}

	function updateSummary() {
		if (!el.summary) return;
		var total = 0;
		var rejected = 0;
		state.pages.forEach(function (page) {
			page.lines.forEach(function (line) {
				total++;
				if (line.status === "rejected") rejected++;
			});
		});
		el.summary.textContent = total
			? total + " line" + (total === 1 ? "" : "s") + " · " + rejected + " rejected"
			: "No text detected";
	}

	/* ----------------------------------------------------------- plugin bridge */

	function pluginMethod(name, params) {
		return new Promise(function (resolve, reject) {
			if (!window.Asc || !window.Asc.plugin || typeof window.Asc.plugin.executeMethod !== "function") {
				reject(new Error("Plugin API is unavailable"));
				return;
			}
			try {
				window.Asc.plugin.executeMethod(name, params || [], function (result) {
					resolve(result);
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	function callCommand(func) {
		return new Promise(function (resolve, reject) {
			if (!window.Asc || !window.Asc.plugin || typeof window.Asc.plugin.callCommand !== "function") {
				reject(new Error("Document Builder API is unavailable"));
				return;
			}
			try {
				window.Asc.plugin.callCommand(func, false, false, function (result) {
					resolve(result);
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	/**
	 * Reads the document page count and page sizes.
	 *
	 * The count comes from the public Document Builder API. Page sizes are read
	 * best-effort from the underlying PDF file and expressed in points; when the
	 * internal file object is not reachable they fall back to the rendered image
	 * geometry (96 DPI, i.e. 0.75 points per pixel).
	 */
	function readDocumentInfo() {
		return callCommand(function () {
			var doc = Api.GetDocument();
			var info = { count: doc.GetPagesCount(), sizes: [] };
			try {
				var file = doc.Document.GetFile();
				for (var i = 0; i < file.pages.length; i++) {
					var page = file.pages[i];
					// W/H are already PDF points: the editor rasterizes them as
					// W * (25.4/72) * (96/25.4) pixels in GetPageImage.
					info.sizes.push({
						width: page.W,
						height: page.H,
						rawWidth: page.W,
						rawHeight: page.H,
						dpi: page.Dpi || 72
					});
				}
			} catch (error) {
				info.sizes = [];
			}
			return JSON.stringify(info);
		}).then(function (result) {
			var info = null;
			if (typeof result === "string" && result) {
				try { info = JSON.parse(result); } catch (error) { info = null; }
			}
			if (!info || !info.count) {
				throw new Error("Could not determine the number of pages");
			}
			return info;
		});
	}

	/**
	 * Read the same per-line quads that the PDF editor uses for selection. The
	 * copied text may be corrupt (legacy Khmer font encodings), but its geometry
	 * still locates the visible ink. Asc.scope carries the page index into the
	 * editor's separate Document Builder execution context.
	 */
	function readSelectionGeometry(pageIndex) {
		var previousScope = window.Asc.scope;
		window.Asc.scope = Object.assign({}, previousScope || {}, { pageIndex: pageIndex });
		var request;
		try {
			request = callCommand(function () {
				try {
					var file = Api.GetDocument().Document.GetFile();
					var index = Asc.scope.pageIndex;
					if (!file || !file.pages || !file.pages[index] ||
						typeof file.copyPageTextWithQuads !== "function") return null;
					var page = file.pages[index];
					if (!page.text && page.originIndex != null && typeof file.getText === "function") {
						page.text = file.getText(page.originIndex);
					}
					return JSON.stringify({
						width: page.W,
						height: page.H,
						rotation: page.Rotate || 0,
						lines: file.copyPageTextWithQuads(index)
					});
				} catch (error) {
					return null;
				}
			});
		} finally {
			window.Asc.scope = previousScope;
		}
		return request.then(function (result) {
			if (typeof result !== "string") return null;
			try { return JSON.parse(result); } catch (error) { return null; }
		}).catch(function () { return null; });
	}

	/** Snapshot a text selection before the context menu click can change it. */
	function readSelectedQuads() {
		return callCommand(function () {
			try {
				var file = Api.GetDocument().Document.GetFile();
				if (!file || !file.Selection || !file.Selection.IsSelection ||
					typeof file.getSelectionQuads !== "function") return null;
				var selected = file.getSelectionQuads();
				var pages = selected.map(function (entry) {
					var page = file.pages[entry.page];
					return page && { index: entry.page, width: page.W, height: page.H,
						rotation: page.Rotate || 0, quads: entry.quads };
				}).filter(Boolean);
				return JSON.stringify(pages);
			} catch (error) { return null; }
		}).then(function (result) {
			try { return typeof result === "string" ? JSON.parse(result) : []; }
			catch (error) { return []; }
		});
	}

	function selectedDetections(selection, image) {
		if (!selection || !Array.isArray(selection.quads)) return [];
		return selectionDetections({ width: selection.width, height: selection.height,
			rotation: selection.rotation, lines: selection.quads.map(function (quad) {
				return { text: "ក", quads: quad };
			}) }, image, true).sort(function (a, b) {
			return quadBounds(a.quad).top - quadBounds(b.quad).top ||
			quadBounds(a.quad).left - quadBounds(b.quad).left;
		});
	}

	function attachSourceTextToRegions(regions, selection, image) {
		var sourceLines = selectionDetections(selection, image);
		regions.forEach(function (region) {
			var bounds = quadBounds(region.quad);
			var area = Math.max(1, (bounds.right - bounds.left) * (bounds.bottom - bounds.top));
			var centerY = (bounds.top + bounds.bottom) / 2;
			var best = null;
			var bestOverlap = 0;
			sourceLines.forEach(function (sourceLine) {
				var sourceBounds = quadBounds(sourceLine.quad);
				var sourceHeight = sourceBounds.bottom - sourceBounds.top;
				var overlapY = Math.max(0, Math.min(bounds.bottom, sourceBounds.bottom) -
					Math.max(bounds.top, sourceBounds.top));
				if (overlapY < Math.min(bounds.bottom - bounds.top, sourceHeight) * 0.5) return;
				var overlap = Math.max(0, Math.min(bounds.right, sourceBounds.right) -
					Math.max(bounds.left, sourceBounds.left)) *
					overlapY;
				var ratio = overlap / Math.min(area, Math.max(1,
					(sourceBounds.right - sourceBounds.left) * (sourceBounds.bottom - sourceBounds.top)));
				ratio -= Math.abs(centerY - (sourceBounds.top + sourceBounds.bottom) / 2) /
					Math.max(1, Math.min(bounds.bottom - bounds.top, sourceHeight)) * 0.15;
				if (ratio > bestOverlap && sourceLine.sourceText) {
					best = sourceLine;
					bestOverlap = ratio;
				}
			});
			if (best && bestOverlap >= 0.35) {
				region.sourceText = best.sourceText;
				// Preserve the user's horizontal selection, but use the page line's
				// neighbor-aware vertical crop so the recognizer cannot read the
				// following line through its built-in crop padding.
				if (best.cropQuad && Math.abs(bounds.top - quadBounds(best.quad).top) <
					Math.max(3, bounds.bottom - bounds.top) * 0.25) {
					var selected = quadBounds(region.cropQuad || region.quad);
					var sourceCrop = quadBounds(best.cropQuad);
					var top = Math.max(selected.top, sourceCrop.top);
					var bottom = Math.min(selected.bottom, sourceCrop.bottom);
					if (bottom - top >= (selected.bottom - selected.top) * 0.4) {
						region.cropQuad = {
							p0: { x: selected.left, y: top }, p1: { x: selected.right, y: top },
							p2: { x: selected.right, y: bottom }, p3: { x: selected.left, y: bottom }
						};
					}
				}
			}
		});
		return regions;
	}

	function documentName() {
		var info = window.Asc && window.Asc.plugin && window.Asc.plugin.info;
		var name = info && (info.docTitle || info.documentTitle || info.title);
		if (name && typeof name === "string") return name.replace(/\.[^.]+$/, "");
		return "document";
	}

	/* ------------------------------------------------------------- image input */

	function decodeDataUrl(dataUrl, expectedAspect) {
		return new Promise(function (resolve, reject) {
			var image = new Image();
			image.onload = function () {
				var width = image.naturalWidth || image.width;
				var height = image.naturalHeight || image.height;
				if (!width || !height) {
					reject(new Error("Page image has no dimensions"));
					return;
				}
				// The editor can return a raster whose aspect ratio does not match
				// the page box (e.g. a 420x595pt page returned as 420x1800). That
				// stretches the glyphs and destroys recognition, so re-proportion
				// the raster to the page's real aspect ratio before OCR.
				var targetWidth = width;
				if (expectedAspect && Number.isFinite(expectedAspect) && expectedAspect > 0) {
					var actualAspect = width / height;
					if (Math.abs(actualAspect - expectedAspect) / expectedAspect > 0.02) {
						targetWidth = Math.max(1, Math.round(height * expectedAspect));
					}
				}

				var canvas = document.createElement("canvas");
				canvas.width = targetWidth;
				canvas.height = height;
				var context = canvas.getContext("2d");
				context.fillStyle = "#ffffff";
				context.fillRect(0, 0, targetWidth, height);
				context.drawImage(image, 0, 0, targetWidth, height);
				var source = context.getImageData(0, 0, targetWidth, height).data;
				var rgba = new Uint8ClampedArray(targetWidth * height * 4);
				rgba.set(source);
				resolve({
					width: targetWidth,
					height: height,
					rgba: rgba.buffer,
					dataUrl: targetWidth === width ? dataUrl : canvas.toDataURL("image/png")
				});
			};
			image.onerror = function () {
				reject(new Error("Could not decode the page image returned by the editor"));
			};
			image.src = dataUrl;
		});
	}

	function dataUrlToBytes(dataUrl) {
		var comma = dataUrl.indexOf(",");
		var meta = comma >= 0 ? dataUrl.slice(0, comma) : "";
		var payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
		var binary;
		if (meta.indexOf("base64") >= 0) {
			binary = atob(payload);
		} else {
			binary = decodeURIComponent(payload);
		}
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	/* ------------------------------------------------------------------ worker */

	function pluginBaseUrl() {
		return new URL(".", window.location.href).href;
	}

	function resourceBase() {
		var base = pluginBaseUrl();
		// The desktop app serves plugins from file:// pages, where fetch() and
		// local Worker scripts are restricted. Local files are exposed through
		// the ascdesktop:// scheme instead.
		if (window.location.protocol === "file:" && base.indexOf("file:///") === 0) {
			return "ascdesktop://fonts/" + base.substring(8);
		}
		return base;
	}

	function resourceUrl(path) {
		return new URL(path, resourceBase()).href;
	}

	function loadText(url) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open("GET", url, true);
			xhr.onload = function () {
				if (xhr.responseText && (xhr.status === 200 || xhr.status === 0)) {
					resolve(xhr.responseText);
				} else {
					reject(new Error("Unable to load " + url + " (status " + xhr.status + ")"));
				}
			};
			xhr.onerror = function () { reject(new Error("Unable to load " + url)); };
			xhr.send(null);
		});
	}

	function loadBinaryAsset(url) {
		return new Promise(function (resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open("GET", url, true);
			xhr.responseType = "arraybuffer";
			xhr.onload = function () {
				if (xhr.response && (xhr.status === 200 || xhr.status === 0)) {
					resolve(new Uint8Array(xhr.response));
				} else {
					reject(new Error("Unable to load " + url + " (status " + xhr.status + ")"));
				}
			};
			xhr.onerror = function () { reject(new Error("Unable to load " + url)); };
			xhr.send(null);
		});
	}

	function createWorker() {
		var directUrl = new URL(WORKER_URL, window.location.href).href;
		var query = "?v=" + WORKER_VERSION + "&threads=" + state.threads;
		if (window.location.protocol !== "file:") {
			try {
				return Promise.resolve(new Worker(directUrl + query));
			} catch (error) {
				// Fall through to the Blob worker below.
			}
		}
		// Blob worker: works from file:// pages and lets us inject the absolute
		// resource base the worker must use to reach its models and ONNX Runtime.
		// The base is the worker folder (the worker resolves assets relative to
		// itself), not the plugin root.
		var workerBase = resourceUrl("worker/");
		if (!state.workerSourcePromise) {
			state.workerSourcePromise = loadText(workerBase + "ocr-worker.js").catch(function (error) {
				state.workerSourcePromise = null;
				throw error;
			});
		}
		return state.workerSourcePromise.then(function (source) {
			var preamble = "self.__KHMER_OCR_BASE__ = " + JSON.stringify(workerBase) + ";\n" +
				"self.__KHMER_OCR_LOCAL__ = true;\n" +
				"self.__KHMER_OCR_THREADS__ = " + JSON.stringify(state.threads) + ";\n";
			var blob = new Blob([preamble + source], { type: "text/javascript" });
			var url = URL.createObjectURL(blob);
			try {
				var worker = new Worker(url);
				worker._ocrBlobUrl = url;
				return worker;
			} catch (error) {
				URL.revokeObjectURL(url);
				throw error;
			}
		});
	}

	function terminateWorker(worker) {
		try { worker.terminate(); } catch (ignore) {}
		if (worker._ocrBlobUrl) {
			URL.revokeObjectURL(worker._ocrBlobUrl);
			worker._ocrBlobUrl = null;
		}
	}

	function resetWorker() {
		rejectPending(new Error("OCR worker restarted"));
		state.workers.forEach(terminateWorker);
		state.workers = [];
		state.worker = null;
		state.workerReady = false;
		state.workerError = null;
		state.workerInitPromise = null;
		state.engineMessage = "";
		state.effectiveThreads = 0;
		state.parallelProgress = null;
		updateButtons();
		setEngine("", "starting engine…");
		setStatus("Starting OCR engine…");
		ensureWorker().catch(function () {
			// ensureWorker already reports the failure.
		});
	}

	function startWorker() {
		return createWorker().then(function (worker) {
			state.workers.push(worker);
			if (!state.worker) state.worker = worker;
			return new Promise(function (resolve, reject) {
				var requestId = ++state.requestId;
				var settled = false;
				var timeout = setTimeout(function () {
					var waiter = state.readyWaiters[requestId];
					if (waiter) waiter.reject(new Error("OCR engine initialization timed out (" +
						(state.engineMessage || "no progress reported") + ")"));
				}, 120000);
				function finish(error, info) {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					delete state.readyWaiters[requestId];
					if (error) {
						terminateWorker(worker);
						reject(error);
					} else {
						worker._khmerOcrReady = true;
						resolve(info);
					}
				}
				state.readyWaiters[requestId] = {
					resolve: function (info) { finish(null, info); },
					reject: function (error) { finish(error); }
				};
				worker.addEventListener("message", onWorkerMessage);
				worker.addEventListener("error", function (event) {
					var error = new Error(event && event.message ? event.message : "OCR worker error");
					if (!worker._khmerOcrReady) {
						finish(error);
						return;
					}
					state.workerReady = false;
					state.workerError = error;
					rejectPending(error);
					setEngine("error", "engine failed");
					setStatus("OCR engine failed: " + error.message);
					updateButtons();
				});
				worker.postMessage({ type: "init", requestId: requestId });
			});
		});
	}

	function ensureWorker() {
		if (state.workerReady) return Promise.resolve();
		if (state.workerError) return Promise.reject(state.workerError);
		if (state.workerInitPromise) return state.workerInitPromise;
		setEngine("busy", "loading OCR models…");
		setStatus("Loading OCR engine…");
		state.workerInitPromise = startWorker().then(function (primary) {
			if (primary.wasm && primary.wasm.threads > 1 || state.threads === 1) return primary;
			var concurrency = navigator.hardwareConcurrency || state.threads;
			var count = Math.max(1, Math.min(state.threads, concurrency));
			var starters = [];
			for (var i = 1; i < count; i++) {
				starters.push(startWorker().catch(function (error) {
					console.warn("An OCR worker could not start", error);
					return null;
				}));
			}
			return Promise.all(starters).then(function () { return primary; });
		}).then(function (primary) {
			state.workers = state.workers.filter(function (worker) { return worker._khmerOcrReady; });
			state.effectiveThreads = primary.wasm && primary.wasm.threads > 1
				? primary.wasm.threads : state.workers.length;
			var mode = state.workers.length > 1 ? "workers" : "worker";
			if (primary.wasm && primary.wasm.threads > 1) mode = "WASM threads";
			if (el.parallelLabel) el.parallelLabel.textContent =
				mode === "WASM threads" ? "WASM threads" : "Parallel workers";
			var label = state.effectiveThreads + " " + mode;
			setEngine("ready", "engine ready · " + label);
			setStatus("OCR engine ready (" + label + ")");
			state.workerReady = true;
			state.workerError = null;
			updateButtons();
		}).catch(function (error) {
			state.workers.forEach(terminateWorker);
			state.workers = [];
			state.worker = null;
			state.workerError = error;
			state.workerInitPromise = null;
			setEngine("error", "engine failed");
			setStatus("OCR engine failed: " + (error && error.message ? error.message : String(error)));
			updateButtons();
			throw error;
		});
		return state.workerInitPromise;
	}

	function rejectPending(error) {
		Object.keys(state.pageWaiters).forEach(function (key) {
			var waiter = state.pageWaiters[key];
			delete state.pageWaiters[key];
			waiter.reject(error);
		});
		Object.keys(state.readyWaiters).forEach(function (key) {
			state.readyWaiters[key].reject(error);
		});
	}

	function onWorkerMessage(event) {
		var message = event.data;
		if (!message || typeof message !== "object") return;

		switch (message.type) {
			case "ready":
				if (state.readyWaiters[message.requestId])
					state.readyWaiters[message.requestId].resolve(message);
				break;
			case "engine-progress":
				state.engineMessage = message.message || message.stage || "working…";
				setEngine("busy", state.engineMessage);
				setStatus(state.engineMessage);
				break;
			case "page-state":
				if (message.page != null && message.state) {
					setStatus("Page " + (message.page + 1) + ": " + message.state);
				} else if (message.state === "initializing") {
					setStatus("Initializing OCR engine…");
				}
				break;
			case "detection-progress":
				setPageProgress(0, "Detecting text…");
				break;
			case "recognition-progress":
				if (state.parallelProgress &&
					Object.prototype.hasOwnProperty.call(state.parallelProgress.completed, message.requestId)) {
					state.parallelProgress.completed[message.requestId] = message.completed || 0;
					var finished = Object.keys(state.parallelProgress.completed).reduce(function (total, key) {
						return total + state.parallelProgress.completed[key];
					}, 0);
					setPageProgress(finished / Math.max(1, state.parallelProgress.total),
						"Recognizing line " + finished + " of " + state.parallelProgress.total + "…");
				} else {
					setPageProgress(message.progress || 0,
						"Recognizing line " + (message.completed || 0) + " of " + (message.total || 0) + "…");
				}
				break;
			case "page-ready":
			case "detections-ready": {
				var waiter = state.pageWaiters[message.requestId];
				if (waiter) {
					delete state.pageWaiters[message.requestId];
					waiter.resolve(message);
				}
				break;
			}
			case "error": {
				var failure = new Error(message.message || "OCR worker error");
				failure.stage = message.stage;
				var pending = state.pageWaiters[message.requestId];
				if (pending) {
					delete state.pageWaiters[message.requestId];
					pending.reject(failure);
				} else if (state.readyWaiters[message.requestId]) {
					state.readyWaiters[message.requestId].reject(failure);
				}
				break;
			}
			default:
				break;
		}
	}

	function postPageRequest(worker, pageIndex, image, type, detections, progress) {
		var requestId = ++state.requestId;
		if (progress) progress.completed[requestId] = 0;
		return new Promise(function (resolve, reject) {
			state.pageWaiters[requestId] = { resolve: resolve, reject: reject };
			worker.postMessage({
				type: type,
				requestId: requestId,
				page: pageIndex,
				pageId: pageIndex,
				width: image.width,
				height: image.height,
				rgba: image.rgba,
				detections: type === "recognize-page" ? detections : undefined
			});
		});
	}

	function recognizeInParallel(pageIndex, image, detections, workers) {
		var groups = workers.map(function () { return { positions: [], detections: [] }; });
		detections.forEach(function (detection, index) {
			var group = groups[index % workers.length];
			group.positions.push(index);
			group.detections.push(detection);
		});
		var progress = { completed: {}, total: detections.length };
		state.parallelProgress = progress;
		return Promise.all(groups.map(function (group, index) {
			if (!group.detections.length) return Promise.resolve([]);
			return postPageRequest(workers[index], pageIndex, image, "recognize-page",
				group.detections, progress).then(function (message) { return message.lines || []; });
		})).then(function (groupsOfLines) {
			var ordered = new Array(detections.length);
			groupsOfLines.forEach(function (lines, index) {
				lines.forEach(function (line, position) {
					ordered[groups[index].positions[position]] = line;
				});
			});
			return { width: image.width, height: image.height,
				lines: ordered.filter(function (line) { return !!line; }) };
		}).finally(function () {
			if (state.parallelProgress === progress) state.parallelProgress = null;
		});
	}

	function ocrPage(pageIndex, image, detections) {
		var workers = state.workers.length ? state.workers : [state.worker];
		if (workers.length === 1) return postPageRequest(workers[0], pageIndex, image,
			detections.length ? "recognize-page" : "process-page", detections);
		if (detections.length) return recognizeInParallel(pageIndex, image, detections, workers);
		return postPageRequest(workers[0], pageIndex, image, "detect-page", []).then(function (message) {
			return message.detections && message.detections.length
				? recognizeInParallel(pageIndex, image, message.detections, workers)
				: { width: image.width, height: image.height, lines: [] };
		});
	}

	/**
	 * The editor's copyPageTextWithQuads coordinates are page units with a
	 * top-left origin. Convert to the rendered page's pixels, and reorder its
	 * TL, TR, BL, BR corners to the recognizer's TL, TR, BR, BL convention.
	 * The extracted text is retained for reliable Latin lines; legacy Khmer
	 * encodings still need recognition from the page image.
	 */
	function selectionDetections(selection, image, isSelectedRegion) {
		if (!selection || !Array.isArray(selection.lines) || !image ||
			(selection.rotation && selection.rotation % 360 !== 0) ||
			!Number.isFinite(selection.width) || !Number.isFinite(selection.height) ||
			selection.width <= 0 || selection.height <= 0 || image.width <= 0 || image.height <= 0) return [];
		var sourceAspect = selection.width / selection.height;
		if (Math.abs(image.width / image.height / sourceAspect - 1) > 0.03) return [];
		var scaleX = image.width / selection.width;
		var scaleY = image.height / selection.height;
		var detections = [];
		selection.lines.forEach(function (line) {
			if (!line || !line.text || !String(line.text).replace(/[\s\uFFFF]/g, "") ||
				!Array.isArray(line.quads) || line.quads.length !== 8 ||
				!line.quads.every(Number.isFinite)) return;
			function point(index) {
				return { x: line.quads[index * 2] * scaleX, y: line.quads[index * 2 + 1] * scaleY };
			}
			var quad = { p0: point(0), p1: point(1), p2: point(3), p3: point(2) };
			var bounds = quadBounds(quad);
			var width = Math.hypot(quad.p1.x - quad.p0.x, quad.p1.y - quad.p0.y);
			var height = Math.hypot(quad.p3.x - quad.p0.x, quad.p3.y - quad.p0.y);
			if (width < 2 || height < 2 || bounds.right <= 0 || bounds.bottom <= 0 ||
				bounds.left >= image.width || bounds.top >= image.height) return;
			detections.push({ id: detections.length, quad: quad, sourceText: line.text, score: 1,
				order: { region: 0, line: detections.length, position: 0 } });
		});
		return constrainSelectionInk(constrainSelectionCrops(mergeSelectionFragments(detections), image), image,
			!isSelectedRegion);
	}

	// Native PDF extraction can split one visual Khmer line into overlapping
	// runs (a mark or font switch often resets the run's x). Group by actual
	// row height and position, using only a small allowed horizontal gap so
	// different columns stay separate.
	function mergeSelectionFragments(detections) {
		var result = [];
		detections.forEach(function (detection) {
			var b = quadBounds(detection.quad);
			var hb = b.bottom - b.top;
			var best = null;
			var bestGap = Infinity;
			for (var i = 0; i < result.length; i++) {
				var candidate = result[i];
				var a = quadBounds(candidate.quad);
				var ha = a.bottom - a.top;
				var minHeight = Math.min(ha, hb);
				var gap = Math.max(0, b.left - a.right, a.left - b.right);
				if (Math.abs(candidate.quad.p1.y - candidate.quad.p0.y) > ha * 0.08 ||
					Math.abs(detection.quad.p1.y - detection.quad.p0.y) > hb * 0.08 ||
					Math.max(ha, hb) / minHeight > 1.35 ||
					Math.abs(candidate._rowTop - b.top) > minHeight * 0.25 ||
					gap > minHeight || gap >= bestGap) continue;
				best = candidate;
				bestGap = gap;
			}
			if (best) {
				var bounds = quadBounds(best.quad);
				best.sourceText += detection.sourceText;
				best.quad = {
					p0: { x: Math.min(bounds.left, b.left), y: Math.min(bounds.top, b.top) },
					p1: { x: Math.max(bounds.right, b.right), y: Math.min(bounds.top, b.top) },
					p2: { x: Math.max(bounds.right, b.right), y: Math.max(bounds.bottom, b.bottom) },
					p3: { x: Math.min(bounds.left, b.left), y: Math.max(bounds.bottom, b.bottom) }
				};
			} else {
				detection.id = result.length;
				detection.order.line = result.length;
				detection._rowTop = b.top;
				result.push(detection);
			}
		});
		result.forEach(function (detection) { delete detection._rowTop; });
		return result;
	}

	// The PDF font box can cross the next baseline even when the visible ink
	// does not. Bound each recognizer crop by the halfway point to nearby runs
	// in the same column. Preserve the unmodified quad for source-font matching.
	function constrainSelectionCrops(detections, image) {
		var pixels = image.rgba && image.rgba.byteLength === image.width * image.height * 4
			? new Uint8ClampedArray(image.rgba) : null;
		detections.forEach(function (detection) {
			var bounds = quadBounds(detection.quad);
			var height = bounds.bottom - bounds.top;
			var width = bounds.right - bounds.left;
			if (height <= 0 || width <= 0 ||
				Math.abs(detection.quad.p1.y - detection.quad.p0.y) > height * 0.08) return;
			var center = (bounds.top + bounds.bottom) / 2;
			var above = -Infinity;
			var below = Infinity;
			var aboveDivider = null;
			var belowDivider = null;
			detections.forEach(function (other) {
				if (other === detection) return;
				var neighbor = quadBounds(other.quad);
				var overlap = Math.max(0, Math.min(bounds.right, neighbor.right) -
					Math.max(bounds.left, neighbor.left));
				if (overlap < Math.min(width, neighbor.right - neighbor.left) * 0.35) return;
				var neighborCenter = (neighbor.top + neighbor.bottom) / 2;
				if (neighborCenter < center - 2 && neighborCenter > above) {
					above = neighborCenter;
					aboveDivider = findInkDivider(pixels, image.width, overlapStart(bounds, neighbor),
						overlapEnd(bounds, neighbor), neighborCenter, center);
				}
				if (neighborCenter > center + 2 && neighborCenter < below) {
					below = neighborCenter;
					belowDivider = findInkDivider(pixels, image.width, overlapStart(bounds, neighbor),
						overlapEnd(bounds, neighbor), center, neighborCenter);
				}
			});
			var top = Math.max(0, bounds.top, aboveDivider == null ? (above + center) / 2 : aboveDivider);
			var bottom = Math.min(image.height, bounds.bottom, belowDivider == null ? (below + center) / 2 : belowDivider);
			if (bottom - top < Math.max(4, height * 0.4) ||
				(top <= bounds.top && bottom >= bounds.bottom)) return;
			detection.cropQuad = {
				p0: { x: bounds.left, y: top }, p1: { x: bounds.right, y: top },
				p2: { x: bounds.right, y: bottom }, p3: { x: bounds.left, y: bottom }
			};
		});
		return detections;
	}

	function overlapStart(a, b) { return Math.max(a.left, b.left); }
	function overlapEnd(a, b) { return Math.min(a.right, b.right); }

	function findInkDivider(pixels, imageWidth, left, right, centerA, centerB) {
		if (!pixels || !(right > left)) return null;
		var low = Math.ceil(Math.min(centerA, centerB) + Math.abs(centerB - centerA) * 0.2);
		var high = Math.floor(Math.max(centerA, centerB) - Math.abs(centerB - centerA) * 0.2);
		var x0 = Math.max(0, Math.ceil(left));
		var x1 = Math.max(x0, Math.floor(right));
		var width = x1 - x0 + 1;
		var bestY = -1;
		var bestInk = Infinity;
		for (var y = low; y <= high; y++) {
			var ink = 0;
			for (var x = x0; x <= x1; x++) {
				var offset = (y * imageWidth + x) * 4;
				if (pixels[offset + 3] >= 128 &&
					Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 170) ink++;
			}
			if (ink < bestInk) { bestInk = ink; bestY = y; }
		}
		return bestY >= 0 && bestInk <= Math.max(1, Math.floor(width * 0.05))
			? bestY + 0.5 : null;
	}

	// Some embedded fonts report an advance much wider than their painted glyphs.
	// The editor selects that advance, so trimming to the rendered ink is needed
	// after merging fragments. Work inside the vertically bounded crop, and keep
	// a couple of pixels for antialiasing and Khmer marks.
	function constrainSelectionInk(detections, image, expandVerticalInk) {
		if (!image.rgba || image.rgba.byteLength !== image.width * image.height * 4) return detections;
		var pixels = new Uint8ClampedArray(image.rgba);
		detections.forEach(function (detection) {
			var originalBox = quadBounds(detection.cropQuad || detection.quad);
			var box = originalBox;
			// A manual selection already specifies the intended row. Searching beyond
			// it without the other page lines pulls ink from adjacent paragraphs.
			if (expandVerticalInk && !detection.cropQuad)
				box = expandSelectionBoxToInk(detection, detections, image, pixels, box);
			if (box.top < originalBox.top || box.bottom > originalBox.bottom) {
				detection.cropQuad = {
					p0: { x: box.left, y: box.top }, p1: { x: box.right, y: box.top },
					p2: { x: box.right, y: box.bottom }, p3: { x: box.left, y: box.bottom }
				};
			}
			var height = box.bottom - box.top;
			var width = box.right - box.left;
			if (height < 5 || width < 8 ||
				Math.abs(detection.quad.p1.y - detection.quad.p0.y) > height * 0.08) return;
			var x0 = Math.max(0, Math.ceil(box.left));
			var x1 = Math.min(image.width - 1, Math.floor(box.right));
			var y0 = Math.max(0, Math.ceil(box.top + 1));
			var y1 = Math.min(image.height - 1, Math.floor(box.bottom - 1));
			if (x1 <= x0 || y1 <= y0) return;
			var minInk = Infinity;
			var maxInk = -Infinity;
			var minPixels = Math.max(2, Math.floor((y1 - y0) / 16));
			for (var x = x0; x <= x1; x++) {
				var count = 0;
				for (var y = y0; y <= y1; y++) {
					var offset = (y * image.width + x) * 4;
					if (pixels[offset + 3] >= 128 &&
						Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 170) count++;
				}
				if (count >= minPixels) {
					minInk = Math.min(minInk, x);
					maxInk = x;
				}
			}
			if (!Number.isFinite(minInk) || maxInk - minInk < width * 0.35) return;
			var margin = Math.max(2, Math.ceil(height * 0.05));
			var left = Math.max(box.left, minInk - margin);
			var right = Math.min(box.right, maxInk + margin);
			if (right - left < 8 || (left <= box.left && right >= box.right)) return;
			detection.cropQuad = {
				p0: { x: left, y: box.top }, p1: { x: right, y: box.top },
				p2: { x: right, y: box.bottom }, p3: { x: left, y: box.bottom }
			};
		});
		return detections;
	}

	function expandSelectionBoxToInk(detection, detections, image, pixels, box) {
		var line = quadBounds(detection.quad);
		var lineHeight = line.bottom - line.top;
		var width = line.right - line.left;
		if (lineHeight < 5 || width < 8) return box;
		var center = (line.top + line.bottom) / 2;
		var growth = Math.min(48, Math.max(3, lineHeight * 0.65));
		var searchTop = Math.max(0, line.top - growth);
		var searchBottom = Math.min(image.height, line.bottom + growth);
		detections.forEach(function (other) {
			if (other === detection) return;
			var neighbor = quadBounds(other.quad);
			var overlap = Math.max(0, Math.min(line.right, neighbor.right) - Math.max(line.left, neighbor.left));
			if (overlap < Math.min(width, neighbor.right - neighbor.left) * 0.35) return;
			var neighborCenter = (neighbor.top + neighbor.bottom) / 2;
			var divider = (center + neighborCenter) / 2;
			if (neighborCenter < center) searchTop = Math.max(searchTop, divider);
			else if (neighborCenter > center) searchBottom = Math.min(searchBottom, divider);
		});
		var x0 = Math.max(0, Math.ceil(line.left));
		var x1 = Math.min(image.width - 1, Math.floor(line.right));
		var minInk = Math.max(1, Math.floor((x1 - x0 + 1) * 0.003));
		var first = Infinity;
		var last = -Infinity;
		for (var y = Math.floor(searchTop); y < Math.ceil(searchBottom); y++) {
			var count = 0;
			for (var x = x0; x <= x1; x++) {
				var offset = (y * image.width + x) * 4;
				if (pixels[offset + 3] >= 128 &&
					Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 170) count++;
			}
			if (count >= minInk) { first = Math.min(first, y); last = y; }
		}
		if (!Number.isFinite(first) || !Number.isFinite(last)) return box;
		return {
			left: box.left,
			right: box.right,
			top: Math.min(box.top, first - 1),
			bottom: Math.max(box.bottom, last + 2)
		};
	}

	/**
	 * A phone-scanned PDF may carry a tiny, nonsensical OCR text layer on top of
	 * a full-page image. Its selectable quads are real but cover only a fraction
	 * of the printed ink; using them skips most of the page. Count dark rendered
	 * pixels inside the combined selection boxes versus the full page.
	 */
	/**
	 * Place the invisible text origin inside an OCR line box.
	 *
	 * Both detector and PDF-selection geometry describe bounding rectangles,
	 * not baselines. Keep their position and size rather than interpreting the
	 * bottom edge as the text origin.
	 *
	 * The writer anchors the origin at quad.p3 and derives a glyph box of height
	 * S spanning 0.74S above it and 0.26S below. Anchoring at the box bottom and
	 * growing by LOGICAL_BOX_GROWTH therefore drops the reported selection below
	 * the box centre.
	 *
	 * To make the reported glyph box equal the detector box, the origin has to
	 * sit 0.26H above the box bottom, leaving verticalLength spanning 0.74H of
	 * the ascent. The growth paired with that is 1000/740.
	 */
	function quadForDetectorBox(quad) {
		if (!(Math.hypot(quad.p0.x - quad.p3.x, quad.p0.y - quad.p3.y) > 0)) return quad;
		return {
			p0: { x: quad.p0.x, y: quad.p0.y },
			p1: { x: quad.p1.x, y: quad.p1.y },
			p2: { x: quad.p2.x + 0.26 * (quad.p1.x - quad.p2.x),
				y: quad.p2.y + 0.26 * (quad.p1.y - quad.p2.y) },
			p3: { x: quad.p3.x + 0.26 * (quad.p0.x - quad.p3.x),
				y: quad.p3.y + 0.26 * (quad.p0.y - quad.p3.y) }
		};
	}

	function selectionInkCoverage(detections, image) {
		if (!detections.length || !image.rgba ||
			image.rgba.byteLength !== image.width * image.height * 4) return null;
		var mask = new Uint8Array(image.width * image.height);
		detections.forEach(function (detection) {
			var box = quadBounds(detection.cropQuad || detection.quad);
			var left = Math.max(0, Math.floor(box.left));
			var right = Math.min(image.width, Math.ceil(box.right));
			var top = Math.max(0, Math.floor(box.top));
			var bottom = Math.min(image.height, Math.ceil(box.bottom));
			for (var y = top; y < bottom; y++)
				mask.fill(1, y * image.width + left, y * image.width + right);
		});
		var pixels = new Uint8ClampedArray(image.rgba);
		var total = 0;
		var covered = 0;
		for (var i = 0; i < mask.length; i++) {
			var offset = i * 4;
			if (pixels[offset + 3] < 128 ||
				Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) >= 185) continue;
			total++;
			if (mask[i]) covered++;
		}
		return total ? covered / total : 0;
	}

	function hasSevereTextBoxOverlap(detections) {
		for (var i = 0; i < detections.length; i++) {
			var a = quadBounds(detections[i].quad);
			var heightA = a.bottom - a.top;
			var widthA = a.right - a.left;
			for (var j = i + 1; j < detections.length; j++) {
				var b = quadBounds(detections[j].quad);
				var heightB = b.bottom - b.top;
				var widthB = b.right - b.left;
				var overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
				var overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
				if (overlapX / Math.max(1, Math.min(widthA, widthB)) >= 0.5 &&
					overlapY / Math.max(1, Math.min(heightA, heightB)) >= 0.25) return true;
			}
		}
		return false;
	}

	/** Return Latin PDF text when an independent text anchor agrees geometrically. */
	function extractedLatinLine(detection, anchors) {
		var text = String(detection.sourceText || "").replace(/[\s\uFFFF]+/g, " ").trim();
		if (!/[A-Za-z\u00C0-\u024F]/.test(text) ||
			/[^\u0020-\u007E\u00C0-\u024F\u1E00-\u1EFF\u2010-\u201F\u2026\u20AC]/.test(text) ||
			!Array.isArray(anchors)) return null;
		var bounds = quadBounds(detection.quad);
		var lineWidth = bounds.right - bounds.left;
		var matchedWidth = 0;
		anchors.forEach(function (anchor) {
			if (!anchor.bounds || !anchor.corruptText) return;
			var fragment = String(anchor.corruptText).replace(/\s+/g, " ").trim();
			if (!fragment || text.indexOf(fragment) === -1) return;
			var rect = anchor.bounds;
			var overlapX = Math.max(0, Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left));
			var overlapY = Math.max(0, Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top));
			if (overlapY <= 0) return;
			matchedWidth += overlapX;
		});
		if (lineWidth <= 0 || matchedWidth < lineWidth * 0.45) return null;
		return {
			detectionId: detection.id,
			quad: detection.cropQuad || detection.quad,
			units: [],
			rawText: text,
			confidence: null,
			source: "pdf-text",
			order: detection.order
		};
	}

	function hasStructuredLatin(text) {
		text = String(text || "");
		return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
			/(?:https?:\/\/|www\.)[A-Z0-9.-]+\.[A-Z]{2,}(?:[/?#][A-Z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/i.test(text);
	}

	function isPluPdfMetadata(info) {
		return !!info && info.Creator === PDF_RECONSTRUCTION_TOOL &&
			String(info.Producer || "").indexOf(PDF_RECONSTRUCTION_TOOL + " using pdf-lib ") === 0;
	}

	function restoreNativeKhmerWhenOcrChangesScript(line, detection, isPlu) {
		if (!isPlu) return line;
		var source = String(detection && detection.sourceText || "").replace(/[\uFFFF\s]+/g, " ").trim();
		var recognized = String(line && line.rawText || "");
		var khmerCount = (source.match(/[\u1780-\u17FF]/g) || []).length;
		if (khmerCount < 2 || /[\u1780-\u17FF]/.test(recognized) ||
			/[^\u0020-\u007E\u1780-\u17FF\u00A0\u00AD\u200B-\u200F\u2010-\u201F\u2026\u20AC]/.test(source)) return line;
		line.rawText = source;
		line.units = [];
		line.confidence = null;
		line.source = "pdf-text";
		return line;
	}

	function normalizedLatinText(text) {
		var matches = String(text || "").match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF0-9]+/g);
		return matches ? matches.join("").toLowerCase() : "";
	}

	function editDistance(a, b) {
		var previous = new Array(b.length + 1);
		for (var j = 0; j <= b.length; j++) previous[j] = j;
		for (var i = 1; i <= a.length; i++) {
			var current = [i];
			current[0] = i;
			for (j = 1; j <= b.length; j++) {
				current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
					previous[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
			}
			previous = current;
		}
		return previous[b.length];
	}

	function sourceTextMatchesOcr(sourceText, recognizedText) {
		var source = normalizedLatinText(sourceText);
		var recognized = normalizedLatinText(recognizedText);
		if (source.length < 4 || !recognized) return false;
		return 1 - editDistance(source, recognized) / Math.max(source.length, recognized.length) >=
			(source.length >= 12 ? 0.78 : 0.88);
	}

	/** Restore source Latin when text content, script context, or OCR agreement supports it. */
	function restoreSourceLatin(line, detection, anchors) {
		var units = line && Array.isArray(line.units) ? line.units : [];
		var quad = line && (line.alignmentQuad || line.quad) || detection && detection.quad;
		var totalSteps = Number(line && line.ctcContentLength);
		if (!units.length || !quad || !quad.p0 || !quad.p1 || !Array.isArray(anchors) ||
			!(totalSteps > 0)) return line;

		var dx = quad.p1.x - quad.p0.x;
		var dy = quad.p1.y - quad.p0.y;
		var axisLengthSquared = dx * dx + dy * dy;
		if (!(axisLengthSquared > 0)) return line;
		var bounds = quadBounds(detection && detection.cropQuad || detection && detection.quad || quad);
		var replacements = [];
		anchors.forEach(function (anchor) {
			if (!anchor || !anchor.bounds) return;

			var overlapX = Math.max(0, Math.min(bounds.right, anchor.bounds.right) -
				Math.max(bounds.left, anchor.bounds.left));
			var overlapY = Math.max(0, Math.min(bounds.bottom, anchor.bounds.bottom) -
				Math.max(bounds.top, anchor.bounds.top));
			var anchorHeight = anchor.bounds.bottom - anchor.bounds.top;
			var cropHeight = bounds.bottom - bounds.top;
			if (overlapY < anchorHeight * 0.45 || overlapY < cropHeight * 0.25 ||
				overlapX < Math.min(anchor.bounds.right - anchor.bounds.left,
				bounds.right - bounds.left) * 0.65) return;
			var baselineStart = anchor.baselineStart || {
				x: anchor.bounds.left, y: (anchor.bounds.top + anchor.bounds.bottom) / 2
			};
			var baselineEnd = anchor.baselineEnd || {
				x: anchor.bounds.right, y: (anchor.bounds.top + anchor.bounds.bottom) / 2
			};
			latinSourceFragments(anchor).forEach(function (fragment) {
				if (!hasStructuredLatin(fragment.text) &&
					!sourceTextMatchesOcr(fragment.text, line.rawText)) return;
				var startPoint = interpolatePoint(baselineStart, baselineEnd, fragment.start);
				var endPoint = interpolatePoint(baselineStart, baselineEnd, fragment.end);
				if (!startPoint || !endPoint) return;
				var start = Math.max(0, Math.min(1, ((startPoint.x - quad.p0.x) * dx +
					(startPoint.y - quad.p0.y) * dy) / axisLengthSquared));
				var end = Math.max(0, Math.min(1, ((endPoint.x - quad.p0.x) * dx +
					(endPoint.y - quad.p0.y) * dy) / axisLengthSquared));
				if (end < start) { var swap = start; start = end; end = swap; }
				if (end <= start) return;
				var first = -1;
				var last = -1;
				units.forEach(function (unit, index) {
					var unitStart = Number(unit.timestepStart);
					var unitEnd = Number(unit.timestepEnd);
					if (!Number.isFinite(unitStart) || !Number.isFinite(unitEnd)) return;
					var midpoint = (unitStart + unitEnd) / 2 / totalSteps;
					if (midpoint >= start && midpoint <= end) {
						if (first < 0) first = index;
						last = index;
					}
				});
				if (first >= 0) replacements.push({ first: first, last: last, text: fragment.text });
			});
		});

		replacements.sort(function (a, b) { return b.first - a.first; });
		var restored = units.map(function (unit) { return unit.rawText || "" });
		var previousFirst = units.length;
		replacements.forEach(function (replacement) {
			if (replacement.last >= previousFirst) return;
			restored.splice(replacement.first, replacement.last - replacement.first + 1, replacement.text);
			previousFirst = replacement.first;
		});
		if (replacements.length) line.rawText = restored.join("");
		return line;
	}

	function interpolatePoint(start, end, amount) {
		if (!start || !end || !Number.isFinite(amount)) return null;
		return { x: start.x + (end.x - start.x) * amount,
			y: start.y + (end.y - start.y) * amount };
	}

	function latinSourceFragments(anchor) {
		var text = String(anchor && anchor.corruptText || "");
		if (!/[A-Za-z\u00C0-\u024F]/.test(text)) return [];
		if (!/[^\u0020-\u007E\u00C0-\u024F\u1E00-\u1EFF\u2010-\u201F\u2026\u20AC]/.test(text)) {
			var clean = text.replace(/[\s\uFFFF]+/g, " ").trim();
			return clean ? [{ text: clean, start: 0, end: 1 }] : [];
		}
		var fractions = anchor.characterFractions;
		var fragments = [];
		var pattern = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF][A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF@._%+:/?&=#~\-]*/g;
		var match;
		while ((match = pattern.exec(text))) {
			var start = fractions && Number.isFinite(fractions[match.index])
				? fractions[match.index] : match.index / Math.max(1, text.length);
			var endIndex = match.index + match[0].length;
			var end = fractions && Number.isFinite(fractions[endIndex])
				? fractions[endIndex] : endIndex / Math.max(1, text.length);
			fragments.push({ text: match[0], start: start, end: end });
		}
		return fragments;
	}

	function uncoveredStructuredSourceLines(anchors, detections) {
		var result = [];
		if (!Array.isArray(anchors)) return result;
		anchors.forEach(function (anchor) {
			if (!anchor || !anchor.quad || !anchor.bounds) return;
			latinSourceFragments(anchor).forEach(function (fragment) {
				if (!hasStructuredLatin(fragment.text)) return;
				var sourceBounds = anchor.bounds;
				var sourceArea = Math.max(1, (sourceBounds.right - sourceBounds.left) *
					(sourceBounds.bottom - sourceBounds.top));
				var covered = (detections || []).some(function (detection) {
					var bounds = quadBounds(detection.cropQuad || detection.quad);
					var overlap = Math.max(0, Math.min(sourceBounds.right, bounds.right) -
						Math.max(sourceBounds.left, bounds.left)) *
						Math.max(0, Math.min(sourceBounds.bottom, bounds.bottom) -
						Math.max(sourceBounds.top, bounds.top));
					return overlap / sourceArea >= 0.45;
				});
				if (covered) return;
				var start = interpolatePoint(anchor.baselineStart, anchor.baselineEnd, fragment.start);
				var end = interpolatePoint(anchor.baselineStart, anchor.baselineEnd, fragment.end);
				var quad = anchor.quad;
				if (start && end && anchor.baselineStart && anchor.baselineEnd) {
					var topStart = interpolatePoint(quad.p0, quad.p1, fragment.start);
					var topEnd = interpolatePoint(quad.p0, quad.p1, fragment.end);
					var bottomStart = interpolatePoint(quad.p3, quad.p2, fragment.start);
					var bottomEnd = interpolatePoint(quad.p3, quad.p2, fragment.end);
					if (topStart && topEnd && bottomStart && bottomEnd) {
						quad = { p0: topStart, p1: topEnd, p2: bottomEnd, p3: bottomStart };
					}
				}
				result.push({
					detectionId: anchor.id,
					quad: quad,
					units: [],
					rawText: fragment.text,
					confidence: null,
					source: "pdf-text",
					order: { region: 0, line: anchor.id || 0, position: 0 }
				});
			});
		});
		return result;
	}

	function mergeStructuredSourceLines(lines, sourceLines) {
		var result = (lines || []).slice();
		(sourceLines || []).forEach(function (sourceLine) {
			var sourceBounds = quadBounds(sourceLine.quad);
			var sourceArea = Math.max(1, (sourceBounds.right - sourceBounds.left) *
				(sourceBounds.bottom - sourceBounds.top));
			var alreadyCovered = result.some(function (line) {
				if (!line.quad) return false;
				var bounds = quadBounds(line.quad);
				var overlap = Math.max(0, Math.min(sourceBounds.right, bounds.right) -
					Math.max(sourceBounds.left, bounds.left)) *
					Math.max(0, Math.min(sourceBounds.bottom, bounds.bottom) -
					Math.max(sourceBounds.top, bounds.top));
				return overlap / sourceArea >= 0.45;
			});
			if (!alreadyCovered) result.push(sourceLine);
		});
		return result.sort(function (a, b) {
			var boundsA = quadBounds(a.quad);
			var boundsB = quadBounds(b.quad);
			return boundsA.top - boundsB.top || boundsA.left - boundsB.left;
		});
	}

	/* -------------------------------------------------------------- OCR driver */

	function loadPdfJs() {
		if (state.pdfjsPromise) return state.pdfjsPromise;
		state.pdfjsPromise = loadText(resourceUrl("vendor/pdfjs/pdf.min.js"))
			.then(function (source) {
				// The desktop ascdesktop:// scheme does not return a JavaScript MIME
				// type for these files, which module loading requires. Read the
				// source ourselves and import it from a Blob module instead.
				var moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
				return import(moduleUrl);
			})
			.then(function (module) {
				var pdfjs = module;
				state.pdfjs = pdfjs;
				return loadText(resourceUrl("vendor/pdfjs/pdf.worker.min.js")).then(function (workerText) {
					try {
						var workerUrl = URL.createObjectURL(new Blob([workerText], { type: "text/javascript" }));
						pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
						pdfjs.GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });
					} catch (error) {
						// pdf.js falls back to its own worker handling.
					}
					return pdfjs;
				});
			})
			.catch(function (error) {
				state.pdfjsPromise = null;
				throw error;
			});
		return state.pdfjsPromise;
	}

	/**
	 * Prefer rendering pages from the original PDF with pdf.js — the same
	 * renderer the reference app uses. The editor's GetPageImage returns a
	 * horizontally squished, low-resolution raster that blurs the OCR input.
	 */
	/**
	 * Desktop-only route: the app exposes the source path of the open document
	 * and serves local files over the ascdesktop:// scheme, so the original bytes
	 * can be read directly without triggering a save dialog.
	 */
	function desktopOriginalBytes() {
		try {
			var desktop = window.AscDesktopEditor;
			if (!desktop || typeof desktop.LocalFileGetSourcePath !== "function") {
				return Promise.resolve(null);
			}
			var path = desktop.LocalFileGetSourcePath();
			if (!path) return Promise.resolve(null);
			path = String(path).replace(/\\/g, "/");
			if (path.indexOf("file:///") === 0) path = path.substring(8);
			if (path.charAt(0) === "/" && /^\/[A-Za-z]:/.test(path)) path = path.substring(1);
			return loadBinaryAsset("ascdesktop://fonts/" + path).then(function (bytes) {
				return bytes && bytes.length > 4 ? bytes : null;
			}).catch(function () {
				return null;
			});
		} catch (error) {
			return Promise.resolve(null);
		}
	}

	/**
	 * Web route: the editor exports the document to a URL. Only used outside the
	 * desktop app, where this can raise a native save dialog.
	 */
	function webOriginalBytes() {
		if (window.AscDesktopEditor) return Promise.resolve(null);
		return pluginMethod("GetFileToDownload", ["pdf"]).then(function (url) {
			if (typeof url !== "string" || !url || url === "error") return null;
			return loadBinaryAsset(url).then(function (bytes) {
				return bytes && bytes.length > 4 ? bytes : null;
			}).catch(function () {
				return null;
			});
		}).catch(function () {
			return null;
		});
	}

	function probeBytesAccess() {
		var local = [];
		try {
			var desktop = window.AscDesktopEditor;
			local.push("desktop:" + (desktop ? "yes" : "no"));
			local.push("sourcePath:" + (desktop && typeof desktop.LocalFileGetSourcePath === "function"
				? String(desktop.LocalFileGetSourcePath() || "") : "n/a"));
		} catch (error) {
			local.push("desktop:err");
		}
		return callCommand(function () {
			var report = [];
			try { report.push("g_asc_plugins:" + (typeof g_asc_plugins)); } catch (error) { report.push("g_asc_plugins:err"); }
			try { report.push("Asc:" + (typeof Asc)); } catch (error) {}
			try {
				var plugins = (typeof g_asc_plugins !== "undefined") ? g_asc_plugins : null;
				var viewer = plugins && plugins.api && plugins.api.DocumentRenderer;
				report.push("viewer:" + (viewer ? "yes" : "no"));
				report.push("getFileNativeBinary:" + (viewer && typeof viewer.getFileNativeBinary));
			} catch (error) { report.push("viewer:err"); }
			try {
				var doc = Api.GetDocument();
				report.push("doc.Document:" + (doc && doc.Document ? "yes" : "no"));
				var file = (doc && doc.Document && doc.Document.GetFile) ? doc.Document.GetFile() : null;
				report.push("file:" + (file ? "yes" : "no"));
				report.push("file.getFileBinary:" + (file && typeof file.getFileBinary));
			} catch (error) { report.push("builder:err"); }
			return report.join(",");
		}).then(function (report) {
			return local.join(",") + " | " + (typeof report === "string" ? report : "n/a");
		}).catch(function () {
			return local.join(",") + " | command failed";
		});
	}

	function createPdfJsRenderer(sizes) {
		state.rendererError = "";
		var commandError = "";
		return readOriginalPdfBytes()
			.then(function (result) {
				if (result.bytes) return result.bytes;
				commandError = result.error || "no bytes";
				return desktopOriginalBytes();
			})
			.then(function (bytes) {
				if (bytes) return bytes;
				return webOriginalBytes();
			})
			.then(function (bytes) {
				if (!bytes) throw new Error("original PDF bytes unavailable (" + commandError + ")");
				return loadPdfJs().then(function (pdfjs) {
					return pdfjs.getDocument({ data: bytes }).promise.then(function (pdfDocument) {
						return pdfDocument.getMetadata().catch(function () { return null; }).then(function (metadata) {
							var isPlu = isPluPdfMetadata(metadata && metadata.info);
							return {
								kind: "pdf.js",
								isPlu: isPlu,
								render: function (index) {
									return renderPdfJsPage(pdfDocument, index, sizes).then(function (image) {
										image.isPlu = isPlu;
										return image;
									});
								},
								destroy: function () { try { pdfDocument.destroy(); } catch (error) {} }
							};
						});
					});
				});
			})
			.catch(function (error) {
				state.rendererError = (error && error.message) ? error.message : String(error);
				console.warn("pdf.js rendering unavailable, using the editor raster", error);
				return probeBytesAccess().then(function (report) {
					state.rendererError += " [" + report + "]";
					return null;
				});
			});
	}

	function renderPdfJsPage(pdfDocument, index, sizes) {
		return pdfDocument.getPage(index + 1).then(function (page) {
			var initial = page.getViewport({ scale: 2 });
			var scale = Math.min(1, RASTER_MAX_SIDE / Math.max(initial.width, initial.height));
			var viewport = page.getViewport({ scale: 2 * scale });
			var width = Math.max(1, Math.round(viewport.width));
			var height = Math.max(1, Math.round(viewport.height));
			var canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			var context = canvas.getContext("2d");
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, width, height);
			return page.render({ canvasContext: context, viewport: viewport }).promise
				.then(function () {
					return page.getTextContent().then(function (textContent) {
						return pdfTextAnchors(textContent, viewport, state.pdfjs.Util, page);
					}).catch(function () {
						return [];
					});
				})
				.then(function (anchors) {
					var data = context.getImageData(0, 0, width, height).data;
					var rgba = new Uint8ClampedArray(width * height * 4);
					rgba.set(data);
					var size = sizes && sizes[index] ? sizes[index] : null;
					page.cleanup();
					return {
						width: width,
						height: height,
						rgba: rgba.buffer,
						dataUrl: canvas.toDataURL("image/png"),
						pdfWidth: size && size.width ? size.width : width * 0.75,
						pdfHeight: size && size.height ? size.height : height * 0.75,
						editorSize: size || null,
						sourceTextAnchors: anchors
					};
				});
		});
	}

	function renderEditorPage(index, sizes) {
		var size = sizes && sizes[index] ? sizes[index] : null;
		var expectedAspect = size && size.width && size.height ? (size.width / size.height) : null;
		return pluginMethod("GetPageImage", [index, { maxSize: RASTER_MAX_SIDE }]).then(function (dataUrl) {
			if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) {
				throw new Error("Editor returned no image for page " + (index + 1));
			}
			return decodeDataUrl(dataUrl, expectedAspect).then(function (decoded) {
				return {
					width: decoded.width,
					height: decoded.height,
					rgba: decoded.rgba,
					dataUrl: decoded.dataUrl,
					pdfWidth: size && size.width ? size.width : decoded.width * 0.75,
					pdfHeight: size && size.height ? size.height : decoded.height * 0.75,
					editorSize: size || null
				};
			});
		});
	}

	function runAllPages() { runOcr("all"); }
	function runCurrentPage() { runOcr("current"); }

	function copyRecognizedSelection(text) {
		if (!text) throw new Error("No text recognized in the selection");
		// OCR completes long after the menu click; a plugin iframe no longer has a
		// clipboard user gesture. Ask the main editor frame (which has desktop
		// clipboard access) to perform the copy, then try the iframe as fallback.
		return pluginMethod("CopyKhmerOcrText", [text]).then(function (copied) {
			if (copied === true) return;
			return copyInPluginFrame(text);
		}).catch(function () { return copyInPluginFrame(text); });
	}

	function copyInPluginFrame(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).catch(function () {
				return copySelectedTextFallback(text);
			});
		}
		return copySelectedTextFallback(text);
	}

	function copySelectedTextFallback(text) {
		var area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "true");
		area.style.position = "fixed";
		area.style.top = "-1000px";
		document.body.appendChild(area);
		try {
			area.select();
			if (!document.execCommand("copy")) throw new Error("Clipboard access was denied");
		} finally {
			area.remove();
		}
	}

	/** Recognize only the selected PDF regions; never trigger full-page detection. */
	function copySelectionWithOcr(pages) {
		if (state.running) return Promise.resolve();
		state.running = true;
		updateButtons();
		setStatus("Recognizing selected text…");
		var renderer;
		return ensureWorker().then(function () { return readDocumentInfo(); }).then(function (info) {
			return createPdfJsRenderer(info.sizes).then(function (pdfRenderer) {
				renderer = pdfRenderer || { render: function (index) {
					return renderEditorPage(index, info.sizes);
				}, destroy: function () {} };
				var ordered = pages.slice().sort(function (a, b) { return a.index - b.index; });
				var results = [];
				var chain = Promise.resolve();
				ordered.forEach(function (page, position) {
					chain = chain.then(function () {
						state.runBase = position / ordered.length;
						state.runSpan = 1 / ordered.length;
						return renderer.render(page.index).then(function (image) {
							var regions = selectedDetections(page, image);
							if (!regions.length) throw new Error("Selected text has no usable PDF geometry");
							return readSelectionGeometry(page.index).then(function (sourceSelection) {
								attachSourceTextToRegions(regions, sourceSelection, image);
								return ocrPage(page.index, image, regions).then(function (message) {
									(message.lines || []).forEach(function (line) {
										var detection = regions.filter(function (region) {
										return region.id === line.detectionId;
										})[0];
									restoreNativeKhmerWhenOcrChangesScript(line, detection, image.isPlu);
									restoreSourceLatin(line, detection, image.sourceTextAnchors);
									});
									var text = (message.lines || []).map(function (line) {
										return line.rawText || "";
									}).filter(Boolean).join("\n");
									if (text) results.push(text);
								});
							});
						});
					});
				});
				return chain.then(function () { return copyRecognizedSelection(results.join("\n")); });
			});
		}).then(function () {
			setStatus("Recognized selection copied.");
		}).catch(function (error) {
			console.error(error);
			setStatus("Copy with Khmer OCR failed: " + (error && error.message || String(error)));
		}).then(function () {
			if (renderer) renderer.destroy();
			state.running = false;
			state.parallelProgress = null;
			setProgress(null);
			updateButtons();
		});
	}

	function copyCurrentSelectionWithOcr() {
		if (state.running) return Promise.resolve();
		return readSelectedQuads().then(function (pages) {
			var valid = pages && pages.filter(function (page) {
				return page && page.rotation % 360 === 0 && Array.isArray(page.quads) &&
					page.quads.some(function (quad) { return Array.isArray(quad) && quad.length === 8; });
			});
			if (!valid || !valid.length) {
				setStatus("Select PDF text before using Copy with Khmer OCR.");
				return;
			}
			return copySelectionWithOcr(valid);
		}).catch(function (error) {
			setStatus("Could not read PDF selection: " + (error && error.message || String(error)));
		});
	}

	function stopOcr() {
		if (!state.running) return;
		state.cancelRequested = true;
		setStatus("Stopping after the current page…");
		updateButtons();
	}

	function runOcr(scope) {
		if (state.running) return;
		pluginMethod("SetTextHighlight", [null, null]).catch(function () {});
		state.running = true;
		state.cancelRequested = false;
		updateButtons();
		setProgress(0, "Preparing…");
		setStatus("Preparing…");
		setNotice("");

		var activeRenderer = null;
		var info = null;
		var indices = [];

		ensureWorker()
			.then(function () {
				return readDocumentInfo();
			})
			.then(function (documentInfo) {
				info = documentInfo;
				var pageCount = Number(info.count);
				if (!Number.isFinite(pageCount) || pageCount <= 0) {
					throw new Error("Could not determine the number of pages");
				}
				if (scope === "current") {
					return pluginMethod("GetCurrentPage", []).then(function (current) {
						var index = Number(current);
						if (!Number.isFinite(index) || index < 0 || index >= pageCount) index = 0;
						indices = [index];
					});
				}
				for (var i = 0; i < pageCount; i++) indices.push(i);
			})
			.then(function () {
				// Drop stale results for the pages about to be processed.
				state.pages = state.pages.filter(function (page) {
					return indices.indexOf(page.index) === -1;
				});
				renderPages();

				return createPdfJsRenderer(info.sizes).then(function (renderer) {
					state.usedPdfJs = !!renderer;
					activeRenderer = renderer || {
						kind: "editor",
						render: function (index) { return renderEditorPage(index, info.sizes); },
						destroy: function () {}
					};
					setEngine("ready", "engine ready · " + activeRenderer.kind);
					if (!renderer) {
						var reason = state.rendererError || "unknown";
						setNotice("High-quality rendering unavailable: " + reason +
							". Recognition is using the editor raster, which is lower resolution.");
					} else {
						setNotice("");
					}

					var total = indices.length;
					var chain = Promise.resolve();
					indices.forEach(function (pageIndex, position) {
						chain = chain.then(function () {
							if (state.cancelRequested) return null;
							return processPage(pageIndex, position, total, activeRenderer);
						});
					});
					return chain;
				});
			})
			.then(function () {
				if (state.cancelRequested) {
					setProgress(1, "Stopped");
					setStatus("OCR stopped.");
				} else {
					setProgress(1, "OCR finished");
					setStatus("OCR finished. Review the lines, then save as PLU PDF.");
				}
				updateButtons();
				window.setTimeout(function () { setProgress(null); }, 1500);
			})
			.catch(function (error) {
				console.error(error);
				setStatus("OCR failed: " + describeOcrError(error));
				setProgress(null);
			})
			.then(function () {
				if (activeRenderer) activeRenderer.destroy();
				state.running = false;
				state.cancelRequested = false;
				updateButtons();
			});
	}

	function processPage(pageIndex, position, total, renderer) {
		state.runBase = position / Math.max(1, total);
		state.runSpan = 1 / Math.max(1, total);
		setPageProgress(0, "Rendering page " + (pageIndex + 1) + "…");
		setStatus("Rendering page " + (pageIndex + 1) + "…");

		var image = null;
		var geometrySource = "PP-OCR detector";
		return renderer.render(pageIndex)
			.then(function (rendered) {
				image = rendered;
				return readSelectionGeometry(pageIndex);
			})
			.then(function (selection) {
				var detections = selectionDetections(selection, image);
				if (!detections.length) {
					var sourceLines = uncoveredStructuredSourceLines(image.sourceTextAnchors, []);
					return ocrPage(pageIndex, image, []).then(function (message) {
						(message.lines || []).forEach(function (line) {
							restoreSourceLatin(line, null, image.sourceTextAnchors);
						});
						message.lines = mergeStructuredSourceLines(message.lines, sourceLines);
						return message;
					});
				}
				var inkCoverage = selectionInkCoverage(detections, image);
				if (inkCoverage !== null && inkCoverage < 0.4) {
					geometrySource = "PP-OCR detector (scanned page)";
					setNotice("Page " + (pageIndex + 1) + " has an unreliable selectable text layer. OCR is detecting visible text from the scanned page image instead.");
					setStatus("Page " + (pageIndex + 1) + ": embedded text misses most visible ink; detecting the scanned page instead.");
					return ocrPage(pageIndex, image, []);
				}
				if (hasSevereTextBoxOverlap(detections)) {
					geometrySource = "PP-OCR detector (overlapping source boxes)";
					setNotice("Page " + (pageIndex + 1) + " has overlapping selectable text boxes. OCR is detecting visible text from the page image instead.");
					setStatus("Page " + (pageIndex + 1) + ": source text boxes overlap; detecting visible lines from the page image.");
					return ocrPage(pageIndex, image, []).then(function (message) {
						(message.lines || []).forEach(function (line) {
							restoreSourceLatin(line, null, image.sourceTextAnchors);
							restoreNativeKhmerWhenOcrChangesScript(line, null, image.isPlu);
						});
						message.lines = mergeStructuredSourceLines(message.lines,
							uncoveredStructuredSourceLines(image.sourceTextAnchors, []));
						return message;
					});
				}
				var direct = [];
				var remaining = [];
				var sourceLines = uncoveredStructuredSourceLines(image.sourceTextAnchors, detections);
				detections.forEach(function (detection) {
					var extracted = extractedLatinLine(detection, image.sourceTextAnchors);
					if (extracted) direct.push(extracted);
					else remaining.push(detection);
				});
				geometrySource = direct.length
					? (remaining.length ? "PDF text + selection" : "PDF text") : "PDF selection";
				if (!remaining.length) return { lines: mergeStructuredSourceLines(direct, sourceLines) };
				return ocrPage(pageIndex, image, remaining).then(function (message) {
					var recognized = message.lines || [];
					if (recognized.some(function (line) { return line.rawText && line.rawText.trim(); })) {
						recognized.forEach(function (line) {
							var detection = remaining.filter(function (region) {
								return region.id === line.detectionId;
							})[0];
							restoreNativeKhmerWhenOcrChangesScript(line, detection, image.isPlu);
							restoreSourceLatin(line, detection, image.sourceTextAnchors);
							line.source = "pdf-selection";
						});
						message.lines = mergeStructuredSourceLines(direct.concat(recognized), sourceLines);
						return message;
					}
					// An unrelated/invisible layer may have selectable boxes but no ink.
					// Retry image detection, keeping the proven Latin source text.
					geometrySource = direct.length ? "PDF text + PP-OCR detector" : "PP-OCR detector";
					return ocrPage(pageIndex, image, []).then(function (fallback) {
						(fallback.lines || []).forEach(function (line) {
							restoreSourceLatin(line, null, image.sourceTextAnchors);
						});
						fallback.lines = mergeStructuredSourceLines(direct.concat((fallback.lines || []).filter(function (line) {
							var rect = quadBounds(line.quad);
							return !direct.some(function (original) {
								var saved = quadBounds(original.quad);
								var intersection = Math.max(0, Math.min(rect.right, saved.right) - Math.max(rect.left, saved.left)) *
									Math.max(0, Math.min(rect.bottom, saved.bottom) - Math.max(rect.top, saved.top));
								return intersection > (rect.right - rect.left) * (rect.bottom - rect.top) * 0.5;
							});
						})), sourceLines);
						return fallback;
					});
				});
			})
			.then(function (message) {
				var lines = (message.lines || []).map(function (line) {
					line.status = "accepted";
					return line;
				});
				var widthPx = message.width || image.width;
				var heightPx = message.height || image.height;
				state.pages.push({
					index: pageIndex,
					width: widthPx,
					height: heightPx,
					imageUrl: image.dataUrl,
					imageBytes: dataUrlToBytes(image.dataUrl),
					pdfWidth: image.pdfWidth,
					pdfHeight: image.pdfHeight,
					editorSize: image.editorSize,
					renderKind: renderer.kind,
					geometrySource: geometrySource,
					sourceTextAnchors: image.sourceTextAnchors || [],
					lines: lines,
					error: null
				});
				state.pages.sort(function (a, b) { return a.index - b.index; });
				setPageProgress(1, "Page " + (pageIndex + 1) + ": " + lines.length + " lines");
				setStatus("Page " + (pageIndex + 1) + ": raster " + widthPx + "×" + heightPx +
					" · " + lines.length + " lines · " + geometrySource);
				renderPages();
			});
	}

	/* -------------------------------------------------------------------- UI */

	function formatConfidence(value) {
		var number = Number(value);
		if (!Number.isFinite(number)) return "—";
		return Math.round(number * 100) + "%";
	}

	function renderPages() {
		if (!el.pages) return;
		var scrollTop = el.content ? el.content.scrollTop : 0;
		el.pages.replaceChildren();
		state.pages.forEach(function (page) {
			el.pages.appendChild(buildPageElement(page));
		});
		updateSummary();
		updateButtons();
		if (el.content) el.content.scrollTop = scrollTop;
	}

	function quadBounds(quad) {
		var points = [quad.p0, quad.p1, quad.p2, quad.p3];
		return {
			left: Math.min(points[0].x, points[1].x, points[2].x, points[3].x),
			right: Math.max(points[0].x, points[1].x, points[2].x, points[3].x),
			top: Math.min(points[0].y, points[1].y, points[2].y, points[3].y),
			bottom: Math.max(points[0].y, points[1].y, points[2].y, points[3].y)
		};
	}

	function toggleReject(line) {
		line.status = line.status === "rejected" ? "accepted" : "rejected";
		renderPages();
	}

	function distanceToLine(point, start, end) {
		var dx = end.x - start.x;
		var dy = end.y - start.y;
		var lengthSquared = dx * dx + dy * dy;
		if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
		var t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
		return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
	}

	function textCharacterFractions(text, font) {
		var characters = Array.from(String(text || ""));
		if (!characters.length) return [0];
		var widths = null;
		try {
			if (font && typeof font.charsToGlyphs === "function") {
				var glyphs = font.charsToGlyphs(text);
				if (glyphs && glyphs.length === characters.length) {
					widths = glyphs.map(function (glyph) {
						return Math.max(0, Number(glyph && glyph.width) || 0);
					});
				}
			}
		} catch (error) {
			widths = null;
		}
		if (!widths || !widths.some(function (width) { return width > 0; })) {
			widths = characters.map(function () { return 1; });
		}
		var total = widths.reduce(function (sum, width) { return sum + width; }, 0);
		var fractions = new Array(String(text).length + 1);
		var cumulative = 0;
		var offset = 0;
		fractions[0] = 0;
		characters.forEach(function (character, index) {
			var width = widths[index] / total;
			for (var i = 1; i <= character.length; i++) {
				fractions[offset + i] = cumulative + width * i / character.length;
			}
			offset += character.length;
			cumulative += width;
		});
		return fractions;
	}

	/**
	 * Text anchors extracted from the PDF's own text via pdf.js (raster space).
	 */
	function pdfTextAnchors(textContent, viewport, pdfjsUtil, pdfPage) {
		var items = (textContent && textContent.items) ? textContent.items : [];
		var anchors = [];
		var fontNames = {};
		var fontObjects = {};
		for (var index = 0; index < items.length; index++) {
			var item = items[index];
			if (!item || !item.str || !Array.isArray(item.transform)) continue;
			if (!Object.prototype.hasOwnProperty.call(fontNames, item.fontName)) {
				try {
					// styles[item.fontName].fontFamily is often only "sans-serif".
					// After render, the actual PDF subset name is in commonObjs.
					var font = pdfPage.commonObjs.get(item.fontName);
					fontObjects[item.fontName] = font || null;
					fontNames[item.fontName] = font && font.name || "";
				} catch (error) {
					fontObjects[item.fontName] = null;
					fontNames[item.fontName] = "";
				}
			}
			var matrix = pdfjsUtil.transform(viewport.transform, item.transform);
			var horizontalLength = Math.hypot(matrix[0], matrix[1]);
			var verticalLength = Math.hypot(matrix[2], matrix[3]);
			if (!horizontalLength || !verticalLength) continue;
			var axis = { x: matrix[0] / horizontalLength, y: matrix[1] / horizontalLength };
			var width = Math.max(1, Math.abs(Number(item.width) || 0) * viewport.scale);
			var height = Math.max(1, verticalLength);
			var baselineStart = { x: matrix[4], y: matrix[5] };
			var baselineEnd = { x: baselineStart.x + axis.x * width, y: baselineStart.y + axis.y * width };
			var normal = { x: axis.y * height, y: -axis.x * height };
			var quad = {
				p0: { x: baselineStart.x + normal.x, y: baselineStart.y + normal.y },
				p1: { x: baselineEnd.x + normal.x, y: baselineEnd.y + normal.y },
				p2: baselineEnd,
				p3: baselineStart
			};
			anchors.push({
				id: index,
				corruptText: item.str,
				characterFractions: textCharacterFractions(item.str, fontObjects[item.fontName]),
				fontSourceName: fontNames[item.fontName],
				width: width,
				height: height,
				baselineStart: baselineStart,
				baselineEnd: baselineEnd,
				quad: quad,
				bounds: quadBounds(quad)
			});
		}
		return anchors;
	}

	/**
	 * Snap an OCR line quad to the PDF's real text baseline/height. Without this
	 * the invisible text sits on the recognizer's padded crop box, which is
	 * taller and offset, so search highlights and selection are shifted.
	 */
	function pdfSemanticQuad(page, lineQuad) {
		var anchors = (page && page.sourceTextAnchors) ? page.sourceTextAnchors : [];
		if (!anchors.length) return lineQuad;

		var lineBounds = quadBounds(lineQuad);
		var lineHeight = Math.max(1, lineBounds.bottom - lineBounds.top);
		var lineCenter = {
			x: (lineQuad.p0.x + lineQuad.p1.x + lineQuad.p2.x + lineQuad.p3.x) / 4,
			y: (lineQuad.p0.y + lineQuad.p1.y + lineQuad.p2.y + lineQuad.p3.y) / 4
		};
		var lineAxisVector = {
			x: (lineQuad.p1.x - lineQuad.p0.x) + (lineQuad.p2.x - lineQuad.p3.x),
			y: (lineQuad.p1.y - lineQuad.p0.y) + (lineQuad.p2.y - lineQuad.p3.y)
		};
		var lineAxisLength = Math.hypot(lineAxisVector.x, lineAxisVector.y) || 1;
		var lineAxis = { x: lineAxisVector.x / lineAxisLength, y: lineAxisVector.y / lineAxisLength };

		var best = null;
		for (var i = 0; i < anchors.length; i++) {
			var anchor = anchors[i];
			var horizontalOverlap = Math.max(0, Math.min(lineBounds.right, anchor.bounds.right) -
				Math.max(lineBounds.left, anchor.bounds.left));
			var horizontalOverlapRatio = horizontalOverlap / Math.max(1, lineBounds.right - lineBounds.left);
			var verticalOverlap = Math.max(0, Math.min(lineBounds.bottom, anchor.bounds.bottom) -
				Math.max(lineBounds.top, anchor.bounds.top));
			var baselineDistance = distanceToLine(lineCenter, anchor.baselineStart, anchor.baselineEnd);
			var anchorAxisLength = Math.hypot(
				anchor.baselineEnd.x - anchor.baselineStart.x,
				anchor.baselineEnd.y - anchor.baselineStart.y
			) || 1;
			var axisCompatibility = Math.abs(
				((anchor.baselineEnd.x - anchor.baselineStart.x) * lineAxis.x +
					(anchor.baselineEnd.y - anchor.baselineStart.y) * lineAxis.y) / anchorAxisLength
			);
			if (horizontalOverlapRatio < 0.35 || axisCompatibility < Math.cos(Math.PI / 6) ||
				(verticalOverlap <= 0 && baselineDistance > lineHeight * 1.5)) continue;
			var score = verticalOverlap / lineHeight + horizontalOverlapRatio - baselineDistance / lineHeight;
			if (!best || score > best.score) best = { anchor: anchor, score: score };
		}
		if (!best || best.score < 0.25) return lineQuad;

		var matched = best.anchor;
		var baselineStart = matched.baselineStart;
		var baselineEnd = matched.baselineEnd;
		var anchorDirection = { x: baselineEnd.x - baselineStart.x, y: baselineEnd.y - baselineStart.y };
		if (anchorDirection.x * lineAxis.x + anchorDirection.y * lineAxis.y < 0) {
			var swap = baselineStart;
			baselineStart = baselineEnd;
			baselineEnd = swap;
		}
		var axisLength = Math.hypot(baselineEnd.x - baselineStart.x, baselineEnd.y - baselineStart.y) || 1;
		var axis = {
			x: (baselineEnd.x - baselineStart.x) / axisLength,
			y: (baselineEnd.y - baselineStart.y) / axisLength
		};
		var normal = { x: axis.y, y: -axis.x };
		var ocrWidth = (Math.hypot(lineQuad.p1.x - lineQuad.p0.x, lineQuad.p1.y - lineQuad.p0.y) +
			Math.hypot(lineQuad.p2.x - lineQuad.p3.x, lineQuad.p2.y - lineQuad.p3.y)) / 2;
		var relative = { x: lineCenter.x - baselineStart.x, y: lineCenter.y - baselineStart.y };
		var centerProjection = relative.x * axis.x + relative.y * axis.y;
		var baselineCenter = {
			x: baselineStart.x + axis.x * centerProjection,
			y: baselineStart.y + axis.y * centerProjection
		};
		var halfWidth = ocrWidth / 2;
		var height = Math.max(1, Math.min(matched.height, lineHeight * 1.5));
		var p3 = { x: baselineCenter.x - axis.x * halfWidth, y: baselineCenter.y - axis.y * halfWidth };
		var p2 = { x: baselineCenter.x + axis.x * halfWidth, y: baselineCenter.y + axis.y * halfWidth };
		return {
			p0: { x: p3.x + normal.x * height, y: p3.y + normal.y * height },
			p1: { x: p2.x + normal.x * height, y: p2.y + normal.y * height },
			p2: p2,
			p3: p3
		};
	}

	function buildPagePreview(page) {
		var wrap = document.createElement("div");
		wrap.className = "page-preview";

		var combined = document.createElement("div");
		combined.className = "page-text";
		combined.setAttribute("dir", "ltr");
		var accepted = page.lines.filter(function (line) { return line.status !== "rejected"; });
		combined.textContent = accepted
			.map(function (line) { return line.rawText || ""; })
			.join("\n");
		wrap.appendChild(combined);
		return wrap;
	}

	/**
	 * Highlight the recognized line's selection or detector box, without creating a PDF
	 * annotation. The raster bbox is scaled into PDF points, the same space the
	 * exported text layer uses. The editor centers the view on the box: the page
	 * when it fits the viewport, otherwise the box itself, so the line is never
	 * left at the top edge.
	 */
	function goToLine(page, line) {
		if (!line.quad || !page.pdfWidth || !page.pdfHeight || !page.width || !page.height) return;
		setStatus("Showing line on page " + (page.index + 1) + "…");
		var bounds = quadBounds(line.quad);
		var left = bounds.left / page.width * page.pdfWidth;
		var top = bounds.top / page.height * page.pdfHeight;
		var right = bounds.right / page.width * page.pdfWidth;
		var bottom = bounds.bottom / page.height * page.pdfHeight;
		var pending = setTimeout(function () {
			setStatus("Highlight API did not respond; check the editor console.");
		}, 4000);
		return pluginMethod("SetTextHighlight", [page.index, [left, top, right, bottom], {center: true}])
			.then(function (result) {
				clearTimeout(pending);
				if (result !== true) {
					setStatus("Text highlight API result: " + String(result) + ".");
				} else {
					setStatus("Highlighted line on page " + (page.index + 1) + ".");
				}
				return result;
			})
			.catch(function (error) {
				clearTimeout(pending);
				setStatus("Could not highlight line: " + (error && error.message ? error.message : String(error)));
			});
	}

	function toggleLineCrop(page, line, row) {
		var existing = row.querySelector(".line-crop");
		if (existing) {
			existing.remove();
			return;
		}
		if (!page.imageUrl || !line.quad) return;

		var bounds = quadBounds(line.quad);
		var pad = Math.max(4, (bounds.bottom - bounds.top) * 0.15);
		var sx = Math.max(0, bounds.left - pad);
		var sy = Math.max(0, bounds.top - pad);
		var sw = Math.max(1, Math.min(page.width - sx, (bounds.right - bounds.left) + pad * 2));
		var sh = Math.max(1, Math.min(page.height - sy, (bounds.bottom - bounds.top) + pad * 2));

		var holder = document.createElement("div");
		holder.className = "line-crop";
		var canvas = document.createElement("canvas");
		var scale = Math.min(2, 320 / sw);
		canvas.width = Math.max(1, Math.round(sw * scale));
		canvas.height = Math.max(1, Math.round(sh * scale));
		holder.appendChild(canvas);
		row.appendChild(holder);

		var source = new Image();
		source.onload = function () {
			var context = canvas.getContext("2d");
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.imageSmoothingEnabled = false;
			context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
		};
		source.src = page.imageUrl;
	}

	function buildPageElement(page) {
		var section = document.createElement("section");
		section.className = "page";

		var head = document.createElement("div");
		head.className = "page-head";

		var caret = document.createElement("span");
		caret.className = "caret";
		caret.textContent = "\u25BE";

		var title = document.createElement("span");
		title.className = "page-title";
		title.textContent = "Page " + (page.index + 1);

		var meta = document.createElement("span");
		meta.className = "page-meta";
		var metaParts = [page.lines.length + " line" + (page.lines.length === 1 ? "" : "s")];
		if (page.width && page.height) metaParts.push("raster " + page.width + "×" + page.height);
		if (page.renderKind) metaParts.push(page.renderKind);
		if (page.geometrySource) metaParts.push(page.geometrySource);
		meta.textContent = metaParts.join(" · ");

		head.appendChild(caret);
		head.appendChild(title);
		head.appendChild(meta);
		head.appendChild(buildCopyButton(function () { return pageText(page); },
			"Copy this page's recognized text"));
		head.addEventListener("click", function () {
			section.classList.toggle("collapsed");
		});

		var body = document.createElement("div");
		body.className = "page-body";

		if (state.previewMode === "page" && page.imageUrl) {
			body.appendChild(buildPagePreview(page));
		} else if (!page.lines.length) {
			var empty = document.createElement("div");
			empty.className = "page-message";
			empty.textContent = "No text recognized on this page.";
			body.appendChild(empty);
		} else {
			page.lines.forEach(function (line) {
				body.appendChild(buildLineElement(page, line));
			});
		}

		section.appendChild(head);
		section.appendChild(body);
		return section;
	}

	function buildLineElement(page, line) {
		var row = document.createElement("div");
		row.className = "line";
		if (line.status === "rejected") row.classList.add("rejected");

		var text = document.createElement("div");
		text.className = "line-text";
		text.textContent = line.rawText || "";
		// Editing is disabled on purpose: the text is display-only.
		text.setAttribute("aria-readonly", "true");
		text.title = "Click to highlight this line in the editor";

		var meta = document.createElement("div");
		meta.className = "line-meta";

		var confidence = document.createElement("span");
		confidence.className = "conf";
		confidence.title = line.source === "pdf-text"
			? "Copied directly from the PDF text layer" : "Click to show the pixels the recognizer used";
		var value = Number(line.confidence);
		if (line.source !== "pdf-text" && Number.isFinite(value) && value < REVIEW_CONFIDENCE)
			confidence.classList.add("low");
		confidence.textContent = line.source === "pdf-text" ? "PDF text" : formatConfidence(line.confidence);
		if (line.source !== "pdf-text") confidence.addEventListener("click", function () {
			toggleLineCrop(page, line, row);
		});

		var reject = document.createElement("button");
		reject.type = "button";
		reject.className = "reject";
		reject.textContent = line.status === "rejected" ? "Rejected" : "Reject";
		reject.title = line.status === "rejected" ? "Keep this line after all" : "Reject this line as wrong";
		reject.addEventListener("click", function () {
			toggleReject(line);
		});

		meta.appendChild(confidence);
		meta.appendChild(buildCopyButton(function () { return line.rawText || ""; },
			"Copy this line's text"));
		meta.appendChild(reject);
		row.appendChild(text);
		row.appendChild(meta);
		row.addEventListener("click", function (event) {
			if (event.target.closest(".conf, .copy, .reject, .line-crop")) return;
			goToLine(page, line);
		});
		return row;
	}

	function setAllLines(status) {
		state.pages.forEach(function (page) {
			page.lines.forEach(function (line) { line.status = status; });
		});
		renderPages();
	}

	function clearAll() {
		pluginMethod("SetTextHighlight", [null, null]).catch(function () {});
		state.pages = [];
		renderPages();
		setStatus("Ready");
		setProgress(null);
	}

	/* ------------------------------------------------------------- PLU export */

	function semanticChunks(unicode, line) {
		if (!unicode) return [];
		var rawUnits = Array.isArray(line.units) ? line.units : [];
		var rawText = rawUnits.map(function (unit) { return unit.rawText; }).join("");
		if (unicode === rawText && rawUnits.length) {
			return ctcChunkIntervals(rawUnits, line);
		}
		var segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
			? new Intl.Segmenter("km", { granularity: "grapheme" })
			: null;
		var graphemes = segmenter
			? Array.from(segmenter.segment(unicode), function (part) { return part.segment; })
			: Array.from(unicode);
		return equalChunkIntervals(graphemes);
	}

	function ctcChunkIntervals(rawUnits, line) {
		var units = rawUnits.filter(function (unit) { return unit.rawText; });
		var ctcLength = Number(line.ctcLength);
		var contentLength = Number(line.ctcContentLength);
		var extent = Number.isFinite(contentLength) && contentLength > 0
			? contentLength
			: Number.isFinite(ctcLength) && ctcLength > 0 ? ctcLength : 0;
		if (!units.length || !extent) {
			return equalChunkIntervals(units.map(function (unit) { return unit.rawText; }));
		}
		var hasValidTimesteps = units.every(function (unit) {
			return Number.isFinite(Number(unit.timestepStart)) &&
				Number.isFinite(Number(unit.timestepEnd)) &&
				Number(unit.timestepEnd) > Number(unit.timestepStart);
		});
		if (!hasValidTimesteps) {
			return equalChunkIntervals(units.map(function (unit) { return unit.rawText; }));
		}
		return units.map(function (unit, index) {
			var previous = units[index - 1];
			var next = units[index + 1];
			var unitStart = Number(unit.timestepStart);
			var unitEnd = Number(unit.timestepEnd);
			var start = previous ? (Number(previous.timestepEnd) + unitStart) / 2 : unitStart;
			var end = next ? (unitEnd + Number(next.timestepStart)) / 2 : unitEnd;
			var normalizedStart = Math.max(0, Math.min(1 - 1e-6, start / extent));
			var normalizedEnd = Math.max(normalizedStart + 1e-6, Math.min(1, end / extent));
			return { unicode: unit.rawText, start: normalizedStart, end: normalizedEnd };
		});
	}

	function equalChunkIntervals(unicodes) {
		var chunks = unicodes.filter(Boolean);
		return chunks.map(function (unicode, index) {
			return {
				unicode: unicode,
				start: index / chunks.length,
				end: (index + 1) / chunks.length
			};
		});
	}

	// PDF font names usually include a six-letter subset prefix. Only map names
	// whose local CSS family is known; legacy embedded glyphs cannot be used to
	// shape the newly recognized Unicode just because the names look similar.
	function fontFamilyForPdfName(name) {
		var normalized = String(name || "").replace(/^[A-Z]{6}\+/, "")
			.replace(/[-,]Regular$/i, "").replace(/\s/g, "").toLowerCase();
		var families = {
			khmerossystem: "Khmer OS System",
			khmerosmuol: "Khmer OS Muol",
			khmerosmuollight: "Khmer OS Muol Light",
			khmerosmuolpali: "Khmer OS Muol Pali",
			khmernettra: "Khmer Nettra",
			notosanskhmer: "Noto Sans Khmer"
		};
		return Object.prototype.hasOwnProperty.call(families, normalized)
			? families[normalized] : null;
	}

	function sourceFontForLine(page, lineQuad) {
		var anchors = page && page.sourceTextAnchors || [];
		if (!lineQuad || !anchors.length) return null;
		var line = quadBounds(lineQuad);
		var lineWidth = line.right - line.left;
		var lineHeight = line.bottom - line.top;
		if (lineWidth <= 0 || lineHeight <= 0) return null;
		var scores = Object.create(null);
		anchors.forEach(function (anchor) {
			var family = fontFamilyForPdfName(anchor.fontSourceName);
			if (!family || !anchor.bounds) return;
			var bounds = anchor.bounds;
			var overlapX = Math.max(0, Math.min(line.right, bounds.right) - Math.max(line.left, bounds.left));
			var overlapY = Math.max(0, Math.min(line.bottom, bounds.bottom) - Math.max(line.top, bounds.top));
			var anchorHeight = bounds.bottom - bounds.top;
			if (overlapX <= 0 || anchorHeight <= 0 ||
				overlapY / Math.min(lineHeight, anchorHeight) < 0.4) return;
			scores[family] = (scores[family] || 0) + overlapX;
		});
		var best = null;
		var bestWidth = lineWidth * 0.35;
		Object.keys(scores).forEach(function (family) {
			if (scores[family] > bestWidth) {
				best = family;
				bestWidth = scores[family];
			}
		});
		return best;
	}

	function buildLogicalUnits() {
		var units = [];
		state.widthStats = { shaped: 0, fallback: 0 };
		var lineId = 0;
		var chunkId = 0;
		state.pages.forEach(function (page, pageIndex) {
			page.lines.forEach(function (line) {
				if (line.status === "rejected") return;
				var unicode = line.rawText;
				if (!unicode) return;
				var chunks = semanticChunks(unicode, line).map(function (chunk) {
					return { unicode: chunk.unicode, start: chunk.start, end: chunk.end, id: chunkId++ };
				});
				if (!chunks.length) return;
				var fontFamily = sourceFontForLine(page, line.quad || line.alignmentQuad);
				var shapedWidths = measureShapedWidths(chunks, fontFamily);
				if (shapedWidths) chunks.forEach(function (chunk, index) {
					chunk.advance = shapedWidths[index];
				});
				if (/[\u1780-\u17ff]/.test(unicode)) {
					state.widthStats[shapedWidths ? "shaped" : "fallback"]++;
				}
				var placement = pluPlacement(page, line);
				units.push({
					id: lineId++,
					pageIndex: pageIndex,
					unicode: unicode,
					chunks: chunks,
					source: line.source,
					quad: placement ? placement.quad : null,
					growth: placement ? placement.growth : null
				});
			});
		});
		return units;
	}

	/**
	 * Decide the quad a line is written with in the PLU, plus the glyph box
	 * growth that quad needs. A preserved PDF-text line already has its original
	 * layer and is used unchanged. Detector and PDF-selection quads both describe
	 * bounding rectangles, not baselines: move the origin inside the box so the
	 * emitted glyph bounds coincide with the rectangle used for recognition.
	 */
	function pluPlacement(page, line) {
		var base = line.quad || line.alignmentQuad;
		if (!base) return null;
		if (line.source === "pdf-text")
			return { quad: base, growth: null };
		return { quad: quadForDetectorBox(base), growth: LOGICAL_ASCENT_GROWTH };
	}

	/**
	 * Build a CIDFontType2 program with one glyph per distinct cluster width.
	 *
	 * The visible page is a flattened raster and the text layer is drawn in
	 * invisible mode, so nothing here is ever painted. The glyphs exist only to
	 * give each cluster a measurable box. That matters because PDFium, the engine
	 * behind Chromium-based viewers, sizes a character's selection box from the
	 * glyph outline and ignores the /W advance for its bounding box. CIDs with
	 * equal widths can share a GID; its rectangle is that width. CIDs with
	 * different widths must use different GIDs so their boxes remain accurate.
	 *
	 * Only the tables a CID-keyed PDF font needs are emitted: head, hhea, maxp,
	 * hmtx, loca, glyf, plus name and post.
	 * There is no cmap, because the font is addressed by CID through the PDF's
	 * binary CIDToGIDMap and never by character code.
	 */
	function buildLogicalFontProgram(advances) {
		var UPEM = 1000;
		var glyphs = advances.map(function (advance) {
			// The ink rectangle spans the full font box, descent below the baseline
			// to ascent above it, so a reader that measures the glyph gets the whole
			// cluster box and not just the part above the baseline.
			return logicalRectGlyph(0, -LOGICAL_DESCENT, advance, LOGICAL_ASCENT);
		});

		// A short loca table wraps at 131070 bytes. A 64-page document can contain
		// tens of thousands of clusters, so always use 32-bit glyph offsets.
		var locaOffsets = [0];
		for (var g = 0; g < glyphs.length; g++) {
			locaOffsets.push(locaOffsets[g] + glyphs[g].length);
		}
		var locaBytes = new Uint8Array(locaOffsets.length * 4);
		var locaView = new DataView(locaBytes.buffer);
		for (var li = 0; li < locaOffsets.length; li++) {
			locaView.setUint32(li * 4, locaOffsets[li], false);
		}
		var glyfBytes = concatBytes(glyphs);

		var maxAdvance = advances.reduce(function (a, b) { return Math.max(a, b); }, 0);
		var head = concatBytes([
			uint32(0x00010000), uint32(0x00010000), uint32(0), uint32(0x5F0F3CF5),
			uint16(0x000b), uint16(UPEM),
			// created and modified are LONGDATETIME, 8 bytes each, left at zero so
			// the program stays byte-for-byte reproducible across exports.
			uint32(0), uint32(0), uint32(0), uint32(0),
			int16(0), int16(-LOGICAL_DESCENT), int16(maxAdvance), int16(LOGICAL_ASCENT),
			uint16(0), uint16(8), int16(2), int16(1), int16(0)
		]);

		var hheaParts = [
			uint32(0x00010000),
			int16(LOGICAL_ASCENT), int16(-LOGICAL_DESCENT), int16(0),
			uint16(maxAdvance),
			int16(0), int16(0), int16(maxAdvance),
			int16(1), int16(0), int16(0),
			int16(0), int16(0), int16(0), int16(0),
			int16(0),
			uint16(advances.length)
		];
		var hmtxParts = [];
		for (var ai = 0; ai < advances.length; ai++) {
			hmtxParts.push(uint16(advances[ai]), int16(0));
		}

		var maxp = concatBytes([
			uint32(0x00010000), uint16(advances.length),
			uint16(4), uint16(1), uint16(0), uint16(0), uint16(2),
			uint16(0), uint16(0), uint16(0), uint16(0), uint16(0), uint16(0), uint16(0), uint16(0)
		]);

		// No OS/2 table: its layout changes between versions and it is not needed
		// for a CID-keyed embedded font, where the box comes from glyf and the
		// vertical metrics from the descriptor. Shipping a malformed one would be
		// worse than shipping none.
		var post = concatBytes([
			uint32(0x00030000), uint32(0), int16(0), int16(0),
			uint32(0), uint32(0), uint32(0), uint32(0), uint32(0)
		]);

		var nameRecords = [];
		var nameStrings = [];
		var nameOffset = 0;
		[[1, "TypsastraLogical"], [2, "Regular"], [4, "TypsastraLogical"],
			[6, "TypsastraLogical"]].forEach(function (pair) {
			var text = stringToBytes(pair[1]);
			// Mac Roman uses these ASCII-only names directly. Name records must
			// precede the shared string storage; their offsets are relative to it.
			nameRecords.push(concatBytes([
				uint16(1), uint16(0), uint16(0), uint16(pair[0]),
				uint16(text.length), uint16(nameOffset)
			]));
			nameStrings.push(text);
			nameOffset += text.length;
		});
		var nameTable = concatBytes([uint16(0), uint16(nameRecords.length),
			uint16(6 + 12 * nameRecords.length)].concat(nameRecords, nameStrings));

		var tables = [
			{ tag: "glyf", data: glyfBytes },
			{ tag: "head", data: head },
			{ tag: "hhea", data: concatBytes(hheaParts) },
			{ tag: "hmtx", data: concatBytes(hmtxParts) },
			{ tag: "loca", data: locaBytes },
			{ tag: "maxp", data: maxp },
			{ tag: "name", data: nameTable },
			{ tag: "post", data: post }
		];
		tables.sort(function (a, b) { return a.tag < b.tag ? -1 : 1; });

		var numTables = tables.length;
		var searchRange = 16;
		var entrySelector = 0;
		while (searchRange * 2 <= numTables * 16) {
			searchRange *= 2;
			entrySelector++;
		}
		var rangeShift = numTables * 16 - searchRange;

		var headerSize = 12 + numTables * 16;
		var offset = headerSize;
		var directory = [];
		var body = [];
		tables.forEach(function (table) {
			var padded = padTo4(table.data);
			directory.push(concatBytes([
				stringToBytes(table.tag), uint32(tableChecksum(table.data)),
				uint32(offset), uint32(table.data.length)
			]));
			body.push(padded);
			offset += padded.length;
		});

		var font = concatBytes([
			uint32(0x00010000), uint16(numTables), uint16(searchRange),
			uint16(entrySelector), uint16(rangeShift)
		].concat(directory).concat(body));

		// head.checkSumAdjustment covers the whole font with its own field zeroed,
		// which it already is at this point.
		var headOffset = null;
		var dirOffset = 12;
		for (var t = 0; t < numTables; t++) {
			if (stringFromBytes(font, dirOffset + t * 16, 4) === "head") {
				headOffset = readUint32(font, dirOffset + t * 16 + 8);
				break;
			}
		}
		if (headOffset !== null) {
			var adjustment = (0xB1B0AFBA - tableChecksum(font)) >>> 0;
			writeUint32(font, headOffset + 8, adjustment);
		}
		return font;
	}

	/** One closed rectangular contour, the simplest glyph with a real bbox. */
	function logicalRectGlyph(x0, y0, x1, y1) {
		if (x1 <= x0) x1 = x0 + 1;
		if (y1 <= y0) y1 = y0 + 1;
		var points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
		var parts = [
			int16(1), int16(x0), int16(y0), int16(x1), int16(y1),
			uint16(3),   // endPtsOfContours
			uint16(0)    // instructionLength
		];
		// Every point on-curve, coordinates as full signed 16-bit deltas.
		for (var p = 0; p < 4; p++) parts.push(uint8(0x01));
		var prev = 0;
		for (p = 0; p < 4; p++) {
			parts.push(int16(points[p][0] - prev));
			prev = points[p][0];
		}
		prev = 0;
		for (p = 0; p < 4; p++) {
			parts.push(int16(points[p][1] - prev));
			prev = points[p][1];
		}
		return padTo4(concatBytes(parts));
	}

	function uint8(value) {
		return new Uint8Array([value & 0xff]);
	}

	function uint16(value) {
		return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
	}

	function int16(value) {
		return uint16(value < 0 ? value + 0x10000 : value);
	}

	function uint32(value) {
		return new Uint8Array([
			(value >>> 24) & 0xff, (value >>> 16) & 0xff,
			(value >>> 8) & 0xff, value & 0xff
		]);
	}

	function readUint32(bytes, offset) {
		return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
			(bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
	}

	function writeUint32(bytes, offset, value) {
		bytes[offset] = (value >>> 24) & 0xff;
		bytes[offset + 1] = (value >>> 16) & 0xff;
		bytes[offset + 2] = (value >>> 8) & 0xff;
		bytes[offset + 3] = value & 0xff;
	}

	function stringToBytes(text) {
		var out = new Uint8Array(text.length);
		for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
		return out;
	}

	function stringFromBytes(bytes, offset, length) {
		var out = "";
		for (var i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
		return out;
	}

	function concatBytes(parts) {
		var total = 0;
		parts.forEach(function (part) { total += part.length; });
		var out = new Uint8Array(total);
		var at = 0;
		parts.forEach(function (part) {
			out.set(part, at);
			at += part.length;
		});
		return out;
	}

	function padTo4(bytes) {
		var remainder = bytes.length % 4;
		if (!remainder) return bytes;
		var out = new Uint8Array(bytes.length + (4 - remainder));
		out.set(bytes, 0);
		return out;
	}

	function tableChecksum(bytes) {
		var padded = padTo4(bytes);
		var total = 0;
		for (var i = 0; i < padded.length; i += 4) {
			total = (total + (((padded[i] << 24) | (padded[i + 1] << 16) |
				(padded[i + 2] << 8) | padded[i + 3]) >>> 0)) >>> 0;
		}
		return total;
	}

	function createPdfLogicalFont(pdf, units) {
		var PDFLib = window.PDFLib;
		var PDFHexString = PDFLib.PDFHexString;
		var PDFString = PDFLib.PDFString;
		var chunks = units.flatMap(function (unit) { return unit.chunks; });

		var cidById = new Map();
		var cidsBySemanticWidth = new Map();
		var gidByWidth = new Map();
		var gidForCid = [0];
		var mappings = [];
		var widths = [];
		var glyphWidths = [1000]; // GID 0: .notdef
		units.forEach(function (unit) {
			var previousCid = 0;
			unit.chunks.forEach(function (chunk) {
				var advance = chunkAdvanceWidth(chunk);
				var key = JSON.stringify([chunk.unicode, advance]);
				var variants = cidsBySemanticWidth.get(key);
				if (!variants) {
					variants = [];
					cidsBySemanticWidth.set(key, variants);
				}
				// PDFium may collapse adjacent copies of the same CID into one
				// extracted character. Alternate CIDs for adjacent identical
				// clusters, while mapping both to the same width-class GID.
				var cid = variants[0];
				if (cid === previousCid) cid = variants[1];
				if (cid === undefined) {
					cid = mappings.length + 1;
					if (cid > 0xffff) throw new Error("Too many distinct logical clusters on one page.");
					variants.push(cid);
					mappings.push([cidHex(cid), utf16BeHex(chunk.unicode)]);
					widths.push(cid, [advance]);
					var gid = gidByWidth.get(advance);
					if (gid === undefined) {
						gid = glyphWidths.length;
						gidByWidth.set(advance, gid);
						glyphWidths.push(advance);
					}
					gidForCid[cid] = gid;
				}
				cidById.set(chunk.id, cid);
				previousCid = cid;
			});
		});

		// CID encodes Unicode and its selected width; GID encodes geometry only.
		// The binary map is two big-endian bytes per CID, including CID zero.
		var gidBytes = new Uint8Array(gidForCid.length * 2);
		var gidView = new DataView(gidBytes.buffer);
		gidForCid.forEach(function (gid, cid) {
			gidView.setUint16(cid * 2, gid, false);
		});
		var cmap = buildToUnicodeCmap(mappings);
		var cmapRef = pdf.context.register(pdf.context.flateStream(cmap));
		var gidMapRef = pdf.context.register(pdf.context.flateStream(gidBytes));
		var fontBytes = buildLogicalFontProgram(glyphWidths);
		var fontFileRef = pdf.context.register(pdf.context.flateStream(fontBytes, {
			Length1: fontBytes.length
		}));
		var descriptorRef = pdf.context.register(pdf.context.obj({
			Type: "FontDescriptor",
			FontName: "TypsastraLogical",
			Flags: 4,
			FontBBox: [0, -LOGICAL_DESCENT, 1000, LOGICAL_ASCENT],
			ItalicAngle: 0,
			Ascent: LOGICAL_ASCENT,
			Descent: -LOGICAL_DESCENT,
			CapHeight: LOGICAL_ASCENT,
			StemV: 80,
			FontFile2: fontFileRef
		}));
		var descendantRef = pdf.context.register(pdf.context.obj({
			Type: "Font",
			Subtype: "CIDFontType2",
			BaseFont: "TypsastraLogical",
			CIDSystemInfo: {
				Registry: PDFString.of("Adobe"),
				Ordering: PDFString.of("Identity"),
				Supplement: 0
			},
			FontDescriptor: descriptorRef,
			DW: 1000,
			W: widths,
			CIDToGIDMap: gidMapRef
		}));
		var ref = pdf.context.register(pdf.context.obj({
			Type: "Font",
			Subtype: "Type0",
			BaseFont: "TypsastraLogical",
			Encoding: "Identity-H",
			DescendantFonts: [descendantRef],
			ToUnicode: cmapRef
		}));

		return {
			ref: ref,
			cidCount: mappings.length,
			glyphCount: glyphWidths.length,
			cidFor: function (chunk) { return PDFHexString.of(cidHex(cidById.get(chunk.id))); },
			cidsFor: function (chunks) {
				return PDFHexString.of(chunks.map(function (chunk) {
					return cidHex(cidById.get(chunk.id));
				}).join(""));
			}
		};
	}

	/**
	 * A cluster's advance width in 1000-unit em space, from its normalized CTC
	 * interval. Both ends are clamped so a degenerate or missing interval still
	 * yields a usable non-zero width.
	 */
	function chunkAdvanceWidth(chunk) {
		if (Number.isInteger(chunk.advance) && chunk.advance > 0) return chunk.advance;
		var start = Number(chunk.start);
		var end = Number(chunk.end);
		if (!Number.isFinite(start) || !Number.isFinite(end)) return 1000;
		var span = end - start;
		if (!(span > 0)) return 1;
		return Math.max(1, Math.round(span * 1000));
	}

	/**
	 * Shape the complete OCR line so Khmer substitutions and mark placement have
	 * their normal context. Prefix advances locate grapheme boundaries; measuring
	 * isolated glyphs would give the wrong width for subscript consonants. The
	 * synthetic PDF font remains one CID per cluster regardless of this choice.
	 * The source PDF font is used only when its subset name maps to an installed
	 * Unicode font. Otherwise OCR timing supplies the cluster widths.
	 */
	function measureShapedWidths(chunks, family) {
		if (!family || !chunks.length ||
			!chunks.some(function (chunk) { return /[\u1780-\u17ff]/.test(chunk.unicode); }) ||
			chunks.some(function (chunk) { return /[A-Za-z]/.test(chunk.unicode); }) ||
			typeof document === "undefined") return null;
		var canvas = document.createElement("canvas");
		var context = canvas.getContext("2d");
		if (!context) return null;
		var size = 64;
		context.font = size + 'px "' + family + '"';
		// An unavailable local font silently renders in a fallback face. Compare
		// a Khmer probe against an intentionally nonexistent family before using it.
		var probe = "សទ្ទានុក្រមពាក្យច្បាប់";
		var availableWidth = context.measureText(probe).width;
		context.font = size + 'px "TypsastraMissingWidthFace"';
		var fallbackWidth = context.measureText(probe).width;
		if (!Number.isFinite(availableWidth) || availableWidth <= 0 ||
			Math.abs(availableWidth - fallbackWidth) < 0.1) return null;
		context.font = size + 'px "' + family + '"';
		var prefix = "";
		var positions = [0];
		chunks.forEach(function (chunk) {
			prefix += chunk.unicode;
			positions.push(context.measureText(prefix).width);
		});
		var total = positions[positions.length - 1];
		if (!Number.isFinite(total) || total <= 0) return null;
		var result = [];
		for (var i = 1; i < positions.length; i++) {
			var delta = positions[i] - positions[i - 1];
			// Contextual shaping can move a prefix boundary backwards. Such a
			// cluster has no safe per-CID advance; keep OCR timing for this line.
			if (!Number.isFinite(delta) || delta <= 0) return null;
			result.push(Math.max(1, Math.round(delta * 1000 / total)));
		}
		return result;
	}

	/**
	 * Sum of a line's cluster advance widths, in 1000-unit em space. The drawn run
	 * spans this many ems at font size 1, so the caller scales by 1000 / total to
	 * make the run cover exactly one text-space unit.
	 */
	function advanceTotalFor(chunks) {
		return chunks.reduce(function (total, chunk) {
			return total + chunkAdvanceWidth(chunk);
		}, 0);
	}

	function buildToUnicodeCmap(mappings) {
		var lines = [
			"/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
			"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
			"/CMapName /TypsastraLogical-UCS def", "/CMapType 2 def",
			"1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange"
		];
		for (var offset = 0; offset < mappings.length; offset += 100) {
			var block = mappings.slice(offset, offset + 100);
			lines.push(block.length + " beginbfchar");
			for (var i = 0; i < block.length; i++) {
				lines.push("<" + block[i][0] + "> <" + block[i][1] + ">");
			}
			lines.push("endbfchar");
		}
		lines.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end", "");
		return lines.join("\n");
	}

	function cidHex(cid) {
		return cid.toString(16).padStart(4, "0").toUpperCase();
	}

	function utf16BeHex(text) {
		var hex = "";
		for (var index = 0; index < text.length; index++) {
			hex += text.charCodeAt(index).toString(16).padStart(4, "0");
		}
		return hex.toUpperCase();
	}

	/**
	 * Draw one recognized line as a single invisible text run spanning the line
	 * quad. Drawing the whole line in one text-showing operation (instead of one
	 * operation per chunk) is what stops PDF viewers from inserting spaces
	 * between chunks when the text is copied.
	 *
	 * The vertical text matrix vector must be unit length. A reader derives a
	 * glyph box of size * |vertical|, so passing the raw quad height there would
	 * scale the box by the height a second time and the selection would ignore
	 * both the detection box and the glyphs.
	 *
	 * The font box is 1 em tall (Ascent 740, Descent -260), so with a unit vertical
	 * vector the box height is exactly the font size: it carries the PDF selection
	 * height unchanged or grows an OCR detector box to reach the descenders. Width is
	 * scaled independently, because one font size cannot
	 * satisfy both axes at once. advanceTotal is the sum of the cluster widths in
	 * 1000-unit em space, taken from the CTC intervals, so each cluster advances
	 * by the share of the line the recognizer actually used; a run advances
	 * advanceTotal/1000 ems, and the horizontal vector is scaled by
	 * (1000/advanceTotal) / quadHeight so the run spans exactly the quad width.
	 */
	function drawInvisibleLogicalLine(page, fontKey, encodedCids, sourceQuad, sourcePage, advanceTotal, source, growthOverride) {
		var PDFLib = window.PDFLib;
		var quad = {};
		Object.keys(sourceQuad).forEach(function (name) {
			quad[name] = sourcePointToPdfPage(page, sourcePage, sourceQuad[name]);
		});
		var horizontal = { x: quad.p2.x - quad.p3.x, y: quad.p2.y - quad.p3.y };
		var vertical = { x: quad.p0.x - quad.p3.x, y: quad.p0.y - quad.p3.y };

		var verticalLength = Math.sqrt(vertical.x * vertical.x + vertical.y * vertical.y);
		if (verticalLength > 0) {
			vertical = { x: vertical.x / verticalLength, y: vertical.y / verticalLength };
		}

		// |vertical| is now 1, so the glyph box height equals the font size times
		// the font's ascent+descent, which is 1 em (Ascent 740, Descent -260). The
		// horizontal side is independent: a run advances advanceTotal/1000 ems, so
		// the size that makes it span the full line width is 1000 / advanceTotal.
		// Height and width are therefore scaled by the text matrix, not by the font
		// size, or one of them would be wrong: the font size can only satisfy one.
		var total = Number(advanceTotal);
		var widthSize = total > 0 ? 1000 / total : 1;
		// Bounding-box placements explicitly supply their own growth; preserved
		// PDF text and the legacy detector fallback retain their original values.
		var growth = Number.isFinite(growthOverride) ? growthOverride
			: (source === "pdf-selection" || source === "pdf-text" ? 1 : LOGICAL_BOX_GROWTH);
		var heightSize = verticalLength > 0 ? verticalLength * growth : 1;
		var widthScale = widthSize / heightSize;

		page.pushOperators(
			PDFLib.pushGraphicsState(),
			PDFLib.beginText(),
			PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.Invisible),
			PDFLib.setFontAndSize(fontKey, heightSize),
			PDFLib.setTextMatrix(horizontal.x * widthScale, horizontal.y * widthScale,
				vertical.x, vertical.y, quad.p3.x, quad.p3.y),
			PDFLib.showText(encodedCids),
			PDFLib.endText(),
			PDFLib.popGraphicsState()
		);
	}

	function sourcePointToPdfPage(page, sourcePage, point) {
		var crop = page.getCropBox();
		var rotation = ((page.getRotation().angle % 360) + 360) % 360;
		var u = point.x / sourcePage.width;
		var v = point.y / sourcePage.height;

		if (rotation === 90) {
			return { x: crop.x + v * crop.width, y: crop.y + u * crop.height };
		}
		if (rotation === 180) {
			return { x: crop.x + (1 - u) * crop.width, y: crop.y + v * crop.height };
		}
		if (rotation === 270) {
			return { x: crop.x + (1 - v) * crop.width, y: crop.y + (1 - u) * crop.height };
		}
		return { x: crop.x + u * crop.width, y: crop.y + (1 - v) * crop.height };
	}

	function setMetadata(pdf) {
		var now = new Date();
		try {
			pdf.setTitle(documentName() + " - PLU searchable PDF", { showInWindowTitleBar: true });
			pdf.setSubject(PDF_RECONSTRUCTION_DESCRIPTION + " " + PDF_RECONSTRUCTION_URL);
			pdf.setCreator(PDF_RECONSTRUCTION_TOOL);
			pdf.setProducer(PDF_RECONSTRUCTION_TOOL + " using pdf-lib 1.17.1");
			pdf.setKeywords([
				"Khmer", "OCR", "document reconstruction", "searchable PDF",
				"Unicode text layer", "PLU", "Typsastra"
			]);
			pdf.setLanguage("km");
			pdf.setCreationDate(now);
			pdf.setModificationDate(now);
		} catch (error) {
			// Metadata is best-effort.
		}
	}

	function fetchAsset(path) {
		return loadBinaryAsset(resourceUrl(path));
	}

	function saveBlob(bytes, filename) {
		var blob = new Blob([bytes], { type: "application/pdf" });
		var url = URL.createObjectURL(blob);
		var anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.rel = "noopener";
		document.body.appendChild(anchor);
		anchor.click();
		window.setTimeout(function () {
			document.body.removeChild(anchor);
			URL.revokeObjectURL(url);
		}, 2000);
	}

	function base64ToBytes(base64) {
		var binary = atob(base64);
		var bytes = new Uint8Array(binary.length);
		for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	/**
	 * Ask the editor for the original PDF bytes. Keeping the original page
	 * content (vector text, images) preserves the document quality; flattening
	 * the pages to the OCR raster does not. Returns null when unreachable, in
	 * which case the export falls back to the raster pages.
	 */
	function readOriginalPdfBytes() {
		return callCommand(function () {
			function toBase64(bytes) {
				var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
				var out = [];
				var length = bytes.length;
				for (var i = 0; i < length; i += 3) {
					var c1 = bytes[i];
					var c2 = i + 1 < length ? bytes[i + 1] : 0;
					var c3 = i + 2 < length ? bytes[i + 2] : 0;
					out.push(chars.charAt(c1 >> 2));
					out.push(chars.charAt(((c1 & 3) << 4) | (c2 >> 4)));
					out.push(i + 1 < length ? chars.charAt(((c2 & 15) << 2) | (c3 >> 6)) : "=");
					out.push(i + 2 < length ? chars.charAt(c3 & 63) : "=");
				}
				return out.join("");
			}
			function toByteArray(value) {
				if (!value) return null;
				if (typeof value === "string") {
					var arr = new Uint8Array(value.length);
					for (var i = 0; i < value.length; i++) arr[i] = value.charCodeAt(i) & 0xff;
					return arr;
				}
				if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return value;
				if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
				if (value.buffer && typeof value.byteLength === "number") {
					return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
				}
				return null;
			}

			try {
				var raw = null;
				try {
					var plugins = (typeof g_asc_plugins !== "undefined") ? g_asc_plugins : null;
					var api = plugins && plugins.api;
					var viewer = api && api.DocumentRenderer;
					if (viewer && typeof viewer.getFileNativeBinary === "function") {
						raw = viewer.getFileNativeBinary();
					}
				} catch (error1) {}
				try {
					if (!raw) {
						var ascEditor = (typeof Asc !== "undefined") ? Asc.editor : null;
						var viewer2 = ascEditor && ascEditor.DocumentRenderer;
						if (viewer2 && typeof viewer2.getFileNativeBinary === "function") {
							raw = viewer2.getFileNativeBinary();
						}
					}
				} catch (error2) {}
				try {
					if (!raw) {
						var file = Api.GetDocument().Document.GetFile();
						if (file && typeof file.getFileBinary === "function") raw = file.getFileBinary();
					}
				} catch (error3) {}

				if (!raw) return "ERR:nobytes";
				var bytes = toByteArray(raw);
				if (!bytes || !bytes.length) {
					return "ERR:type=" + (typeof raw) + ",len=" + (raw && raw.length);
				}
				return "OK:" + toBase64(bytes);
			} catch (error) {
				return "ERR:" + (error && error.message ? error.message : String(error));
			}
		}).then(function (result) {
			if (typeof result !== "string" || !result) {
				return { bytes: null, error: "no result from command" };
			}
			if (result.indexOf("OK:") === 0) {
				try {
					var bytes = base64ToBytes(result.substring(3));
					return { bytes: bytes.length > 4 ? bytes : null, error: bytes.length > 4 ? "" : "empty bytes" };
				} catch (error) {
					return { bytes: null, error: "base64 decode failed" };
				}
			}
			return { bytes: null, error: result };
		}).catch(function () {
			return { bytes: null, error: "callCommand failed" };
		});
	}

	function buildRasterPdf(PDFLib) {
		return PDFLib.PDFDocument.create().then(function (pdf) {
			var chain = Promise.resolve();
			state.pages.forEach(function (page, index) {
				chain = chain.then(function () {
					return pdf.embedPng(page.imageBytes).then(function (png) {
						var width = page.pdfWidth || page.width;
						var height = page.pdfHeight || page.height;
						var pdfPage = pdf.addPage([width, height]);
						pdfPage.drawImage(png, { x: 0, y: 0, width: width, height: height });
						setProgress((index + 1) / state.pages.length * 0.4,
							"Embedding page " + (index + 1) + " of " + state.pages.length + "…");
					});
				});
			});
			return chain.then(function () { return pdf; });
		});
	}

	function applyTextLayer(pdf, originalPreserved) {
		var accepted = buildLogicalUnits();
		if (!accepted.length) {
			throw new Error("Nothing to export: every recognized line was rejected.");
		}
		// The original PDF already contains these verified Latin lines. Do not
		// overlay a second selectable copy of them on top of the same ink.
		var units = accepted.filter(function (unit) {
			return !originalPreserved || unit.source !== "pdf-text";
		});
		state.logicalUnitCount = accepted.length;
		// Give each page its own font. CID/GID indices start at one per page; this
		// also bounds the font size for long documents without splitting a line.
		return Promise.resolve().then(function () {
			var byPage = new Map();
			units.forEach(function (unit) {
				if (!byPage.has(unit.pageIndex)) byPage.set(unit.pageIndex, []);
				byPage.get(unit.pageIndex).push(unit);
			});
			byPage.forEach(function (pageUnits, pageIndex) {
				var page = pdf.getPage(pageIndex);
				if (!page) return;
				var logicalFont = createPdfLogicalFont(pdf, pageUnits);
				var fontKey = page.node.newFontDictionary("TypsastraLogical", logicalFont.ref);
				pageUnits.forEach(function (unit) {
					drawInvisibleLogicalLine(
						page, fontKey, logicalFont.cidsFor(unit.chunks), unit.quad,
						state.pages[pageIndex], advanceTotalFor(unit.chunks), unit.source, unit.growth
					);
				});
				if (originalPreserved) {
					// The preserved PDF can contain a legacy Khmer text layer with a
					// broken Unicode mapping. If that layer comes first, PDFium's
					// hit-testing can return its garbled text instead of our OCR text
					// at the same coordinates. Put the newly written, invisible OCR
					// stream first; the original streams still paint the crisp page.
					var contents = page.node.Contents();
					if (contents instanceof window.PDFLib.PDFArray && contents.size() > 1) {
						var overlay = contents.get(contents.size() - 1);
						contents.remove(contents.size() - 1);
						contents.insert(0, overlay);
					}
				}
			});
			setMetadata(pdf);
			return pdf;
		});
	}

	function savePlu() {
		if (state.running || !state.pages.length) return;
		if (!window.PDFLib) {
			setStatus("PDF library did not load.");
			return;
		}

		state.running = true;
		updateButtons();
		setProgress(0, "Building PLU PDF…");
		setStatus("Building PLU PDF…");

		var PDFLib = window.PDFLib;
		var pdf = null;
		var usedOriginal = false;

		readOriginalPdfBytes()
			.then(function (result) {
				if (result.bytes) return result.bytes;
				return desktopOriginalBytes().then(function (bytes) {
					return bytes || webOriginalBytes();
				});
			})
			.then(function (bytes) {
				if (!bytes) return null;
				setStatus("Adding text layer to the original PDF…");
				return PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true }).catch(function () {
					return null;
				});
			})
			.then(function (loaded) {
				if (loaded) {
					pdf = loaded;
					usedOriginal = true;
					return pdf;
				}
				setNotice("Original PDF unavailable; exporting rendered page images instead (reduced quality).");
				return buildRasterPdf(PDFLib).then(function (created) {
					pdf = created;
					return pdf;
				});
			})
			.then(function () {
				return applyTextLayer(pdf, usedOriginal);
			})
			.then(function () {
				setProgress(0.85, "Saving…");
				return pdf.save();
			})
			.then(function (bytes) {
				saveBlob(bytes, documentName() + "-PLU.pdf");
				setProgress(1, "PLU PDF ready");
				setStatus("PLU PDF created: " + state.logicalUnitCount + " line(s)" +
					(usedOriginal ? ", original page quality kept" : ", rendered-page quality only") +
					(state.widthStats && state.widthStats.shaped ?
						", matched-font widths on " + state.widthStats.shaped + " Khmer line(s)" +
						(state.widthStats.fallback ? ", OCR timing on " +
							state.widthStats.fallback + " line(s)" : "") : "") + ".");
				window.setTimeout(function () { setProgress(null); }, 2500);
			})
			.catch(function (error) {
				console.error(error);
				setStatus("PLU export failed: " + (error && error.message ? error.message : String(error)));
				setProgress(null);
			})
			.then(function () {
				state.running = false;
				updateButtons();
			});
	}

	/* ------------------------------------------------------------ plugin glue */

	function applyTheme(theme) {
		var name = "";
		if (theme && typeof theme === "object") {
			name = theme.name || theme.type || "";
		} else if (typeof theme === "string") {
			name = theme;
		}
		document.documentElement.setAttribute("data-theme", name === "dark" ? "dark" : "light");
	}

	function bindUi() {
		el.engine = byId("engine");
		el.engineText = byId("engine-text");
		el.progressWrap = byId("progress-wrap");
		el.progressFill = byId("progress-fill");
		el.progressText = byId("progress-text");
		el.btnRun = byId("btn-run");
		el.btnRunPage = byId("btn-run-page");
		el.btnStop = byId("btn-stop");
		el.btnSave = byId("btn-save");
		el.btnClear = byId("btn-clear");
		el.threadsSelect = byId("opt-threads");
		el.parallelLabel = byId("parallel-label");
		if (el.parallelLabel && window.crossOriginIsolated)
			el.parallelLabel.textContent = "WASM threads";
		el.toolbar = byId("toolbar");
		el.summary = byId("summary");
		el.pages = byId("pages");
		el.empty = byId("empty");
		el.statusText = byId("status-text");
		el.content = byId("content");
		el.notice = byId("notice");

		if (el.btnRun) el.btnRun.addEventListener("click", runAllPages);
		if (el.btnRunPage) el.btnRunPage.addEventListener("click", runCurrentPage);
		if (el.btnStop) el.btnStop.addEventListener("click", stopOcr);
		if (el.btnSave) el.btnSave.addEventListener("click", savePlu);
		if (el.btnClear) el.btnClear.addEventListener("click", clearAll);
		if (byId("btn-accept-all")) byId("btn-accept-all").addEventListener("click", function () { setAllLines("accepted"); });
		if (byId("btn-reject-all")) byId("btn-reject-all").addEventListener("click", function () { setAllLines("rejected"); });

		var threadsSelect = el.threadsSelect;
		if (threadsSelect) {
			threadsSelect.value = String(state.threads);
			threadsSelect.addEventListener("change", function () {
				var value = Number(this.value);
				if (!Number.isInteger(value) || value < 1 || value > 8 || value === state.threads) return;
				state.threads = value;
				saveWorkerPreference(value);
				resetWorker();
			});
		}

		var viewGroup = byId("opt-view");
		if (viewGroup) {
			Array.prototype.forEach.call(viewGroup.querySelectorAll(".seg"), function (button) {
				button.addEventListener("click", function () {
					state.previewMode = button.getAttribute("data-view") === "page" ? "page" : "lines";
					Array.prototype.forEach.call(viewGroup.querySelectorAll(".seg"), function (other) {
						other.classList.toggle("active", other === button);
					});
					renderPages();
				});
			});
		}
	}

	window.Asc = window.Asc || {};
	window.Asc.plugin = window.Asc.plugin || {};

	window.Asc.plugin.init = function () {
		bindUi();
		applyTheme(window.Asc.plugin.theme);
		// Surface the running build so a stale cached copy is obvious at a glance.
		var stamp = byId("build-stamp");
		if (stamp) stamp.textContent = "build " + PLUGIN_BUILD;
		setStatus("Ready");
		setEngine("", "starting engine…");
		updateButtons();
		renderPages();
		ensureWorker().catch(function (error) {
			setEngine("error", "engine failed");
			setStatus("OCR engine failed: " + (error && error.message ? error.message : String(error)));
		});
	};

	window.Asc.plugin.button = function () {
		var plugin = this;
		pluginMethod("SetTextHighlight", [null, null]).catch(function () {}).then(function () {
			plugin.executeCommand("close", "");
		});
	};

	window.Asc.plugin.onThemeChanged = function (theme) {
		applyTheme(theme);
	};

	// The plugin bridge dispatches subscribed events as event_<eventName>.
	window.Asc.plugin.event_onContextMenuClick = function (item) {
		var id = item && typeof item === "object" ? item.id : item;
		if (id !== COPY_SELECTION_MENU_ID) return;
		if (item && Array.isArray(item.pages) && item.pages.length) {
			var pages = item.pages.filter(function (page) {
				return page && page.rotation % 360 === 0 && Array.isArray(page.quads) &&
					page.quads.some(function (quad) { return Array.isArray(quad) && quad.length === 8; });
			});
			if (pages.length) return copySelectionWithOcr(pages);
			else setStatus("Selected PDF text has no usable OCR geometry.");
		} else {
			return copyCurrentSelectionWithOcr();
		}
	};

	window.Asc.plugin.onTranslate = function () {
		// The panel is intentionally English-only in this version.
	};

	// Expose for manual debugging from the plugin console.
	window.KhmerOcrPlugin = {
		state: state,
		run: runAllPages,
		save: savePlu,
		clear: clearAll,
		selectionDetections: selectionDetections,
		selectionInkCoverage: selectionInkCoverage,
		quadForDetectorBox: quadForDetectorBox,
		detectorBoxGrowth: LOGICAL_ASCENT_GROWTH,
		pluPlacement: pluPlacement,
		readSelectionGeometry: readSelectionGeometry,
		ocrPage: ocrPage,
		ensureWorker: ensureWorker,
		resetWorker: resetWorker,
		readWorkerPreference: readWorkerPreference,
		saveWorkerPreference: saveWorkerPreference,
		selectedDetections: selectedDetections,
		attachSourceTextToRegions: attachSourceTextToRegions,
		readSelectedQuads: readSelectedQuads,
		copyRecognizedSelection: copyRecognizedSelection,
		copySelectionWithOcr: copySelectionWithOcr,
		hasSevereTextBoxOverlap: hasSevereTextBoxOverlap,
		pdfTextAnchors: pdfTextAnchors,
		sourceFontForLine: sourceFontForLine,
		extractedLatinLine: extractedLatinLine,
		restoreSourceLatin: restoreSourceLatin,
		restoreNativeKhmerWhenOcrChangesScript: restoreNativeKhmerWhenOcrChangesScript,
		isPluPdfMetadata: isPluPdfMetadata,
		pdfReconstructionTool: PDF_RECONSTRUCTION_TOOL
	};
})(window, undefined);
