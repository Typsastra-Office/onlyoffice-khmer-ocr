/* global importScripts, ort */
"use strict";

/**
 * Browser-local Khmer OCR classic Web Worker.
 *
 * Incoming messages:
 *   { type: "init", requestId?, config? }
 *   { type: "process-page", requestId?, page, pageId?, width, height, rgba }
 *   { type: "recognize-page", requestId?, page, pageId?, width, height, rgba, detections }
 *
 * Every outgoing message includes `requestId`, `page`, and `pageId`. Candidate
 * probabilities are exact softmax probabilities, but are computed only at the
 * strongest representative timestep of each emitted CTC unit to avoid a full
 * softmax at every timestep.
 */

var ORT_VERSION = "1.23.2";

/**
 * Absolute base URL of this worker's folder, always ending with "/".
 *
 * Normally it is derived from the worker script location. When the host
 * instantiates this worker from a Blob (a workaround for the file:// worker
 * restrictions in the ONLYOFFICE desktop app), it prepends
 * `self.__KHMER_OCR_BASE__` with the absolute folder URL.
 */
var RESOURCE_BASE = (function () {
  var base = (typeof self.__KHMER_OCR_BASE__ === "string" && self.__KHMER_OCR_BASE__)
    ? self.__KHMER_OCR_BASE__
    : new URL(".", self.location.href).href;
  return base.charAt(base.length - 1) === "/" ? base : base + "/";
})();

var ORT_DIST_URL = RESOURCE_BASE + "vendor/ort/";

function resourceUrl(path) {
  return new URL(path, RESOURCE_BASE).href;
}

/**
 * Load a binary resource with XMLHttpRequest. XHR is used instead of fetch so
 * the same code works on the file:// pages used by the desktop app, where
 * fetch() is not available for local files.
 * @param {string} url
 * @returns {Promise<Uint8Array>}
 */
function loadArrayBuffer(url) {
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
    xhr.onerror = function () {
      reject(new Error("Unable to load " + url));
    };
    xhr.send(null);
  });
}

/**
 * Load and parse a JSON resource.
 * @param {string} url
 * @returns {Promise<*>}
 */
function loadJson(url) {
  return loadArrayBuffer(url).then(function (bytes) {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  });
}
var ortLoaded = false;
var hardwareConcurrency = self.navigator && self.navigator.hardwareConcurrency || 1;
var workerParameters = new URL(self.location.href).searchParams;
var requestedWasmThreads = (typeof self.__KHMER_OCR_THREADS__ === "number")
  ? self.__KHMER_OCR_THREADS__
  : Number(workerParameters.get("threads") || 4);
if (!Number.isInteger(requestedWasmThreads) || requestedWasmThreads < 1 || requestedWasmThreads > 8) {
  requestedWasmThreads = 4;
}
var wasmThreadCount = self.crossOriginIsolated ? requestedWasmThreads : 1;

/**
 * Load ONNX Runtime Web on first use. This is deferred instead of running at
 * worker top level so that a failure surfaces through the normal error channel
 * rather than leaving the worker unresponsive.
 */
function xhrTextSync(url) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.send(null);
  if (!xhr.responseText || (xhr.status !== 200 && xhr.status !== 0)) {
    throw new Error("Unable to load " + url + " (status " + xhr.status + ")");
  }
  return xhr.responseText;
}

function xhrBufferSync(url) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer";
  xhr.send(null);
  if (!xhr.response || (xhr.status !== 200 && xhr.status !== 0)) {
    throw new Error("Unable to load " + url + " (status " + xhr.status + ")");
  }
  return new Uint8Array(xhr.response);
}

/**
 * Load ONNX Runtime Web and configure its WASM backend.
 *
 * Deferred instead of running at worker top level so failures surface through
 * the normal error channel. On the desktop (file://) the runtime, its module
 * glue and the WASM binary are read with XMLHttpRequest and handed to ORT
 * directly, because fetch()/importScripts() against the custom scheme are
 * unreliable and ORT must never fetch anything itself.
 */
async function ensureOrt() {
  if (ortLoaded) return;
  var glueUrl = ORT_DIST_URL + "ort-wasm-simd-threaded.js";
  var wasmUrl = ORT_DIST_URL + "ort-wasm-simd-threaded.wasm";
  if (self.__KHMER_OCR_LOCAL__) {
    // ort.min.js starts with "use strict", so indirect eval would keep `ort`
    // local; wrap it and publish the value on the worker global scope.
    self.ort = new Function(xhrTextSync(ORT_DIST_URL + "ort.min.js") + "\n;return ort;")();
    if (!self.ort || !self.ort.env) {
      throw new Error("ONNX Runtime did not initialize");
    }
    // Hand ONNX Runtime Blob URLs for both the module glue and the WASM binary.
    // The glue is imported as a module, and a Blob module has no meaningful
    // import.meta.url, so the WASM must be reachable through an absolute
    // locateFile URL (which ORT derives from wasmPaths.wasm).
    var glue = xhrTextSync(glueUrl);
    var wasmBytes = xhrBufferSync(wasmUrl);
    ort.env.wasm.wasmPaths = {
      mjs: URL.createObjectURL(new Blob([glue], { type: "text/javascript" })),
      wasm: URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }))
    };
    // Probe the module import that ONNX Runtime will perform. The URL is then
    // cached, and a failure here is reported as a runtime-loading error instead
    // of a silent stall inside InferenceSession.create().
    await import(ort.env.wasm.wasmPaths.mjs);
  } else {
    importScripts(ORT_DIST_URL + "ort.min.js");
    ort.env.wasm.wasmPaths = { mjs: glueUrl, wasm: wasmUrl };
  }
  ort.env.wasm.numThreads = wasmThreadCount;
  ort.env.wasm.proxy = false;
  ortLoaded = true;
}

var DEFAULT_CONFIG = Object.freeze({
  detectorMaxSide: 960,
  detectionThreshold: 0.3,
  boxScoreThreshold: 0.5,
  minSide: 3,
  unclipRatio: 1.5,
  boxAngleSnapDegrees: 25,
  leaderDotMaxThickness: 10,
  leaderDotMinAspectRatio: 6,
  leaderDotMaxScore: 0.9,
  maxDetections: 300,
  recognizerMaxWidth: 2048,
  cropPaddingTopRatio: 0.1,
  cropPaddingBottomRatio: 0.1,
  cropPaddingLeftPixels: 0,
  cropPaddingRightPixels: 5,
  lineMergeGapRatio: 1.0,
});

var config = copyConfig(DEFAULT_CONFIG);
var detectorSession = null;
var recognizerSession = null;
var vocabulary = null;
var initialized = false;

var requestSequence = 0;
var workQueue = Promise.resolve();

var IMAGENET_MEAN = [0.485, 0.456, 0.406];
var IMAGENET_STD = [0.229, 0.224, 0.225];
var DETECTOR_INPUT = "x";
var DETECTOR_OUTPUT = "fetch_name_0";
var RECOGNIZER_IMAGE_INPUT = "images";
var RECOGNIZER_WIDTH_INPUT = "widths";
var RECOGNIZER_LOGITS_OUTPUT = "logits";
var RECOGNIZER_LENGTHS_OUTPUT = "lengths";
var RECOGNIZER_HEIGHT = 48;
var RECOGNIZER_CLASSES = 4096;

/** @typedef {{x:number, y:number}} Point */
/** @typedef {{p0:Point, p1:Point, p2:Point, p3:Point}} Quad */
/** @typedef {{region:number, line:number, position:number}} ReadingOrder */
/** @typedef {{id:number, quad:Quad, score:number, order:ReadingOrder}} Detection */
/** @typedef {{text:string, score:number}} KccCandidate */
/**
 * @typedef {Object} RecognizedUnit
 * @property {string} rawText Exact vocabulary string; no Unicode normalization.
 * @property {number} timestepStart Inclusive CTC timestep.
 * @property {number} timestepEnd Exclusive CTC timestep.
 * @property {KccCandidate[]} candidates Top three at the representative timestep.
 * @property {number} confidence Exact softmax probability at that timestep.
 */
/**
 * @typedef {Object} RecognizedLine
 * @property {number} detectionId
 * @property {Quad} quad
 * @property {RecognizedUnit[]} units
 * @property {string} rawText
 * @property {number} confidence
 * @property {ReadingOrder} order
 * @property {Quad} alignmentQuad Actual padded/straightened recognizer crop.
 * @property {number} ctcLength Valid recognizer timestep count.
 * @property {number} ctcContentLength Unpadded sampled content width in timestep units.
 */

self.onmessage = function (event) {
  var message = event.data;
  var requestId = message && message.requestId != null
    ? message.requestId
    : message && message.id != null
      ? message.id
      : ++requestSequence;
  var page = message && message.page != null ? message.page : null;
  var pageId = message && message.pageId != null ? message.pageId : page;

  workQueue = workQueue.then(function () {
    return handleMessage(message, requestId, page, pageId);
  }).catch(function (error) {
    postError(error, requestId, page, pageId, "message");
  });
};

/**
 * Dispatch one protocol message. Work is serialized so ORT sessions are never
 * used concurrently and page progress remains ordered.
 * @param {*} message
 * @param {*} requestId
 * @param {*} page
 * @param {*} pageId
 * @returns {Promise<void>}
 */
async function handleMessage(message, requestId, page, pageId) {
  if (!message || typeof message !== "object") {
    throw new Error("Worker message must be an object");
  }

  if (message.type === "init") {
    await initialize(message.config, message.runtime, requestId);
    return;
  }

  if (message.type === "process-page") {
    await processPage(message, requestId, page, pageId);
    return;
  }

  if (message.type === "recognize-page") {
    await recognizePage(message, requestId, page, pageId);
    return;
  }

  throw new Error("Unsupported worker message type: " + String(message.type));
}

/**
 * Load the detector, recognizer and vocabulary.
 * @param {Object<string, *>|undefined} overrides
 * @param {Object<string, *>|undefined} runtimeOverrides
 * @param {*} requestId
 */
async function initialize(overrides, runtimeOverrides, requestId) {
  config = validatedConfig(overrides);
  validatedRuntimeConfig(runtimeOverrides);
  postEvent("page-state", requestId, null, null, { state: "initializing" });

  postEvent("engine-progress", requestId, null, null, { stage: "onnxruntime", message: "Loading ONNX Runtime…" });
  try {
    await ensureOrt();
  } catch (error) {
    throw withStage(error, "loading ONNX Runtime Web " + ORT_VERSION);
  }

  var manifestUrl = resourceUrl("models/manifest.json");
  var nextDetector = null;
  var nextRecognizer = null;

  try {
    postEvent("engine-progress", requestId, null, null, { stage: "manifest", message: "Loading model manifest…" });
    var modelManifest = await fetchModelManifest(manifestUrl);
    var vocabUrl = versionedModelUrl(modelManifest, "vocab.json");
    var detectorUrl = versionedModelUrl(modelManifest, "detector_tiny.onnx");
    postEvent("engine-progress", requestId, null, null, { stage: "vocab", message: "Loading vocabulary…" });
    var nextVocabulary = await loadJson(vocabUrl);
    if (!Array.isArray(nextVocabulary) || nextVocabulary.length !== RECOGNIZER_CLASSES) {
      throw new Error("models/vocab.json must contain exactly " + RECOGNIZER_CLASSES + " strings");
    }
    for (var i = 0; i < nextVocabulary.length; i++) {
      if (typeof nextVocabulary[i] !== "string") {
        throw new Error("models/vocab.json entry " + i + " is not a string");
      }
    }

    var sessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    };
    // Load the model bytes directly so no host-specific fetch behaviour is
    // needed for the ONNX Runtime file loader.
    postEvent("engine-progress", requestId, null, null, { stage: "detector", message: "Downloading detector model…" });
    var detectorBytes = await loadArrayBuffer(detectorUrl);
    postEvent("engine-progress", requestId, null, null, { stage: "detector-init", message: "Starting OCR engine…" });
    nextDetector = await ort.InferenceSession.create(detectorBytes, sessionOptions);
    postEvent("engine-progress", requestId, null, null, { stage: "recognizer", message: "Loading recognizer model…" });
    var recognizerUrl = versionedModelUrl(modelManifest, "recognizer-int8.onnx");
    var recognizerBytes = await loadArrayBuffer(recognizerUrl);
    nextRecognizer = await ort.InferenceSession.create(recognizerBytes, sessionOptions);

    assertNames(nextDetector.inputNames, [DETECTOR_INPUT], "detector input");
    assertNames(nextDetector.outputNames, [DETECTOR_OUTPUT], "detector output");
    assertNames(nextRecognizer.inputNames, [RECOGNIZER_IMAGE_INPUT, RECOGNIZER_WIDTH_INPUT], "recognizer input");
    assertNames(nextRecognizer.outputNames, [RECOGNIZER_LOGITS_OUTPUT, RECOGNIZER_LENGTHS_OUTPUT], "recognizer output");

    safeDispose(detectorSession);
    safeDispose(recognizerSession);
    detectorSession = nextDetector;
    recognizerSession = nextRecognizer;
    vocabulary = nextVocabulary;
    initialized = true;
  } catch (error) {
    safeDispose(nextDetector);
    safeDispose(nextRecognizer);
    initialized = false;
    throw withStage(error, "initializing OCR models");
  }

  postEvent("page-state", requestId, null, null, { state: "ready" });
  postEvent("ready", requestId, null, null, {
    runtime: "onnxruntime-web",
    version: ORT_VERSION,
    executionProviders: {
      detector: ["wasm"],
      recognizer: ["wasm"]
    },
    capabilities: {
      hardwareConcurrency: hardwareConcurrency
    },
    wasm: {
      simd: true,
      requestedThreads: requestedWasmThreads,
      threads: wasmThreadCount,
      crossOriginIsolated: Boolean(self.crossOriginIsolated)
    },
    config: copyConfig(config)
  });
}

async function fetchModelManifest(url) {
  var manifest = await loadJson(url);
  if (!manifest || manifest.version !== 2 || !manifest.assets || typeof manifest.assets !== "object" ||
      !manifest.models || typeof manifest.models !== "object") {
    throw new Error("Model manifest must use version 2 and contain `assets` and `models` objects");
  }
  return manifest;
}

function versionedModelUrl(manifest, filename) {
  var metadata = manifest.assets[filename];
  var hash = metadata && metadata.sha256;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Model manifest contains an invalid SHA-256 for " + filename);
  }
  return resourceUrl("models/" + filename);
}


function validatedRuntimeConfig(overrides) {
  if (overrides != null && (typeof overrides !== "object" || Array.isArray(overrides))) {
    throw new Error("init `runtime` must be an object");
  }
  if (overrides && overrides.int8Threads != null && overrides.int8Threads !== requestedWasmThreads) {
    throw new Error("runtime.int8Threads must match the worker thread parameter");
  }
  return { int8Threads: requestedWasmThreads };
}


/**
 * Detect and recognize one RGBA page.
 * @param {*} message
 * @param {*} requestId
 * @param {*} page
 * @param {*} pageId
 */
async function processPage(message, requestId, page, pageId) {
  if (!initialized || !detectorSession || !recognizerSession || !vocabulary) {
    throw new Error("OCR worker is not initialized; send {type:'init'} first");
  }
  if (page == null) {
    throw new Error("process-page requires a page ID in `page`");
  }

  if (message.config != null) {
    config = validatedConfig(Object.assign(copyConfig(config), message.config));
  }
  var width = positiveInteger(message.width, "width");
  var height = positiveInteger(message.height, "height");
  if (!(message.rgba instanceof ArrayBuffer)) {
    throw new Error("process-page `rgba` must be an ArrayBuffer");
  }
  var expectedBytes = width * height * 4;
  if (!Number.isSafeInteger(expectedBytes) || message.rgba.byteLength !== expectedBytes) {
    throw new Error("RGBA byte length mismatch: expected " + expectedBytes + ", received " + message.rgba.byteLength);
  }

  var rgba = new Uint8ClampedArray(message.rgba);
  try {
    postEvent("page-state", requestId, page, pageId, { state: "detecting" });
    postEvent("detection-progress", requestId, page, pageId, { completed: 0, total: 1, progress: 0 });
    var detections = await detectPage(rgba, width, height);
    detections = assignReadingOrder(mergeSameLineDetections(detections, config.lineMergeGapRatio));
    postEvent("detection-progress", requestId, page, pageId, {
      completed: 1,
      total: 1,
      progress: 1,
      detections: detections.length
    });

    await recognizeDetections(rgba, width, height, detections, requestId, page, pageId);
  } catch (error) {
    postEvent("page-state", requestId, page, pageId, { state: "error" });
    throw withStage(error, "processing page " + String(page));
  }
}

async function recognizePage(message, requestId, page, pageId) {
  if (!initialized || !recognizerSession || !vocabulary) {
    throw new Error("OCR worker is not initialized; send {type:'init'} first");
  }
  if (page == null) throw new Error("recognize-page requires a page ID in `page`");
  if (message.config != null) config = validatedConfig(Object.assign(copyConfig(config), message.config));
  var width = positiveInteger(message.width, "width");
  var height = positiveInteger(message.height, "height");
  if (!(message.rgba instanceof ArrayBuffer)) throw new Error("recognize-page `rgba` must be an ArrayBuffer");
  if (message.rgba.byteLength !== width * height * 4) throw new Error("recognize-page RGBA byte length mismatch");
  if (!Array.isArray(message.detections)) throw new Error("recognize-page requires `detections`");
  try {
    await recognizeDetections(new Uint8ClampedArray(message.rgba), width, height, message.detections, requestId, page, pageId);
  } catch (error) {
    postEvent("page-state", requestId, page, pageId, { state: "error" });
    throw withStage(error, "recognizing page " + String(page));
  }
}

async function recognizeDetections(rgba, width, height, detections, requestId, page, pageId) {
  postEvent("page-state", requestId, page, pageId, {
    state: "recognizing",
    detections: detections.length
  });
  postEvent("recognition-progress", requestId, page, pageId, {
    completed: 0,
    total: detections.length,
    progress: detections.length ? 0 : 1
  });

  /** @type {RecognizedLine[]} */
  var lines = [];
  var totalInferenceMs = 0;
  for (var i = 0; i < detections.length; i++) {
    var recognition = await recognizeDetection(rgba, width, height, detections[i]);
    lines.push(recognition.line);
    totalInferenceMs += recognition.inferenceMs;
    postEvent("recognition-progress", requestId, page, pageId, {
      completed: i + 1,
      total: detections.length,
      progress: (i + 1) / detections.length,
      detectionId: detections[i].id,
      totalInferenceMs: totalInferenceMs,
      averageInferenceMs: totalInferenceMs / (i + 1)
    });
  }

  postEvent("page-state", requestId, page, pageId, { state: "ready" });
  postEvent("page-ready", requestId, page, pageId, {
    width: width,
    height: height,
    detections: detections,
    lines: lines
  });
}

/**
 * Resize and normalize a page, run the detector, and apply DB-style filtering.
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Detection[]>}
 */
async function detectPage(rgba, width, height) {
  var resized = detectorDimensions(width, height, config.detectorMaxSide);
  var inputData = resizeRgbChwNormalized(rgba, width, height, resized.width, resized.height);
  var inputTensor = new ort.Tensor("float32", inputData, [1, 3, resized.height, resized.width]);
  var results = null;

  try {
    try {
      results = await detectorSession.run((function () {
        var feeds = {};
        feeds[DETECTOR_INPUT] = inputTensor;
        return feeds;
      })());
    } catch (error) {
      throw withStage(error, "running text detector");
    }
    var output = results[DETECTOR_OUTPUT];
    if (!output) {
      throw new Error("Detector did not return output `" + DETECTOR_OUTPUT + "`");
    }
    assertTensorShape(output, [1, 1, resized.height, resized.width], "detector output `" + DETECTOR_OUTPUT + "`");

    try {
      return dbPostprocess(
        output.data,
        resized.width,
        resized.height,
        resized.scaleX,
        resized.scaleY,
        width,
        height
      );
    } catch (error) {
      throw withStage(error, "post-processing detector output");
    }
  } finally {
    safeDispose(inputTensor);
    disposeResults(results);
  }
}

/**
 * Compute detector dimensions by preserving the aspect ratio at the requested
 * maximum side, then rounding each dimension upward to the model stride.
 */
function detectorDimensions(width, height, maxSide) {
  var scale = Math.min(1, maxSide / Math.max(width, height));
  var targetWidth = Math.max(32, Math.ceil((width * scale) / 32) * 32);
  var targetHeight = Math.max(32, Math.ceil((height * scale) / 32) * 32);
  return {
    width: targetWidth,
    height: targetHeight,
    scaleX: targetWidth / width,
    scaleY: targetHeight / height
  };
}

/**
 * Bilinearly resize RGBA pixels and produce ImageNet-normalized planar RGB.
 */
function resizeRgbChwNormalized(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  var plane = targetWidth * targetHeight;
  var output = new Float32Array(plane * 3);
  for (var y = 0; y < targetHeight; y++) {
    var sy = ((y + 0.5) * sourceHeight / targetHeight) - 0.5;
    for (var x = 0; x < targetWidth; x++) {
      var sx = ((x + 0.5) * sourceWidth / targetWidth) - 0.5;
      var rgb = sampleRgbaOverWhite(source, sourceWidth, sourceHeight, sx, sy);
      var index = y * targetWidth + x;
      output[index] = (rgb[0] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      output[plane + index] = (rgb[1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      output[plane * 2 + index] = (rgb[2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }
  return output;
}

/**
 * DB-style threshold/component/PCA postprocessing. The binary map and queue are
 * fixed-size typed arrays, the candidate heap is capped, and returned boxes are
 * capped by maxDetections to bound memory even for adversarial probability maps.
 */
function dbPostprocess(probabilities, mapWidth, mapHeight, scaleX, scaleY, pageWidth, pageHeight) {
  var pixelCount = mapWidth * mapHeight;
  if (!probabilities || probabilities.length !== pixelCount) {
    throw new Error("Detector probability map has " + (probabilities ? probabilities.length : 0) +
      " values; expected " + pixelCount);
  }

  var mask = new Uint8Array(pixelCount);
  for (var i = 0; i < pixelCount; i++) {
    mask[i] = probabilities[i] >= config.detectionThreshold ? 1 : 0;
  }

  var queue = new Int32Array(pixelCount);
  var heap = [];
  var maxCandidates = config.maxDetections;

  for (var start = 0; start < pixelCount; start++) {
    if (mask[start] === 0) continue;

    var head = 0;
    var tail = 1;
    queue[0] = start;
    mask[start] = 0;
    var count = 0;
    var scoreSum = 0;
    var sumX = 0;
    var sumY = 0;
    var sumXX = 0;
    var sumXY = 0;
    var sumYY = 0;

    while (head < tail) {
      var index = queue[head++];
      var py = Math.floor(index / mapWidth);
      var px = index - py * mapWidth;
      count++;
      scoreSum += probabilities[index];
      sumX += px;
      sumY += py;
      sumXX += px * px;
      sumXY += px * py;
      sumYY += py * py;

      var minY = py > 0 ? py - 1 : py;
      var maxY = py + 1 < mapHeight ? py + 1 : py;
      var minX = px > 0 ? px - 1 : px;
      var maxX = px + 1 < mapWidth ? px + 1 : px;
      for (var ny = minY; ny <= maxY; ny++) {
        var row = ny * mapWidth;
        for (var nx = minX; nx <= maxX; nx++) {
          var neighbor = row + nx;
          if (mask[neighbor]) {
            mask[neighbor] = 0;
            queue[tail++] = neighbor;
          }
        }
      }
    }

    var score = scoreSum / count;
    if (score < config.boxScoreThreshold || count < 2) continue;

    var meanX = sumX / count;
    var meanY = sumY / count;
    var covarianceXX = Math.max(0, sumXX / count - meanX * meanX);
    var covarianceXY = sumXY / count - meanX * meanY;
    var covarianceYY = Math.max(0, sumYY / count - meanY * meanY);
    var angle = 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY);
    var snapRadians = config.boxAngleSnapDegrees * Math.PI / 180;
    if (Math.abs(angle) <= snapRadians) {
      angle = 0;
    } else if (Math.abs(Math.abs(angle) - Math.PI / 2) <= snapRadians) {
      angle = angle < 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    var ux = Math.cos(angle);
    var uy = Math.sin(angle);
    if (ux < 0) {
      ux = -ux;
      uy = -uy;
    }
    var vx = -uy;
    var vy = ux;
    var minU = Infinity;
    var maxU = -Infinity;
    var minV = Infinity;
    var maxV = -Infinity;

    for (var q = 0; q < tail; q++) {
      var componentIndex = queue[q];
      var componentY = Math.floor(componentIndex / mapWidth);
      var componentX = componentIndex - componentY * mapWidth;
      var dx = componentX - meanX;
      var dy = componentY - meanY;
      var projectedU = dx * ux + dy * uy;
      var projectedV = dx * vx + dy * vy;
      if (projectedU < minU) minU = projectedU;
      if (projectedU > maxU) maxU = projectedU;
      if (projectedV < minV) minV = projectedV;
      if (projectedV > maxV) maxV = projectedV;
    }

    // PCA orientation is unstable for compact glyphs and page numbers. A few
    // asymmetric pixels can turn their boxes into diamonds even though the text
    // belongs to a horizontal row. Preserve arbitrary rotation only when the
    // component is clearly elongated; compact components use axis-aligned bounds.
    var projectedWidth = maxU - minU;
    var projectedHeight = maxV - minV;
    var projectedAspect = Math.max(projectedWidth, projectedHeight) /
      Math.max(1e-6, Math.min(projectedWidth, projectedHeight));
    if (projectedAspect < 3 && angle !== 0 && Math.abs(angle) !== Math.PI / 2) {
      angle = 0;
      ux = 1;
      uy = 0;
      vx = 0;
      vy = 1;
      minU = Infinity;
      maxU = -Infinity;
      minV = Infinity;
      maxV = -Infinity;
      for (var axisIndex = 0; axisIndex < tail; axisIndex++) {
        var axisComponentIndex = queue[axisIndex];
        var axisY = Math.floor(axisComponentIndex / mapWidth) - meanY;
        var axisX = axisComponentIndex % mapWidth - meanX;
        if (axisX < minU) minU = axisX;
        if (axisX > maxU) maxU = axisX;
        if (axisY < minV) minV = axisY;
        if (axisY > maxV) maxV = axisY;
      }
    }

    // Pixel centers represent unit squares; include their half-pixel boundary.
    minU -= 0.5;
    maxU += 0.5;
    minV -= 0.5;
    maxV += 0.5;
    var sideU = maxU - minU;
    var sideV = maxV - minV;
    var minorSide = Math.min(sideU, sideV);
    var majorSide = Math.max(sideU, sideV);
    if (minorSide < config.minSide) continue;

    // Dotted form leaders produce sparse connected components that are much
    // longer than they are thick. Reject those before unclipping turns them
    // into prominent OCR boxes. Normal text retains enough stroke height to
    // exceed this narrow-component threshold.
    if (minorSide <= config.leaderDotMaxThickness &&
        majorSide / Math.max(minorSide, 1e-6) >= config.leaderDotMinAspectRatio &&
        score <= config.leaderDotMaxScore) {
      continue;
    }

    // DB unclip distance is polygon area * ratio / perimeter.
    var area = sideU * sideV;
    var perimeter = 2 * (sideU + sideV);
    var expand = perimeter > 0 ? area * config.unclipRatio / perimeter : 0;
    minU -= expand;
    maxU += expand;
    minV -= expand;
    maxV += expand;

    var quad = orientedQuad(meanX, meanY, ux, uy, vx, vy, minU, maxU, minV, maxV);
    quad = mapQuadToPage(quad, scaleX, scaleY, pageWidth, pageHeight);
    var candidate = {
      id: -1,
      quad: quad,
      score: score,
      order: { region: 0, line: -1, position: -1 },
      _rank: score * Math.sqrt(count)
    };
    pushBoundedCandidate(heap, candidate, maxCandidates);
  }

  var detections = heap.slice();
  for (var d = 0; d < detections.length; d++) delete detections[d]._rank;
  return assignReadingOrder(detections);
}

function orientedQuad(cx, cy, ux, uy, vx, vy, minU, maxU, minV, maxV) {
  function point(u, v) {
    return { x: cx + u * ux + v * vx, y: cy + u * uy + v * vy };
  }
  return {
    p0: point(minU, minV),
    p1: point(maxU, minV),
    p2: point(maxU, maxV),
    p3: point(minU, maxV)
  };
}

function mapQuadToPage(quad, scaleX, scaleY, width, height) {
  function map(point) {
    return {
      x: clamp(point.x / scaleX, 0, width - 1),
      y: clamp(point.y / scaleY, 0, height - 1)
    };
  }
  return { p0: map(quad.p0), p1: map(quad.p1), p2: map(quad.p2), p3: map(quad.p3) };
}

/** Maintain a min-heap ranked by component score and area. */
function pushBoundedCandidate(heap, candidate, limit) {
  if (heap.length < limit) {
    heap.push(candidate);
    heapBubbleUp(heap, heap.length - 1);
  } else if (candidate._rank > heap[0]._rank) {
    heap[0] = candidate;
    heapBubbleDown(heap, 0);
  }
}

function heapBubbleUp(heap, index) {
  while (index > 0) {
    var parent = Math.floor((index - 1) / 2);
    if (heap[parent]._rank <= heap[index]._rank) break;
    var value = heap[parent];
    heap[parent] = heap[index];
    heap[index] = value;
    index = parent;
  }
}

function heapBubbleDown(heap, index) {
  for (;;) {
    var left = index * 2 + 1;
    var right = left + 1;
    var smallest = index;
    if (left < heap.length && heap[left]._rank < heap[smallest]._rank) smallest = left;
    if (right < heap.length && heap[right]._rank < heap[smallest]._rank) smallest = right;
    if (smallest === index) return;
    var value = heap[index];
    heap[index] = heap[smallest];
    heap[smallest] = value;
    index = smallest;
  }
}

/**
 * Group boxes by overlapping centerlines/baselines, then order each line by x.
 * This keeps detached list markers with nearby body text instead of applying a
 * strict `(y, x)` ordering.
 * @param {Detection[]} detections
 * @returns {Detection[]}
 */
function detectionBounds(quad) {
  var xs = [quad.p0.x, quad.p1.x, quad.p2.x, quad.p3.x];
  var ys = [quad.p0.y, quad.p1.y, quad.p2.y, quad.p3.y];
  return {
    left: Math.min.apply(null, xs),
    right: Math.max.apply(null, xs),
    top: Math.min.apply(null, ys),
    bottom: Math.max.apply(null, ys)
  };
}

function quadFromBounds(bounds) {
  return {
    p0: { x: bounds.left, y: bounds.top },
    p1: { x: bounds.right, y: bounds.top },
    p2: { x: bounds.right, y: bounds.bottom },
    p3: { x: bounds.left, y: bounds.bottom }
  };
}

/**
 * Merge detections that belong to the same visual line: strong vertical overlap
 * and a small horizontal gap. A title whose first glyph is spaced away from the
 * rest is otherwise split into two boxes, which produces two text runs and makes
 * the word unsearchable.
 */
function mergeSameLineDetections(detections, gapRatio) {
  var ratio = Number.isFinite(gapRatio) ? gapRatio : 1.0;
  if (ratio <= 0) return detections;
  var merged = detections.slice();
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < merged.length && !changed; i++) {
      for (var j = i + 1; j < merged.length; j++) {
        var a = merged[i];
        var b = merged[j];
        var ba = detectionBounds(a.quad);
        var bb = detectionBounds(b.quad);
        var ha = ba.bottom - ba.top;
        var hb = bb.bottom - bb.top;
        if (ha <= 0 || hb <= 0) continue;
        var minHeight = Math.min(ha, hb);
        var overlap = Math.min(ba.bottom, bb.bottom) - Math.max(ba.top, bb.top);
        if (overlap < minHeight * 0.6) continue;
        if (Math.max(ha, hb) / minHeight > 1.6) continue;
        var gap = ba.left < bb.left ? (bb.left - ba.right) : (ba.left - bb.right);
        if (gap > minHeight * ratio) continue;
        merged[i] = {
          id: Math.min(a.id, b.id),
          quad: quadFromBounds({
            left: Math.min(ba.left, bb.left),
            right: Math.max(ba.right, bb.right),
            top: Math.min(ba.top, bb.top),
            bottom: Math.max(ba.bottom, bb.bottom)
          }),
          score: Math.max(a.score, b.score),
          order: a.order
        };
        merged.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return merged;
}

function assignReadingOrder(detections) {
  var items = detections.map(function (detection) {
    var ys = [detection.quad.p0.y, detection.quad.p1.y, detection.quad.p2.y, detection.quad.p3.y];
    var xs = [detection.quad.p0.x, detection.quad.p1.x, detection.quad.p2.x, detection.quad.p3.x];
    var top = Math.min.apply(null, ys);
    var bottom = Math.max.apply(null, ys);
    return {
      detection: detection,
      left: Math.min.apply(null, xs),
      centerY: (top + bottom) / 2,
      top: top,
      bottom: bottom,
      height: Math.max(1, bottom - top),
      baseline: bottom
    };
  });
  items.sort(function (a, b) { return a.centerY - b.centerY || a.left - b.left; });

  var groups = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var best = null;
    var bestDistance = Infinity;
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var overlap = Math.max(0, Math.min(item.bottom, group.bottom) - Math.max(item.top, group.top));
      var overlapRatio = overlap / Math.min(item.height, group.height);
      var centerDistance = Math.abs(item.centerY - group.centerY);
      var baselineDistance = Math.abs(item.baseline - group.baseline);
      var tolerance = Math.max(item.height, group.height);
      var compatible = overlapRatio >= 0.35 || centerDistance <= tolerance * 0.55 ||
        baselineDistance <= tolerance * 0.45;
      var lineDistance = centerDistance + baselineDistance * 0.5;
      if (compatible && lineDistance < bestDistance) {
        best = group;
        bestDistance = lineDistance;
      }
    }
    if (!best) {
      best = {
        items: [],
        centerY: item.centerY,
        baseline: item.baseline,
        top: item.top,
        bottom: item.bottom,
        height: item.height
      };
      groups.push(best);
    }
    best.items.push(item);
    var n = best.items.length;
    best.centerY += (item.centerY - best.centerY) / n;
    best.baseline += (item.baseline - best.baseline) / n;
    best.top = Math.min(best.top, item.top);
    best.bottom = Math.max(best.bottom, item.bottom);
    best.height = Math.max(1, best.bottom - best.top);
  }

  groups.sort(function (a, b) { return a.centerY - b.centerY; });
  var ordered = [];
  for (var lineIndex = 0; lineIndex < groups.length; lineIndex++) {
    groups[lineIndex].items.sort(function (a, b) { return a.left - b.left || a.centerY - b.centerY; });
    for (var position = 0; position < groups[lineIndex].items.length; position++) {
      var detection = groups[lineIndex].items[position].detection;
      detection.id = ordered.length;
      detection.order = { region: 0, line: lineIndex, position: position };
      ordered.push(detection);
    }
  }
  return ordered;
}


/**
 * Sample one quadrilateral directly from original RGBA into a dynamic-width,
 * grayscale [1,1,48,W] tensor and run recognizer inference.
 * @returns {Promise<{line: RecognizedLine, inferenceMs: number}>}
 */
async function recognizeDetection(rgba, pageWidth, pageHeight, detection) {
  var cropQuad = paddedRecognizerQuad(straightenNearAxisQuad(detection.quad));
  var crop = sampleRecognizerCrop(rgba, pageWidth, pageHeight, cropQuad);
  var imageTensor = new ort.Tensor("float32", crop.data, [1, 1, RECOGNIZER_HEIGHT, crop.width]);
  var widthTensor = new ort.Tensor("int64", new BigInt64Array([BigInt(crop.width)]), [1]);
  var results = null;
  var inferenceMs = 0;

  try {
    var feeds = {};
    feeds[RECOGNIZER_IMAGE_INPUT] = imageTensor;
    feeds[RECOGNIZER_WIDTH_INPUT] = widthTensor;
    try {
      var inferenceStartedAt = performance.now();
      results = await recognizerSession.run(feeds);
      inferenceMs = performance.now() - inferenceStartedAt;
    } catch (error) {
      throw withStage(
        error,
        "recognizing text line " + String(detection.id) + " at 48x" + String(crop.width)
      );
    }
    var logits = results[RECOGNIZER_LOGITS_OUTPUT];
    var lengths = results[RECOGNIZER_LENGTHS_OUTPUT];
    if (!logits || !lengths) {
      throw new Error("Recognizer must return `logits` and `lengths`");
    }
    assertTensorShape(logits, [1, Math.floor(crop.width / 4), RECOGNIZER_CLASSES], "recognizer output `logits`");
    assertTensorShape(lengths, [1], "recognizer output `lengths`");

    var validLength = Number(lengths.data[0]);
    if (!Number.isInteger(validLength) || validLength < 0 || validLength > logits.dims[1]) {
      throw new Error("Recognizer returned invalid CTC length " + String(lengths.data[0]));
    }
    var decoded = greedyCtcDecode(logits.data, validLength, RECOGNIZER_CLASSES, vocabulary);
    return {
      line: {
        detectionId: detection.id,
        quad: detection.quad,
        units: decoded.units,
        rawText: decoded.rawText,
        confidence: decoded.confidence,
        order: detection.order,
        alignmentQuad: cropQuad,
        ctcLength: validLength,
        ctcContentLength: crop.contentWidth / 4
      },
      inferenceMs: inferenceMs
    };
  } finally {
    safeDispose(imageTensor);
    safeDispose(widthTensor);
    disposeResults(results);
  }
}

/**
 * Inverse bilinear quadrilateral sampling. Output pixels map into the source as
 * P(u,v)=(1-u)(1-v)p0+u(1-v)p1+uvp2+(1-u)vp3. Source pixels are bilinearly
 * sampled, alpha-composited over white, converted with standard luminance, and
 * divided by 255 exactly. Up to three alignment columns are padded with 1.
 */
function straightenNearAxisQuad(quad) {
  var horizontalX = ((quad.p1.x - quad.p0.x) + (quad.p2.x - quad.p3.x)) / 2;
  var horizontalY = ((quad.p1.y - quad.p0.y) + (quad.p2.y - quad.p3.y)) / 2;
  var angle = Math.abs(Math.atan2(horizontalY, horizontalX)) * 180 / Math.PI;
  var threshold = config.boxAngleSnapDegrees;
  var nearHorizontal = Math.min(angle, Math.abs(180 - angle)) <= threshold;
  var nearVertical = Math.abs(angle - 90) <= threshold;
  if (!nearHorizontal && !nearVertical) return quad;

  var xs = [quad.p0.x, quad.p1.x, quad.p2.x, quad.p3.x];
  var ys = [quad.p0.y, quad.p1.y, quad.p2.y, quad.p3.y];
  var left = Math.min.apply(null, xs);
  var right = Math.max.apply(null, xs);
  var top = Math.min.apply(null, ys);
  var bottom = Math.max.apply(null, ys);
  if (nearVertical) {
    return {
      p0: { x: right, y: top }, p1: { x: right, y: bottom },
      p2: { x: left, y: bottom }, p3: { x: left, y: top }
    };
  }
  return {
    p0: { x: left, y: top }, p1: { x: right, y: top },
    p2: { x: right, y: bottom }, p3: { x: left, y: bottom }
  };
}

function paddedRecognizerQuad(quad) {
  var horizontalX = ((quad.p1.x - quad.p0.x) + (quad.p2.x - quad.p3.x)) / 2;
  var horizontalY = ((quad.p1.y - quad.p0.y) + (quad.p2.y - quad.p3.y)) / 2;
  var horizontalLength = Math.hypot(horizontalX, horizontalY) || 1;
  var rightX = horizontalX / horizontalLength;
  var rightY = horizontalY / horizontalLength;

  var verticalX = ((quad.p3.x - quad.p0.x) + (quad.p2.x - quad.p1.x)) / 2;
  var verticalY = ((quad.p3.y - quad.p0.y) + (quad.p2.y - quad.p1.y)) / 2;
  var verticalLength = Math.hypot(verticalX, verticalY) || 1;
  var downX = verticalX / verticalLength;
  var downY = verticalY / verticalLength;
  var top = verticalLength * config.cropPaddingTopRatio;
  var bottom = verticalLength * config.cropPaddingBottomRatio;
  var left = config.cropPaddingLeftPixels;
  var right = config.cropPaddingRightPixels;

  function offset(point, horizontal, vertical) {
    return {
      x: point.x + rightX * horizontal + downX * vertical,
      y: point.y + rightY * horizontal + downY * vertical
    };
  }

  return {
    p0: offset(quad.p0, -left, -top),
    p1: offset(quad.p1, right, -top),
    p2: offset(quad.p2, right, bottom),
    p3: offset(quad.p3, -left, bottom)
  };
}

function sampleRecognizerCrop(rgba, pageWidth, pageHeight, quad) {
  var topWidth = distance(quad.p0, quad.p1);
  var bottomWidth = distance(quad.p3, quad.p2);
  var leftHeight = distance(quad.p0, quad.p3);
  var rightHeight = distance(quad.p1, quad.p2);
  var sourceWidth = Math.max(1, (topWidth + bottomWidth) / 2);
  var sourceHeight = Math.max(1, (leftHeight + rightHeight) / 2);
  var maxWidth = Math.max(4, Math.floor(config.recognizerMaxWidth / 4) * 4);
  var contentWidth = clamp(Math.round(RECOGNIZER_HEIGHT * sourceWidth / sourceHeight), 4, maxWidth);
  var tensorWidth = clamp(Math.ceil(contentWidth / 4) * 4, 4, maxWidth);
  var output = new Float32Array(RECOGNIZER_HEIGHT * tensorWidth);
  output.fill(1);

  for (var y = 0; y < RECOGNIZER_HEIGHT; y++) {
    var v = (y + 0.5) / RECOGNIZER_HEIGHT;
    for (var x = 0; x < contentWidth; x++) {
      var u = (x + 0.5) / contentWidth;
      var oneMinusU = 1 - u;
      var oneMinusV = 1 - v;
      var sx = oneMinusU * oneMinusV * quad.p0.x + u * oneMinusV * quad.p1.x +
        u * v * quad.p2.x + oneMinusU * v * quad.p3.x;
      var sy = oneMinusU * oneMinusV * quad.p0.y + u * oneMinusV * quad.p1.y +
        u * v * quad.p2.y + oneMinusU * v * quad.p3.y;
      var rgb = sampleRgbaOverWhite(rgba, pageWidth, pageHeight, sx, sy);
      output[y * tensorWidth + x] = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    }
  }
  return { data: output, width: tensorWidth, contentWidth: contentWidth };
}

/**
 * Greedy CTC with blank index 0. Equal labels collapse only while contiguous;
 * a blank closes the unit, allowing the same symbol to be emitted again.
 */
function greedyCtcDecode(logits, timesteps, classes, vocab) {
  var bestLabels = new Int32Array(timesteps);
  var margins = new Float32Array(timesteps);
  for (var t = 0; t < timesteps; t++) {
    var offset = t * classes;
    var bestIndex = 0;
    var bestLogit = -Infinity;
    var secondLogit = -Infinity;
    for (var c = 0; c < classes; c++) {
      var value = logits[offset + c];
      if (value > bestLogit) {
        secondLogit = bestLogit;
        bestLogit = value;
        bestIndex = c;
      } else if (value > secondLogit) {
        secondLogit = value;
      }
    }
    bestLabels[t] = bestIndex;
    margins[t] = bestLogit - secondLogit;
  }

  var units = [];
  var runLabel = 0;
  var runStart = 0;
  var representative = 0;
  var representativeMargin = -Infinity;

  function closeRun(end) {
    if (runLabel === 0) return;
    var candidates = exactTopCandidates(logits, representative, classes, vocab, 3);
    units.push({
      rawText: vocab[runLabel],
      timestepStart: runStart,
      timestepEnd: end,
      candidates: candidates,
      confidence: candidates.length && candidates[0].text === vocab[runLabel]
        ? candidates[0].score
        : exactClassProbability(logits, representative, classes, runLabel)
    });
  }

  for (var i = 0; i < timesteps; i++) {
    var label = bestLabels[i];
    if (label === 0) {
      closeRun(i);
      runLabel = 0;
      representativeMargin = -Infinity;
    } else if (label !== runLabel) {
      closeRun(i);
      runLabel = label;
      runStart = i;
      representative = i;
      representativeMargin = margins[i];
    } else if (margins[i] > representativeMargin) {
      representative = i;
      representativeMargin = margins[i];
    }
  }
  closeRun(timesteps);

  var rawText = "";
  var confidenceSum = 0;
  for (var u = 0; u < units.length; u++) {
    rawText += units[u].rawText;
    confidenceSum += units[u].confidence;
  }
  return {
    units: units,
    rawText: rawText,
    confidence: units.length ? confidenceSum / units.length : 0
  };
}

/** Exact full-vocabulary softmax, retained only for top-k at one timestep/unit. */
function exactTopCandidates(logits, timestep, classes, vocab, count) {
  var offset = timestep * classes;
  var topIndices = new Int32Array(count);
  var topLogits = new Float64Array(count);
  topIndices.fill(-1);
  topLogits.fill(-Infinity);
  var maximum = -Infinity;

  for (var c = 0; c < classes; c++) {
    var value = logits[offset + c];
    if (value > maximum) maximum = value;
    for (var k = 0; k < count; k++) {
      if (value > topLogits[k]) {
        for (var shift = count - 1; shift > k; shift--) {
          topLogits[shift] = topLogits[shift - 1];
          topIndices[shift] = topIndices[shift - 1];
        }
        topLogits[k] = value;
        topIndices[k] = c;
        break;
      }
    }
  }

  var denominator = 0;
  for (var j = 0; j < classes; j++) denominator += Math.exp(logits[offset + j] - maximum);
  var candidates = [];
  for (var n = 0; n < count; n++) {
    if (topIndices[n] >= 0) {
      candidates.push({
        text: vocab[topIndices[n]],
        score: Math.exp(topLogits[n] - maximum) / denominator
      });
    }
  }
  return candidates;
}

function exactClassProbability(logits, timestep, classes, classIndex) {
  var offset = timestep * classes;
  var maximum = -Infinity;
  for (var c = 0; c < classes; c++) maximum = Math.max(maximum, logits[offset + c]);
  var denominator = 0;
  for (var i = 0; i < classes; i++) denominator += Math.exp(logits[offset + i] - maximum);
  return Math.exp(logits[offset + classIndex] - maximum) / denominator;
}

/** Bilinear RGBA sampling with transparent pixels composited over white. */
function sampleRgbaOverWhite(data, width, height, x, y) {
  x = clamp(x, 0, width - 1);
  y = clamp(y, 0, height - 1);
  var x0 = Math.floor(x);
  var y0 = Math.floor(y);
  var x1 = Math.min(width - 1, x0 + 1);
  var y1 = Math.min(height - 1, y0 + 1);
  var tx = x - x0;
  var ty = y - y0;
  var w00 = (1 - tx) * (1 - ty);
  var w10 = tx * (1 - ty);
  var w01 = (1 - tx) * ty;
  var w11 = tx * ty;
  var weights = [w00, w10, w01, w11];
  var indices = [(y0 * width + x0) * 4, (y0 * width + x1) * 4,
    (y1 * width + x0) * 4, (y1 * width + x1) * 4];
  var rgb = [0, 0, 0];

  for (var sample = 0; sample < 4; sample++) {
    var index = indices[sample];
    var alpha = data[index + 3] / 255;
    var weight = weights[sample];
    rgb[0] += (data[index] * alpha + 255 * (1 - alpha)) * weight;
    rgb[1] += (data[index + 1] * alpha + 255 * (1 - alpha)) * weight;
    rgb[2] += (data[index + 2] * alpha + 255 * (1 - alpha)) * weight;
  }
  return rgb;
}

function validatedConfig(overrides) {
  if (overrides != null && (typeof overrides !== "object" || Array.isArray(overrides))) {
    throw new Error("init `config` must be an object");
  }
  var result = copyConfig(DEFAULT_CONFIG);
  var source = copyObject(overrides || {});
  applyConfigAlias(source, "maxSide", "detectorMaxSide");
  applyConfigAlias(source, "threshold", "detectionThreshold");
  applyConfigAlias(source, "boxScore", "boxScoreThreshold");
  applyConfigAlias(source, "unclip", "unclipRatio");
  applyConfigAlias(source, "maxWidth", "recognizerMaxWidth");
  setConfigNumber(result, source, "detectorMaxSide", 32, 8192, true);
  setConfigNumber(result, source, "detectionThreshold", 0, 1, false);
  setConfigNumber(result, source, "boxScoreThreshold", 0, 1, false);
  setConfigNumber(result, source, "minSide", 0, 1024, false);
  setConfigNumber(result, source, "unclipRatio", 0, 20, false);
  setConfigNumber(result, source, "boxAngleSnapDegrees", 0, 45, false);
  setConfigNumber(result, source, "leaderDotMaxThickness", 0, 64, false);
  setConfigNumber(result, source, "leaderDotMinAspectRatio", 1, 100, false);
  setConfigNumber(result, source, "leaderDotMaxScore", 0, 1, false);
  setConfigNumber(result, source, "maxDetections", 1, 2000, true);
  setConfigNumber(result, source, "recognizerMaxWidth", 4, 8192, true);
  setConfigNumber(result, source, "cropPaddingTopRatio", 0, 2, false);
  setConfigNumber(result, source, "cropPaddingBottomRatio", 0, 2, false);
  setConfigNumber(result, source, "cropPaddingLeftPixels", 0, 1024, false);
  setConfigNumber(result, source, "cropPaddingRightPixels", 0, 1024, false);
  setConfigNumber(result, source, "lineMergeGapRatio", 0, 4, false);
  result.recognizerMaxWidth = Math.max(4, Math.floor(result.recognizerMaxWidth / 4) * 4);
  return result;
}

function copyObject(source) {
  var result = {};
  var keys = Object.keys(source);
  for (var i = 0; i < keys.length; i++) result[keys[i]] = source[keys[i]];
  return result;
}

function applyConfigAlias(source, alias, canonical) {
  if (source[canonical] == null && source[alias] != null) source[canonical] = source[alias];
}

function setConfigNumber(target, source, name, minimum, maximum, integer) {
  if (source[name] == null) return;
  var value = source[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum ||
      (integer && !Number.isInteger(value))) {
    throw new Error("config." + name + " must be " + (integer ? "an integer" : "a number") +
      " between " + minimum + " and " + maximum);
  }
  target[name] = value;
}

function setConfigChoice(target, source, name, choices) {
  if (source[name] == null) return;
  if (typeof source[name] !== "string" || choices.indexOf(source[name]) === -1) {
    throw new Error("config." + name + " must be one of: " + choices.join(", "));
  }
  target[name] = source[name];
}

function copyConfig(source) {
  return {
    detectorMaxSide: source.detectorMaxSide,
    detectionThreshold: source.detectionThreshold,
    boxScoreThreshold: source.boxScoreThreshold,
    minSide: source.minSide,
    unclipRatio: source.unclipRatio,
    maxDetections: source.maxDetections,
    recognizerMaxWidth: source.recognizerMaxWidth,
    cropPaddingTopRatio: source.cropPaddingTopRatio,
    cropPaddingBottomRatio: source.cropPaddingBottomRatio,
    cropPaddingLeftPixels: source.cropPaddingLeftPixels,
    cropPaddingRightPixels: source.cropPaddingRightPixels,
  };
}

function assertNames(actual, required, description) {
  for (var i = 0; i < required.length; i++) {
    if (!actual || actual.indexOf(required[i]) === -1) {
      throw new Error("Missing exact " + description + " name `" + required[i] + "`; found: " +
        (actual ? actual.join(", ") : "none"));
    }
  }
}

function assertTensorShape(tensor, expected, description) {
  if (!tensor.dims || tensor.dims.length !== expected.length) {
    throw new Error(description + " rank mismatch; expected [" + expected.join(",") + "]");
  }
  for (var i = 0; i < expected.length; i++) {
    if (tensor.dims[i] !== expected[i]) {
      throw new Error(description + " shape mismatch; expected [" + expected.join(",") +
        "], received [" + tensor.dims.join(",") + "]");
    }
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("process-page `" + name + "` must be a positive safe integer");
  }
  return value;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function safeDispose(value) {
  if (value && typeof value.dispose === "function") {
    try {
      value.dispose();
    } catch (_) {
      // Disposal is best-effort and must not hide an inference error.
    }
  }
}

function disposeResults(results) {
  if (!results) return;
  var names = Object.keys(results);
  for (var i = 0; i < names.length; i++) safeDispose(results[names[i]]);
}

function withStage(error, stage) {
  var wrapped;
  if (error instanceof Error) {
    wrapped = error;
  } else if (typeof error === "number") {
    wrapped = new Error("ONNX Runtime Web failed with numeric code " + String(error));
  } else {
    wrapped = new Error(String(error));
  }
  if (!wrapped.ocrStage) wrapped.ocrStage = stage;
  return wrapped;
}

function postEvent(type, requestId, page, pageId, details) {
  var event = { type: type, requestId: requestId, page: page, pageId: pageId };
  if (details) {
    var keys = Object.keys(details);
    for (var i = 0; i < keys.length; i++) event[keys[i]] = details[keys[i]];
  }
  self.postMessage(event);
}

function postError(error, requestId, page, pageId, fallbackStage) {
  var normalized = error instanceof Error ? error : new Error(String(error));
  postEvent("error", requestId, page, pageId, {
    stage: normalized.ocrStage || fallbackStage,
    message: normalized.message || String(normalized),
    stack: normalized.stack || ""
  });
}
