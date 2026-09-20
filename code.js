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
	var WORKER_VERSION = "plugin-1";

	var RASTER_MAX_SIDE = 1800;
	var REVIEW_CONFIDENCE = 0.82;

	var PDF_RECONSTRUCTION_TOOL = "Typsastra Khmer Document Reconstruction";
	var PDF_RECONSTRUCTION_URL = "https://ocr.typsastra.com/";
	var PDF_RECONSTRUCTION_DESCRIPTION =
		"Reconstructed by Typsastra. Original page appearance is preserved as raster images; " +
		"the searchable Unicode text layer was generated with browser-local Khmer OCR and explicit review decisions.";

	var state = {
		worker: null,
		workerReady: false,
		workerError: null,
		workerInitPromise: null,
		engineMessage: "",
		readyWaiters: [],
		pageWaiters: {},
		requestId: 0,
		running: false,
		pages: [],
		status: "Ready",
		previewMode: "lines",
		threads: 4,
		effectiveThreads: 0
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

	function setProgress(fraction, text) {
		if (!el.progressWrap) return;
		var visible = fraction != null;
		el.progressWrap.hidden = !visible;
		if (!visible) return;
		var clamped = Math.max(0, Math.min(1, fraction));
		el.progressFill.style.width = (clamped * 100).toFixed(1) + "%";
		if (text != null) el.progressText.textContent = text;
	}

	function setEngine(kind, text) {
		if (!el.engine) return;
		el.engine.classList.remove("is-ready", "is-busy", "is-error");
		if (kind) el.engine.classList.add("is-" + kind);
		if (text != null) el.engineText.textContent = text;
	}

	function updateButtons() {
		var hasPages = state.pages.length > 0;
		var busy = state.running;
		if (el.btnRun) el.btnRun.disabled = busy || !state.workerReady;
		if (el.btnSave) el.btnSave.disabled = busy || !hasPages;
		if (el.btnClear) el.btnClear.disabled = busy || !hasPages;
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
					var dpi = page.Dpi || 72;
					info.sizes.push({
						width: page.W * 72 / dpi,
						height: page.H * 72 / dpi,
						rawWidth: page.W,
						rawHeight: page.H,
						dpi: dpi
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
		return loadText(workerBase + "ocr-worker.js").then(function (source) {
			var preamble = "self.__KHMER_OCR_BASE__ = " + JSON.stringify(workerBase) + ";\n" +
				"self.__KHMER_OCR_LOCAL__ = true;\n" +
				"self.__KHMER_OCR_THREADS__ = " + JSON.stringify(state.threads) + ";\n";
			var blob = new Blob([preamble + source], { type: "text/javascript" });
			return new Worker(URL.createObjectURL(blob));
		});
	}

	function resetWorker() {
		if (state.worker) {
			try { state.worker.terminate(); } catch (ignore) {}
		}
		state.worker = null;
		state.workerReady = false;
		state.workerError = null;
		state.workerInitPromise = null;
		state.engineMessage = "";
		state.effectiveThreads = 0;
		updateButtons();
		setEngine("", "starting engine…");
		setStatus("Starting OCR engine…");
		ensureWorker().catch(function () {
			// ensureWorker already reports the failure.
		});
	}

	function ensureWorker() {
		if (state.workerReady) return Promise.resolve();
		if (state.workerError) return Promise.reject(state.workerError);
		if (state.workerInitPromise) return state.workerInitPromise;

		setEngine("busy", "loading OCR models…");
		setStatus("Loading OCR engine…");

		state.workerInitPromise = createWorker().then(function (worker) {
			return new Promise(function (resolve, reject) {
				var settled = false;
				var timeout = setTimeout(function () {
					if (settled) return;
					settled = true;
					state.workerError = new Error(
						"OCR engine initialization timed out (" + (state.engineMessage || "no progress reported") + ")"
					);
					state.workerInitPromise = null;
					try { worker.terminate(); } catch (ignore) {}
					reject(state.workerError);
				}, 120000);

				function finish(error) {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					if (error) {
						state.workerError = error;
						state.workerInitPromise = null;
						reject(error);
					} else {
						state.workerReady = true;
						state.workerError = null;
						updateButtons();
						resolve();
					}
				}

				state.worker = worker;
				state.readyWaiters.push({ resolve: function () { finish(null); } });

				worker.addEventListener("message", onWorkerMessage);
				worker.addEventListener("error", function (event) {
					var error = new Error(event && event.message ? event.message : "OCR worker error");
					state.workerReady = false;
					state.workerError = error;
					state.workerInitPromise = null;
					rejectPending(error);
					finish(error);
					setEngine("error", "engine failed");
					setStatus("OCR engine failed: " + error.message);
				});

				worker.postMessage({ type: "init", requestId: ++state.requestId });
			});
		}).catch(function (error) {
			state.workerError = error;
			state.workerInitPromise = null;
			setEngine("error", "engine failed");
			setStatus("OCR engine failed: " + (error && error.message ? error.message : String(error)));
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
		state.readyWaiters.forEach(function (waiter) {
			waiter.reject(error);
		});
		state.readyWaiters.length = 0;
	}

	function onWorkerMessage(event) {
		var message = event.data;
		if (!message || typeof message !== "object") return;

		switch (message.type) {
			case "ready":
				state.effectiveThreads = message.wasm && message.wasm.threads ? message.wasm.threads : 1;
				setEngine("ready", "engine ready · " + state.effectiveThreads + " thread" +
					(state.effectiveThreads === 1 ? "" : "s"));
				setStatus("OCR engine ready (" + state.effectiveThreads + " thread" +
					(state.effectiveThreads === 1 ? "" : "s") + ")");
				state.readyWaiters.forEach(function (waiter) { waiter.resolve(); });
				state.readyWaiters.length = 0;
				updateButtons();
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
				setProgress(0.02 + 0.05 * (message.progress || 0), "Detecting text…");
				break;
			case "recognition-progress":
				setProgress(
					0.07 + 0.08 * (message.progress || 0),
					"Recognizing line " + (message.completed || 0) + " of " + (message.total || 0) + "…"
				);
				break;
			case "segmenting":
				setProgress(0.15 + 0.03 * (message.progress || 0), "Segmenting Khmer text…");
				break;
			case "page-ready": {
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
				} else {
					state.readyWaiters.forEach(function (item) { item.reject(failure); });
					state.readyWaiters.length = 0;
				}
				break;
			}
			default:
				break;
		}
	}

	function ocrPage(pageIndex, image) {
		var requestId = ++state.requestId;
		return new Promise(function (resolve, reject) {
			state.pageWaiters[requestId] = { resolve: resolve, reject: reject };
			state.worker.postMessage({
				type: "process-page",
				requestId: requestId,
				page: pageIndex,
				pageId: pageIndex,
				width: image.width,
				height: image.height,
				rgba: image.rgba
			});
		});
	}

	/* -------------------------------------------------------------- OCR driver */

	function runOcr() {
		if (state.running) return;
		state.running = true;
		updateButtons();
		setProgress(0, "Preparing…");
		setStatus("Preparing…");

		ensureWorker()
			.then(function () {
				return readDocumentInfo();
			})
			.then(function (info) {
				var pageCount = Number(info.count);
				if (!Number.isFinite(pageCount) || pageCount <= 0) {
					throw new Error("Could not determine the number of pages");
				}
				state.pages = [];
				renderPages();

				var chain = Promise.resolve();
				for (var index = 0; index < pageCount; index++) {
					chain = chain.then(function (pageIndex) {
						return processPage(pageIndex, pageCount, info.sizes);
					}.bind(null, index));
				}
				return chain;
			})
			.then(function () {
				setProgress(1, "OCR finished");
				setStatus("OCR finished. Review the lines, then save as PLU PDF.");
				updateButtons();
				window.setTimeout(function () { setProgress(null); }, 1500);
			})
			.catch(function (error) {
				console.error(error);
				setStatus("OCR failed: " + (error && error.message ? error.message : String(error)));
				setProgress(null);
			})
			.then(function () {
				state.running = false;
				updateButtons();
			});
	}

	function processPage(pageIndex, pageCount, sizes) {
		var base = pageIndex / pageCount;
		setProgress(base, "Reading page " + (pageIndex + 1) + " of " + pageCount + "…");
		setStatus("Reading page " + (pageIndex + 1) + " of " + pageCount + "…");

		var size = sizes && sizes[pageIndex] ? sizes[pageIndex] : null;
		var expectedAspect = size && size.width && size.height ? (size.width / size.height) : null;
		var image;
		return pluginMethod("GetPageImage", [pageIndex, { maxSize: RASTER_MAX_SIDE }])
			.then(function (dataUrl) {
				if (typeof dataUrl !== "string" || dataUrl.indexOf("data:") !== 0) {
					throw new Error("Editor returned no image for page " + (pageIndex + 1));
				}
				return decodeDataUrl(dataUrl, expectedAspect);
			})
			.then(function (decoded) {
				image = decoded;
				return ocrPage(pageIndex, image);
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
					pdfWidth: size && size.width ? size.width : widthPx * 0.75,
					pdfHeight: size && size.height ? size.height : heightPx * 0.75,
					editorSize: size || null,
					lines: lines,
					error: null
				});
				setStatus("Page " + (pageIndex + 1) + ": raster " + widthPx + "×" + heightPx +
					", editor " + (size && size.rawWidth != null ? size.rawWidth : "?") + "×" +
					(size && size.rawHeight != null ? size.rawHeight : "?") +
					" dpi " + (size && size.dpi != null ? size.dpi : "?"));
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

	function buildPagePreview(page) {
		var wrap = document.createElement("div");
		wrap.className = "page-preview";

		var image = document.createElement("img");
		image.className = "page-img";
		image.src = page.imageUrl;
		image.alt = "Page " + (page.index + 1);
		wrap.appendChild(image);

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
		if (page.editorSize && page.editorSize.rawWidth != null) {
			metaParts.push("editor " + Math.round(page.editorSize.rawWidth) + "×" +
				Math.round(page.editorSize.rawHeight) + " @" + page.editorSize.dpi + "dpi");
		}
		meta.textContent = metaParts.join(" · ");

		head.appendChild(caret);
		head.appendChild(title);
		head.appendChild(meta);
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
		text.title = "Click to show the pixels the recognizer used";
		text.addEventListener("click", function () {
			toggleLineCrop(page, line, row);
		});

		var meta = document.createElement("div");
		meta.className = "line-meta";

		var confidence = document.createElement("span");
		confidence.className = "conf";
		var value = Number(line.confidence);
		if (Number.isFinite(value) && value < REVIEW_CONFIDENCE) confidence.classList.add("low");
		confidence.textContent = formatConfidence(line.confidence);

		var reject = document.createElement("button");
		reject.type = "button";
		reject.className = "reject";
		reject.textContent = line.status === "rejected" ? "Rejected" : "Reject";
		reject.title = line.status === "rejected" ? "Keep this line after all" : "Reject this line as wrong";
		reject.addEventListener("click", function () {
			toggleReject(line);
		});

		meta.appendChild(confidence);
		meta.appendChild(reject);
		row.appendChild(text);
		row.appendChild(meta);
		return row;
	}

	function setAllLines(status) {
		state.pages.forEach(function (page) {
			page.lines.forEach(function (line) { line.status = status; });
		});
		renderPages();
	}

	function clearAll() {
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

	function buildLogicalUnits() {
		var units = [];
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
				units.push({
					id: lineId++,
					pageIndex: pageIndex,
					unicode: unicode,
					chunks: chunks,
					quad: line.alignmentQuad || line.quad
				});
			});
		});
		return units;
	}

	function createPdfLogicalFont(pdf, units, fontBytes) {
		var PDFLib = window.PDFLib;
		var PDFHexString = PDFLib.PDFHexString;
		var PDFString = PDFLib.PDFString;
		var embeddedFontBytes = fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
		var chunks = units.flatMap(function (unit) { return unit.chunks; });
		if (chunks.length > 0xffff) {
			throw new Error("A document cannot contain more than 65,535 semantic text chunks.");
		}

		var cidById = new Map();
		var mappings = [];
		var widths = [];
		var cidToGid = new Uint8Array((chunks.length + 1) * 2);
		chunks.forEach(function (chunk, index) {
			var cid = index + 1;
			cidById.set(chunk.id, cid);
			mappings.push([cidHex(cid), utf16BeHex(chunk.unicode)]);
			widths.push(cid, [1000]);
			// Semantic CIDs are independent from visual GIDs. The flattened page image
			// supplies the visual representation, so every invisible chunk uses .notdef.
		});

		var cmap = buildToUnicodeCmap(mappings);
		var cmapRef = pdf.context.register(pdf.context.flateStream(cmap));
		var cidToGidRef = pdf.context.register(pdf.context.flateStream(cidToGid));
		var fontFileRef = pdf.context.register(pdf.context.flateStream(embeddedFontBytes, {
			Length1: embeddedFontBytes.length
		}));
		var descriptorRef = pdf.context.register(pdf.context.obj({
			Type: "FontDescriptor",
			FontName: "TypsastraLogical",
			Flags: 4,
			FontBBox: [0, 0, 1000, 1000],
			ItalicAngle: 0,
			Ascent: 1000,
			Descent: 0,
			CapHeight: 1000,
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
			CIDToGIDMap: cidToGidRef
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
			cidFor: function (chunk) { return PDFHexString.of(cidHex(cidById.get(chunk.id))); }
		};
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

	function logicalChunkQuad(quad, start, end) {
		function interpolate(from, to, position) {
			return {
				x: from.x + (to.x - from.x) * position,
				y: from.y + (to.y - from.y) * position
			};
		}
		return {
			p0: interpolate(quad.p0, quad.p1, start),
			p1: interpolate(quad.p0, quad.p1, end),
			p2: interpolate(quad.p3, quad.p2, end),
			p3: interpolate(quad.p3, quad.p2, start)
		};
	}

	function drawInvisibleLogicalChunkInQuad(page, fontKey, encodedCid, sourceQuad, sourcePage) {
		var PDFLib = window.PDFLib;
		var quad = {};
		Object.keys(sourceQuad).forEach(function (name) {
			quad[name] = sourcePointToPdfPage(page, sourcePage, sourceQuad[name]);
		});
		var horizontal = { x: quad.p2.x - quad.p3.x, y: quad.p2.y - quad.p3.y };
		var vertical = { x: quad.p0.x - quad.p3.x, y: quad.p0.y - quad.p3.y };

		page.pushOperators(
			PDFLib.pushGraphicsState(),
			PDFLib.beginText(),
			PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.Invisible),
			PDFLib.setFontAndSize(fontKey, 1),
			PDFLib.setTextMatrix(horizontal.x, horizontal.y, vertical.x, vertical.y, quad.p3.x, quad.p3.y),
			PDFLib.showText(encodedCid),
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
		var pdf;

		PDFLib.PDFDocument.create()
			.then(function (created) {
				pdf = created;
				var chain = Promise.resolve();
				state.pages.forEach(function (page, index) {
					chain = chain.then(function () {
						return pdf.embedPng(page.imageBytes).then(function (png) {
							var width = page.pdfWidth || page.width;
							var height = page.pdfHeight || page.height;
							var pdfPage = pdf.addPage([width, height]);
							pdfPage.drawImage(png, { x: 0, y: 0, width: width, height: height });
							setProgress((index + 1) / state.pages.length * 0.5,
								"Embedding page " + (index + 1) + " of " + state.pages.length + "…");
						});
					});
				});
				return chain;
			})
			.then(function () {
				var units = buildLogicalUnits();
				state.logicalUnitCount = units.length;
				return fetchAsset("assets/TypsastraLogical.ttf").then(function (fontBytes) {
					return { units: units, fontBytes: fontBytes };
				});
			})
			.then(function (payload) {
				if (!payload.units.length) {
					throw new Error("Nothing to export: every recognized line was rejected.");
				}
				var logicalFont = createPdfLogicalFont(pdf, payload.units, payload.fontBytes);
				var fontKeys = new Map();
				payload.units.forEach(function (unit) {
					var sourcePage = state.pages[unit.pageIndex];
					var page = pdf.getPage(unit.pageIndex);
					var fontKey = fontKeys.get(unit.pageIndex);
					if (!fontKey) {
						fontKey = page.node.newFontDictionary("TypsastraLogical", logicalFont.ref);
						fontKeys.set(unit.pageIndex, fontKey);
					}
					unit.chunks.forEach(function (chunk) {
						drawInvisibleLogicalChunkInQuad(
							page,
							fontKey,
							logicalFont.cidFor(chunk),
							logicalChunkQuad(unit.quad, chunk.start, chunk.end),
							sourcePage
						);
					});
				});
				setMetadata(pdf);
				return pdf.save();
			})
			.then(function (bytes) {
				saveBlob(bytes, documentName() + "-PLU.pdf");
				setProgress(1, "PLU PDF ready");
				setStatus("PLU PDF created: " + state.logicalUnitCount + " text line(s).");
				window.setTimeout(function () { setProgress(null); }, 2000);
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
		el.btnSave = byId("btn-save");
		el.btnClear = byId("btn-clear");
		el.toolbar = byId("toolbar");
		el.summary = byId("summary");
		el.pages = byId("pages");
		el.empty = byId("empty");
		el.statusText = byId("status-text");
		el.content = byId("content");

		if (el.btnRun) el.btnRun.addEventListener("click", runOcr);
		if (el.btnSave) el.btnSave.addEventListener("click", savePlu);
		if (el.btnClear) el.btnClear.addEventListener("click", clearAll);
		if (byId("btn-accept-all")) byId("btn-accept-all").addEventListener("click", function () { setAllLines("accepted"); });
		if (byId("btn-reject-all")) byId("btn-reject-all").addEventListener("click", function () { setAllLines("rejected"); });

		var threadsSelect = byId("opt-threads");
		if (threadsSelect) {
			threadsSelect.value = String(state.threads);
			threadsSelect.addEventListener("change", function () {
				var value = Number(this.value);
				if (!Number.isInteger(value) || value < 1 || value > 8 || value === state.threads) return;
				state.threads = value;
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
		this.executeCommand("close", "");
	};

	window.Asc.plugin.onThemeChanged = function (theme) {
		applyTheme(theme);
	};

	window.Asc.plugin.onTranslate = function () {
		// The panel is intentionally English-only in this version.
	};

	// Expose for manual debugging from the plugin console.
	window.KhmerOcrPlugin = {
		state: state,
		run: runOcr,
		save: savePlu,
		clear: clearAll
	};
})(window, undefined);
