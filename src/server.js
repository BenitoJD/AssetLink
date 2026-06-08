const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const busboy = require("busboy");
const express = require("express");
const mime = require("mime-types");

const config = require("./config");
const {
  ensureBucket,
  getObjectBuffer,
  getObjectRangeBuffer,
  getObjectRangeStream,
  getObjectStream,
  listObjects,
  statObject,
  uploadObject,
  uploadObjectStream
} = require("./minio");

const app = express();

const TEXT_CHUNK_BYTES = 128 * 1024;
const MAX_TEXT_CHUNK_BYTES = 1024 * 1024;
const TEXT_UPLOAD_FIELDS = new Set(["texts", "files"]);
const TEXT_EXTENSIONS = new Set([
  ".conf",
  ".csv",
  ".env",
  ".htm",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".markdown",
  ".properties",
  ".rtf",
  ".sql",
  ".ts",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/rtf",
  "application/toml",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-yaml",
  "application/xml",
  "application/yaml"
]);

function requireToken(req, res, next) {
  const header = req.header("authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();

  if (token !== config.apiToken) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  return next();
}

function buildAssetUrl(objectKey) {
  return `${config.publicBaseUrl}/assets/${encodeURIComponent(objectKey)}`;
}

function parseByteRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());

  if (!match) {
    return null;
  }

  const [, startPart, endPart] = match;
  let start = startPart === "" ? Math.max(size - Number(endPart), 0) : Number(startPart);
  let end = endPart === "" ? size - 1 : Number(endPart);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { invalid: true, size };
  }

  end = Math.min(end, size - 1);

  return {
    start,
    end,
    length: end - start + 1
  };
}

function buildBatchUrl(batchId) {
  return `${config.publicBaseUrl}/uploads/${encodeURIComponent(batchId)}`;
}

function safeObjectName(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

function isSupportedTextFile(originalName, mimeType) {
  const normalizedMimeType = String(mimeType || "").toLowerCase().split(";")[0].trim();
  const ext = path.extname(originalName || "").toLowerCase();

  return normalizedMimeType.startsWith("text/")
    || TEXT_MIME_TYPES.has(normalizedMimeType)
    || TEXT_EXTENSIONS.has(ext);
}

function resolveVideoMimeType(originalName, mimeType) {
  const normalizedMimeType = String(mimeType || "").toLowerCase().split(";")[0].trim();

  if (normalizedMimeType.startsWith("video/")) {
    return normalizedMimeType;
  }

  const detectedMimeType = mime.lookup(originalName);

  if (detectedMimeType && String(detectedMimeType).startsWith("video/")) {
    return detectedMimeType;
  }

  return null;
}

function normalizeManifestAssets(manifest) {
  if (Array.isArray(manifest.assets)) {
    return manifest.assets;
  }

  const images = Array.isArray(manifest.images)
    ? manifest.images.map((item) => ({
      type: "image",
      mimeType: item.mimeType || mime.lookup(item.objectKey) || "image/*",
      ...item
    }))
    : [];

  const texts = Array.isArray(manifest.texts)
    ? manifest.texts.map((item) => ({
      type: "text",
      mimeType: item.mimeType || mime.lookup(item.objectKey) || "text/plain",
      ...item
    }))
    : [];

  const videos = Array.isArray(manifest.videos)
    ? manifest.videos.map((item) => ({
      type: "video",
      mimeType: item.mimeType || mime.lookup(item.objectKey) || "video/*",
      ...item
    }))
    : [];

  return [...images, ...texts, ...videos];
}

function batchManifestKey(batchId) {
  return `uploads/${batchId}.json`;
}

async function saveBatchManifest(batchId, assets) {
  const normalizedAssets = assets.map((asset) => ({
    ...asset,
    url: asset.url || buildAssetUrl(asset.objectKey)
  }));
  const images = normalizedAssets.filter((asset) => asset.type === "image");
  const texts = normalizedAssets.filter((asset) => asset.type === "text");
  const videos = normalizedAssets.filter((asset) => asset.type === "video");
  const manifest = {
    batchId,
    createdAt: new Date().toISOString(),
    assets: normalizedAssets,
    texts,
    images,
    videos
  };

  await uploadObject({
    objectName: batchManifestKey(batchId),
    buffer: Buffer.from(JSON.stringify(manifest, null, 2)),
    contentType: "application/json"
  });

  return manifest;
}

async function getBatchManifest(batchId) {
  const buffer = await getObjectBuffer(batchManifestKey(batchId));
  return JSON.parse(buffer.toString("utf8"));
}

function createListeningServer() {
  const keyFile = config.https.keyFile;
  const certFile = config.https.certFile;

  if (!keyFile && !certFile) {
    return {
      protocol: "http",
      server: http.createServer(app)
    };
  }

  if (!keyFile || !certFile) {
    throw new Error("HTTPS_KEY_FILE and HTTPS_CERT_FILE must both be set to enable HTTPS");
  }

  const key = fs.readFileSync(keyFile);
  const cert = fs.readFileSync(certFile);

  return {
    protocol: "https",
    server: https.createServer({
      key,
      cert
    }, app)
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/\r?\n|\r/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeTextHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBytes(value) {
  const bytes = Number(value || 0);

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function clampChunkLimit(value) {
  const parsed = parseNonNegativeInteger(value, TEXT_CHUNK_BYTES);

  if (parsed <= 0) {
    return TEXT_CHUNK_BYTES;
  }

  return Math.min(parsed, MAX_TEXT_CHUNK_BYTES);
}

async function loadTextPreview(asset) {
  const url = buildAssetUrl(asset.objectKey);
  const baseAsset = {
    ...asset,
    url
  };

  try {
    const meta = await statObject(asset.objectKey);
    const size = Number(meta.size || 0);
    const length = Math.min(TEXT_CHUNK_BYTES, size);
    const buffer = length > 0
      ? await getObjectRangeBuffer(asset.objectKey, 0, length)
      : Buffer.alloc(0);
    const nextOffset = buffer.length;

    return {
      ...baseAsset,
      content: buffer.toString("utf8"),
      previewError: "",
      size,
      nextOffset,
      hasMore: nextOffset < size
    };
  } catch (error) {
    return {
      ...baseAsset,
      content: "",
      previewError: "Could not load this text preview.",
      nextOffset: 0,
      hasMore: false,
      size: 0
    };
  }
}

async function buildTextBatchHtml(manifest, textAssets) {
  const files = await Promise.all(textAssets.map(loadTextPreview));
  const totalTexts = files.length;
  const batchId = escapeHtml(manifest.batchId);
  const batchUrl = buildBatchUrl(manifest.batchId);
  const batchJsonUrl = `${batchUrl}/json`;
  const createdAt = manifest.createdAt ? escapeHtml(manifest.createdAt) : "Unknown";
  const batchIdShort = escapeHtml(String(manifest.batchId || "").slice(0, 8));

  const tabs = files
    .map((item, index) => {
      const isActive = index === 0;
      const safeName = escapeHtml(item.originalName || "Uploaded text");
      const size = item.size ? escapeHtml(formatBytes(item.size)) : "0 B";
      const loaded = escapeHtml(formatBytes(item.nextOffset || 0));
      const progressValue = item.size > 0
        ? Math.min(100, Math.round(((item.nextOffset || 0) / item.size) * 100))
        : 100;

      return `
        <button type="button" class="file-tab${isActive ? " is-active" : ""}" data-file-tab data-target-index="${index}" aria-selected="${isActive ? "true" : "false"}">
          <span class="file-index">${index + 1}</span>
          <span class="file-copy">
            <span class="file-name">${safeName}</span>
            <span class="file-meta">${loaded} loaded · ${size}</span>
          </span>
          <span class="file-progress" aria-hidden="true"><span style="width: ${progressValue}%"></span></span>
        </button>
      `;
    })
    .join("");

  const panels = files
    .map((item, index) => {
      const safeName = escapeHtml(item.originalName || "Uploaded text");
      const safeMimeType = escapeHtml(item.mimeType || "text/plain");
      const rawUrl = buildAssetUrl(item.objectKey);
      const safeChunkUrl = `/uploads/${encodeURIComponent(manifest.batchId)}/text/${index}`;
      const loadedLabel = `Loaded ${formatBytes(item.nextOffset || 0)} of ${formatBytes(item.size || 0)}`;
      const progressValue = item.size > 0
        ? Math.min(100, Math.round(((item.nextOffset || 0) / item.size) * 100))
        : 100;
      const preview = item.previewError
        ? `<div class="preview-message">${escapeHtml(item.previewError)}</div>`
        : `
          <textarea class="raw-buffer" data-text-content aria-hidden="true">${escapeTextHtml(item.content)}</textarea>
          <div class="chat-stream" data-chat-stream tabindex="0" aria-label="Readable text transcript"></div>
        `;
      const loadMoreButton = item.previewError ? "" : `
              <button
                type="button"
                class="button button-primary"
                data-load-more
                data-chunk-url="${safeChunkUrl}"
                data-next-offset="${item.nextOffset || 0}"
                data-size="${item.size || 0}"
                data-limit="${TEXT_CHUNK_BYTES}"
                ${item.hasMore ? "" : "disabled"}
              >${item.hasMore ? "Load more" : "Fully loaded"}</button>
      `;
      const copyButton = item.previewError ? "" : `<button type="button" class="button" data-copy-text>Copy loaded</button>`;

      return `
        <section class="text-panel" data-file-panel ${index === 0 ? "" : "hidden"}>
          <header class="reader-header">
            <div class="reader-title">
              <p class="reader-kicker">${safeMimeType} · <span data-active-mode-label>Transcript</span></p>
              <h2>${safeName}</h2>
              <p class="reader-subtitle" data-load-status>${escapeHtml(loadedLabel)}</p>
            </div>
            <div class="reader-actions">
              ${copyButton}
              ${loadMoreButton}
              <a href="${rawUrl}" target="_blank" rel="noreferrer" class="button">Raw</a>
              <a href="${batchJsonUrl}" target="_blank" rel="noreferrer" class="button">JSON</a>
            </div>
          </header>
          <div class="reader-toolbar" aria-label="Reader controls">
            <div class="mode-switch" role="group" aria-label="Reader mode">
              <button type="button" class="mode-button is-active" data-reader-mode="transcript">Transcript</button>
              <button type="button" class="mode-button" data-reader-mode="document">Document</button>
              <button type="button" class="mode-button" data-reader-mode="raw">Raw</button>
            </div>
            <label class="search-box">
              <span>Search loaded text</span>
              <input type="search" data-search-input autocomplete="off" placeholder="Find in loaded text" />
            </label>
            <span class="search-count" data-search-count>No search</span>
            <label class="auto-load">
              <input type="checkbox" data-auto-load />
              <span>Auto-load</span>
            </label>
          </div>
          <div class="progress-track" aria-hidden="true"><span data-progress-bar style="width: ${progressValue}%"></span></div>
          <div class="reader-canvas">
            ${preview}
          </div>
        </section>
      `;
    })
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>AssetLink Text Batch ${batchId}</title>
      <style>
        :root {
          color-scheme: light;
          --app-bg: #f3f4f6;
          --rail-bg: #101318;
          --rail-muted: #8f98a8;
          --surface: #ffffff;
          --surface-alt: #f8f9fb;
          --surface-strong: #eef1f5;
          --surface-muted: #edf0f4;
          --text: #15171c;
          --muted: #6c7482;
          --muted-strong: #3f4652;
          --accent: #0f6fff;
          --accent-strong: #0759d1;
          --accent-soft: #e8f1ff;
          --success: #1f8a5b;
          --prompt: #fff8e8;
          --response: #f4faf7;
          --system: #f6f0ff;
          --note: #ffffff;
          --border: #d9dee7;
          --border-strong: #b7c0cd;
          --shadow: 0 24px 70px rgba(18, 23, 33, 0.12);
          --radius: 8px;
          --font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          min-height: 100vh;
          min-height: 100dvh;
          background:
            linear-gradient(180deg, #ffffff 0, var(--app-bg) 280px),
            var(--app-bg);
          color: var(--text);
          font-family: var(--font);
          line-height: 1.5;
        }
        main {
          width: min(1680px, calc(100% - 24px));
          margin: 0 auto;
          padding: 14px 0 24px;
        }
        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 18px;
          padding: 8px 4px 14px;
        }
        .eyebrow {
          margin: 0 0 6px;
          color: var(--accent);
          font-size: 0.78rem;
          font-weight: 750;
          letter-spacing: 0.10em;
          text-transform: uppercase;
        }
        h1 {
          margin: 0;
          font-size: clamp(1.55rem, 2vw, 2.15rem);
          line-height: 1.08;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }
        .batch-meta {
          margin: 8px 0 0;
          color: var(--muted);
          overflow-wrap: anywhere;
        }
        .actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: flex-end;
        }
        .actions a,
        .button {
          appearance: none;
          min-height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--surface);
          color: var(--accent-strong);
          padding: 0 12px;
          text-decoration: none;
          font-size: 0.9rem;
          font-weight: 720;
          cursor: pointer;
          font: inherit;
          transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
        }
        .actions a:hover,
        .button:hover {
          background: var(--accent-soft);
          border-color: #b8cdfc;
        }
        .button-primary {
          background: var(--accent);
          border-color: var(--accent);
          color: #ffffff;
        }
        .button-primary:hover {
          background: var(--accent-strong);
          border-color: var(--accent-strong);
        }
        .button:disabled {
          background: var(--surface-muted);
          border-color: var(--border);
          color: var(--muted);
          cursor: default;
          box-shadow: none;
        }
        .reader-layout {
          margin-top: 4px;
          display: grid;
          grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
          min-height: calc(100dvh - 116px);
          border: 1px solid #d3d9e4;
          border-radius: 10px;
          background: var(--surface);
          box-shadow: var(--shadow);
          overflow: hidden;
        }
        .file-list {
          min-height: 100%;
          display: grid;
          align-content: start;
          gap: 6px;
          padding: 12px;
          background: var(--rail-bg);
          border-right: 1px solid rgba(255, 255, 255, 0.08);
        }
        .file-tab {
          appearance: none;
          width: 100%;
          position: relative;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 10px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: var(--radius);
          background: rgba(255, 255, 255, 0.035);
          color: #f6f7fb;
          padding: 12px 12px 14px;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.18s ease, background 0.18s ease, transform 0.18s ease;
        }
        .file-tab:hover,
        .file-tab.is-active {
          border-color: rgba(255, 255, 255, 0.24);
          background: rgba(255, 255, 255, 0.10);
          transform: translateY(-1px);
        }
        .file-index {
          color: var(--rail-muted);
          font-family: var(--font-mono);
          font-size: 0.76rem;
          line-height: 1.35;
        }
        .file-copy {
          min-width: 0;
        }
        .file-name,
        .file-meta {
          display: block;
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .file-name {
          font-weight: 750;
        }
        .file-meta {
          margin-top: 4px;
          color: var(--rail-muted);
          font-size: 0.84rem;
        }
        .file-progress {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 2px;
          background: rgba(255, 255, 255, 0.08);
        }
        .file-progress span {
          display: block;
          height: 100%;
          background: linear-gradient(90deg, var(--accent), #2dd4bf);
        }
        .reader {
          min-width: 0;
          background: var(--surface-alt);
          overflow: hidden;
        }
        .text-panel[hidden] {
          display: none;
        }
        .reader-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 20px 14px;
          border-bottom: 1px solid var(--border);
          background: rgba(255, 255, 255, 0.94);
        }
        .reader-title {
          min-width: 0;
        }
        .reader-actions {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
          max-width: min(100%, 650px);
        }
        .reader-kicker {
          margin: 0 0 5px;
          color: var(--muted);
          font-size: 0.78rem;
          font-weight: 750;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          overflow-wrap: anywhere;
        }
        .reader h2 {
          margin: 0;
          font-size: clamp(1.12rem, 1.7vw, 1.45rem);
          line-height: 1.18;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }
        .reader-toolbar {
          display: grid;
          grid-template-columns: auto minmax(180px, 1fr) auto auto;
          gap: 10px;
          align-items: center;
          padding: 10px 20px;
          border-bottom: 1px solid var(--border);
          background: rgba(248, 249, 251, 0.94);
        }
        .mode-switch {
          display: inline-flex;
          padding: 3px;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: #ffffff;
        }
        .mode-button {
          appearance: none;
          min-height: 30px;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: var(--muted-strong);
          padding: 0 10px;
          font: inherit;
          font-size: 0.84rem;
          font-weight: 720;
          cursor: pointer;
        }
        .mode-button.is-active {
          background: #111827;
          color: #ffffff;
        }
        .search-box {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 8px;
          align-items: center;
          min-width: 0;
          color: var(--muted);
          font-size: 0.82rem;
          font-weight: 700;
        }
        .search-box input {
          width: 100%;
          min-width: 0;
          min-height: 34px;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: #ffffff;
          color: var(--text);
          font: inherit;
          padding: 0 10px;
        }
        .search-count {
          color: var(--muted);
          font-size: 0.82rem;
          font-weight: 700;
          white-space: nowrap;
        }
        .auto-load {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: var(--muted-strong);
          font-size: 0.84rem;
          font-weight: 720;
          white-space: nowrap;
        }
        .progress-track {
          height: 4px;
          background: var(--surface-muted);
          overflow: hidden;
        }
        .progress-track span {
          display: block;
          height: 100%;
          width: 0;
          background: linear-gradient(90deg, var(--accent), #2dd4bf);
          transition: width 0.22s ease;
        }
        .raw-buffer {
          display: none;
        }
        .reader-body {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(220px, 280px);
          min-height: calc(100dvh - 250px);
        }
        .reader-canvas {
          min-width: 0;
        }
        .reader-inspector {
          border-left: 1px solid var(--border);
          background: #ffffff;
          padding: 16px;
        }
        .inspector-list {
          display: grid;
          gap: 13px;
          margin: 0;
        }
        .inspector-list div {
          display: grid;
          gap: 3px;
        }
        .inspector-list dt {
          color: var(--muted);
          font-size: 0.72rem;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .inspector-list dd {
          margin: 0;
          color: var(--text);
          font-size: 0.9rem;
          font-weight: 650;
          overflow-wrap: anywhere;
        }
        .chat-stream {
          height: calc(100dvh - 250px);
          min-height: 560px;
          overflow: auto;
          padding: clamp(18px, 3vw, 34px);
          background: linear-gradient(180deg, #fbfcfd 0, #f4f6f8 100%);
          scroll-behavior: smooth;
        }
        .message {
          position: relative;
          display: grid;
          gap: 8px;
          width: fit-content;
          max-inline-size: min(76ch, 100%);
          margin: 0 auto 12px;
          padding: 16px 18px;
          border: 1px solid rgba(17, 24, 39, 0.08);
          border-radius: 10px;
          background: var(--note);
          box-shadow: 0 8px 22px rgba(23, 25, 31, 0.045);
        }
        .message:last-child {
          margin-bottom: 0;
        }
        .message--prompt {
          margin-left: auto;
          margin-right: 0;
          background: #eef5ff;
          border-color: #9ec4ff;
          box-shadow:
            inset -4px 0 0 var(--accent),
            0 8px 22px rgba(15, 111, 255, 0.08);
        }
        .message--response {
          margin-left: 0;
          margin-right: auto;
          background: #f3fbf7;
          border-color: #addfc5;
          box-shadow:
            inset 4px 0 0 var(--success),
            0 8px 22px rgba(31, 138, 91, 0.07);
        }
        .message--system {
          margin-left: auto;
          margin-right: auto;
          background: var(--system);
          border-color: #d8c5f5;
        }
        .message-label {
          width: fit-content;
          border-radius: 999px;
          padding: 3px 8px;
          background: rgba(17, 24, 39, 0.06);
          color: var(--muted-strong);
          font-size: 0.76rem;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .message--prompt .message-label {
          justify-self: end;
          background: rgba(15, 111, 255, 0.12);
          color: #0b4fb3;
        }
        .message--response .message-label {
          justify-self: start;
          background: rgba(31, 138, 91, 0.12);
          color: #176b47;
        }
        .message--system .message-label {
          justify-self: center;
        }
        .message-body {
          color: #111827;
          font-size: 1rem;
          line-height: 1.68;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .message-body strong {
          font-weight: 800;
        }
        .message-body code {
          padding: 0.1em 0.32em;
          border: 1px solid var(--border);
          border-radius: 5px;
          background: rgba(255, 255, 255, 0.78);
          color: #0f172a;
          font-family: var(--font-mono);
          font-size: 0.92em;
        }
        .message-body a {
          color: var(--accent-strong);
          font-weight: 650;
        }
        .document-flow {
          max-inline-size: 76ch;
          margin: 0 auto;
          color: #111827;
        }
        .document-flow h3 {
          margin: 1.35em 0 0.45em;
          font-size: 1.24rem;
          line-height: 1.25;
        }
        .document-flow h3:first-child {
          margin-top: 0;
        }
        .document-flow p,
        .document-flow pre {
          margin: 0 0 1em;
          line-height: 1.72;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .document-flow pre,
        .raw-view {
          max-width: 100%;
          overflow: auto;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: #ffffff;
          padding: 16px;
          font-family: var(--font-mono);
          font-size: 0.9rem;
          line-height: 1.62;
          tab-size: 2;
        }
        mark {
          border-radius: 4px;
          background: #fde68a;
          color: inherit;
          padding: 0 0.12em;
        }
        .empty-state {
          max-inline-size: 58ch;
          margin: 0 auto;
          padding: clamp(28px, 6vw, 56px);
          border: 1px dashed var(--border-strong);
          border-radius: var(--radius);
          background: rgba(255, 255, 255, 0.72);
          color: var(--muted);
          text-align: center;
        }
        .preview-message {
          padding: clamp(24px, 5vw, 48px);
          color: var(--muted);
          background: #fbfcfe;
        }
        @media (max-width: 900px) {
          .topbar {
            display: grid;
            align-items: start;
          }
          h1 {
            font-size: 2.6rem;
          }
          .actions {
            justify-content: flex-start;
          }
          .reader-layout {
            grid-template-columns: 1fr;
            min-height: auto;
          }
          .file-list {
            position: static;
            display: flex;
            overflow-x: auto;
            padding-bottom: 3px;
            scroll-snap-type: x mandatory;
          }
          .file-tab {
            flex: 0 0 min(280px, 84vw);
            scroll-snap-align: start;
          }
          .reader-body {
            grid-template-columns: 1fr;
          }
          .reader-inspector {
            border-top: 1px solid var(--border);
            border-left: 0;
          }
          .chat-stream {
            height: auto;
            min-height: 50vh;
          }
        }
        @media (max-width: 520px) {
          main {
            width: min(100% - 16px, 1280px);
            padding: 10px 0 18px;
          }
          .actions a,
          .button {
            width: 100%;
          }
          .reader-actions {
            width: 100%;
            justify-content: stretch;
          }
          .load-status {
            width: 100%;
            white-space: normal;
          }
          h1 {
            font-size: 1.55rem;
          }
          .reader-header {
            display: grid;
          }
          .reader-toolbar {
            grid-template-columns: 1fr;
            align-items: stretch;
          }
          .mode-switch {
            width: 100%;
          }
          .mode-button {
            flex: 1;
          }
          .search-box {
            grid-template-columns: 1fr;
          }
          .chat-stream {
            padding: 14px;
          }
          .message {
            padding: 14px;
          }
        }
        /* Focused reader redesign: fewer panels, stronger hierarchy, chat-native transcript. */
        :root {
          --page: #f7f7f5;
          --shell: #ffffff;
          --sidebar: #f1f1ef;
          --sidebar-border: #deded8;
          --ink: #202123;
          --ink-soft: #565b66;
          --ink-muted: #8a9099;
          --line: #e3e3df;
          --line-strong: #cecec8;
          --primary: #111827;
          --primary-hover: #242936;
          --blue: #ffffff;
          --blue-soft: #1f6feb;
          --blue-border: #1557bf;
          --green: #064e3b;
          --green-soft: #d8f8e8;
          --green-border: #76d5a7;
          --system-soft: #f5f0ff;
          --user-bubble: #1f6feb;
          --font: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        }
        body {
          background: var(--page);
          color: var(--ink);
        }
        main {
          width: 100%;
          min-height: 100dvh;
          margin: 0;
          padding: 0;
        }
        .reader-layout {
          display: grid;
          grid-template-columns: minmax(260px, 302px) minmax(0, 1fr);
          min-height: 100dvh;
          margin: 0;
          border: 0;
          border-radius: 0;
          background: var(--shell);
          box-shadow: none;
          overflow: hidden;
        }
        .sidebar {
          min-width: 0;
          display: grid;
          grid-template-rows: auto auto auto minmax(0, 1fr);
          gap: 12px;
          min-height: 100dvh;
          padding: 16px 14px;
          border-right: 1px solid var(--sidebar-border);
          background: var(--sidebar);
        }
        .brand-block {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .brand-mark {
          width: 34px;
          height: 34px;
          display: grid;
          place-items: center;
          border-radius: 9px;
          background: #111827;
          color: #ffffff;
          font-weight: 800;
        }
        .brand-title,
        .brand-subtitle,
        .batch-created {
          margin: 0;
        }
        .brand-title {
          color: var(--ink);
          font-size: 0.96rem;
          font-weight: 780;
          line-height: 1.2;
        }
        .brand-subtitle,
        .batch-created {
          color: var(--ink-muted);
          font-size: 0.82rem;
          font-weight: 650;
        }
        .batch-summary {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          font-size: 0.78rem;
        }
        .batch-summary span {
          border: 1px solid var(--line);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.62);
          padding: 4px 8px;
        }
        .file-list {
          min-height: 0;
          display: grid;
          align-content: start;
          gap: 4px;
          overflow: auto;
          padding: 4px 0 0;
          border: 0;
          background: transparent;
        }
        .file-tab {
          display: grid;
          grid-template-columns: 22px minmax(0, 1fr);
          gap: 9px;
          min-height: 58px;
          padding: 10px 10px 12px;
          border: 1px solid transparent;
          border-radius: 9px;
          background: transparent;
          color: var(--ink);
          transition: background 0.16s ease, border-color 0.16s ease;
        }
        .file-tab:hover,
        .file-tab.is-active {
          border-color: var(--line-strong);
          background: #ffffff;
          transform: none;
        }
        .file-index {
          width: 20px;
          height: 20px;
          display: grid;
          place-items: center;
          border-radius: 999px;
          background: #e4e4df;
          color: var(--ink-soft);
          font-family: var(--font);
          font-size: 0.72rem;
          font-weight: 760;
        }
        .file-name {
          color: var(--ink);
          font-size: 0.9rem;
          line-height: 1.2;
        }
        .file-meta {
          color: var(--ink-muted);
          font-size: 0.78rem;
        }
        .file-progress {
          height: 2px;
          background: rgba(17, 24, 39, 0.07);
        }
        .file-progress span {
          background: var(--green);
        }
        .reader {
          min-width: 0;
          background: var(--shell);
        }
        .text-panel {
          height: 100dvh;
          min-height: 0;
          display: grid;
          grid-template-rows: auto auto 2px minmax(0, 1fr);
        }
        .text-panel[hidden] {
          display: none;
        }
        .reader-header {
          min-height: 68px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          padding: 12px 22px;
          border-bottom: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.96);
        }
        .reader-title {
          min-width: 0;
        }
        .reader-kicker {
          margin: 0 0 3px;
          color: var(--ink-muted);
          font-size: 0.72rem;
          font-weight: 760;
          letter-spacing: 0.07em;
          text-transform: uppercase;
        }
        .reader h2 {
          margin: 0;
          color: var(--ink);
          font-size: 1.02rem;
          line-height: 1.24;
          font-weight: 760;
          overflow-wrap: anywhere;
        }
        .reader-subtitle {
          margin: 3px 0 0;
          color: var(--ink-muted);
          font-size: 0.82rem;
          font-weight: 650;
        }
        .reader-actions {
          flex: 0 0 auto;
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 8px;
        }
        .button {
          min-height: 34px;
          border: 1px solid var(--line-strong);
          border-radius: 8px;
          background: #ffffff;
          color: var(--ink);
          padding: 0 11px;
          font-size: 0.86rem;
          font-weight: 720;
          box-shadow: none;
        }
        .button:hover {
          background: #f5f5f2;
          border-color: #bdbdb6;
        }
        .button-primary {
          border-color: var(--primary);
          background: var(--primary);
          color: #ffffff;
        }
        .button-primary:hover {
          border-color: var(--primary-hover);
          background: var(--primary-hover);
        }
        .button:disabled {
          border-color: var(--line);
          background: #f1f1ef;
          color: var(--ink-muted);
        }
        .reader-toolbar {
          display: grid;
          grid-template-columns: auto minmax(220px, 1fr) auto auto;
          align-items: center;
          gap: 10px;
          min-height: 50px;
          padding: 8px 22px;
          border-bottom: 1px solid var(--line);
          background: rgba(250, 250, 248, 0.95);
        }
        .mode-switch {
          display: inline-flex;
          padding: 2px;
          border: 1px solid var(--line);
          border-radius: 9px;
          background: #ffffff;
        }
        .mode-button {
          min-height: 30px;
          border-radius: 7px;
          color: var(--ink-soft);
          padding: 0 10px;
          font-size: 0.82rem;
          font-weight: 740;
        }
        .mode-button.is-active {
          background: var(--ink);
          color: #ffffff;
        }
        .search-box {
          grid-template-columns: minmax(0, 1fr);
          gap: 4px;
          color: var(--ink-muted);
          font-size: 0;
        }
        .search-box span {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
        }
        .search-box input {
          min-height: 34px;
          border: 1px solid var(--line);
          border-radius: 9px;
          background: #ffffff;
          color: var(--ink);
          padding: 0 11px;
          font-size: 0.9rem;
        }
        .search-count,
        .auto-load {
          color: var(--ink-muted);
          font-size: 0.82rem;
          font-weight: 700;
          white-space: nowrap;
        }
        .auto-load {
          color: var(--ink-soft);
        }
        .progress-track {
          height: 2px;
          background: transparent;
        }
        .progress-track span {
          background: var(--green);
        }
        .reader-canvas {
          min-height: 0;
          min-width: 0;
          background: var(--shell);
        }
        .chat-stream {
          height: 100%;
          min-height: 0;
          overflow: auto;
          padding: 30px clamp(20px, 6vw, 82px) 56px;
          background: var(--shell);
          scroll-behavior: smooth;
        }
        .message {
          position: relative;
          width: auto;
          max-inline-size: min(72ch, 100%);
          margin: 0 auto 22px;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          box-shadow: none;
        }
        .message-label {
          width: fit-content;
          margin-bottom: 6px;
          padding: 0;
          border-radius: 0;
          background: transparent;
          color: var(--ink-muted);
          font-size: 0.72rem;
          font-weight: 780;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .message-body {
          color: var(--ink);
          font-size: 0.98rem;
          line-height: 1.66;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .message--prompt {
          width: fit-content;
          max-inline-size: min(66ch, 84%);
          margin-left: auto;
          margin-right: 0;
        }
        .message--prompt .message-label {
          justify-self: end;
          color: #1557bf;
        }
        .message--prompt .message-body {
          border: 1px solid var(--blue-border);
          border-radius: 18px 18px 5px 18px;
          background: var(--user-bubble);
          color: #ffffff;
          padding: 10px 14px;
          box-shadow: 0 12px 26px rgba(31, 111, 235, 0.22);
        }
        .message--prompt .message-body a,
        .message--prompt .message-body code {
          color: #ffffff;
        }
        .message--prompt .message-body code {
          border-color: rgba(255, 255, 255, 0.34);
          background: rgba(255, 255, 255, 0.16);
        }
        .message--response {
          max-inline-size: min(72ch, 100%);
          margin-left: 0;
          margin-right: auto;
          padding-left: 42px;
        }
        .message--response::before {
          content: "AI";
          position: absolute;
          left: 0;
          top: 1px;
          width: 28px;
          height: 28px;
          display: grid;
          place-items: center;
          border-radius: 9px;
          background: var(--green);
          color: #ffffff;
          font-size: 0.68rem;
          font-weight: 820;
          letter-spacing: 0.02em;
        }
        .message--response .message-label {
          color: var(--green);
        }
        .message--response .message-body {
          border: 1px solid var(--green-border);
          border-radius: 14px 18px 18px 5px;
          background: var(--green-soft);
          color: #073f31;
          padding: 10px 14px;
          box-shadow:
            inset 4px 0 0 var(--green),
            0 10px 24px rgba(16, 163, 127, 0.12);
        }
        .message--system {
          max-inline-size: min(64ch, 100%);
          margin-left: auto;
          margin-right: auto;
          border: 1px solid #e6defa;
          border-radius: 14px;
          background: var(--system-soft);
          padding: 10px 14px;
        }
        .message--system .message-label {
          justify-self: center;
        }
        .message-body strong {
          font-weight: 820;
        }
        .message-body code {
          border: 1px solid var(--line);
          border-radius: 6px;
          background: #ffffff;
          padding: 0.08em 0.32em;
          color: var(--ink);
          font-family: var(--font-mono);
          font-size: 0.92em;
        }
        .message-body a {
          color: var(--blue);
          font-weight: 680;
        }
        .document-flow {
          max-inline-size: 68ch;
          margin: 0 auto;
          color: var(--ink);
        }
        .document-flow h3 {
          margin: 1.2em 0 0.45em;
          font-size: 1.2rem;
          line-height: 1.28;
        }
        .document-flow p,
        .document-flow pre {
          margin: 0 0 1em;
          line-height: 1.68;
        }
        .raw-view {
          max-width: min(100%, 980px);
          margin: 0 auto;
          border: 1px solid var(--line);
          border-radius: 12px;
          background: #fbfbfa;
          padding: 16px;
          font-family: var(--font-mono);
          font-size: 0.88rem;
          line-height: 1.6;
        }
        mark {
          border-radius: 4px;
          background: #ffe58a;
          color: inherit;
          padding: 0 0.12em;
        }
        .empty-state {
          max-inline-size: 54ch;
          margin: 0 auto;
          border: 1px dashed var(--line-strong);
          border-radius: 14px;
          background: #fbfbfa;
          color: var(--ink-muted);
          padding: 42px 28px;
          text-align: center;
        }
        .preview-message {
          color: var(--ink-muted);
          background: #fbfbfa;
        }
        @media (max-width: 980px) {
          .reader-layout {
            grid-template-columns: 1fr;
            min-height: 100dvh;
          }
          .sidebar {
            min-height: auto;
            grid-template-rows: auto auto auto;
            gap: 8px;
            padding: 10px 12px;
            border-right: 0;
            border-bottom: 1px solid var(--sidebar-border);
          }
          .brand-block {
            display: none;
          }
          .batch-created {
            display: none;
          }
          .file-list {
            display: flex;
            gap: 6px;
            overflow-x: auto;
            padding: 2px 0 0;
          }
          .file-tab {
            flex: 0 0 min(285px, 84vw);
          }
          .text-panel {
            height: auto;
            min-height: calc(100dvh - 110px);
          }
          .chat-stream {
            height: auto;
            min-height: 62vh;
          }
        }
        @media (max-width: 620px) {
          .reader-header {
            display: grid;
            align-items: start;
            padding: 12px 14px;
          }
          .reader-actions {
            width: 100%;
            display: grid;
            grid-template-columns: 1fr 1fr;
          }
          .button {
            width: 100%;
          }
          .reader-toolbar {
            grid-template-columns: 1fr;
            padding: 10px 14px;
          }
          .mode-switch {
            width: 100%;
          }
          .mode-button {
            flex: 1;
          }
          .search-count,
          .auto-load {
            white-space: normal;
          }
          .chat-stream {
            padding: 22px 14px 44px;
          }
          .message--prompt {
            max-inline-size: 92%;
          }
          .message--response {
            padding-left: 36px;
          }
          .message--response::before {
            width: 26px;
            height: 26px;
          }
        }
      </style>
    </head>
    <body>
      <main>
        <section class="reader-layout" aria-label="Uploaded text files">
          <aside class="sidebar">
            <div class="brand-block">
              <div class="brand-mark" aria-hidden="true">A</div>
              <div>
                <p class="brand-title">AssetLink</p>
                <p class="brand-subtitle">Text reader</p>
              </div>
            </div>
            <div class="batch-summary">
              <span>Batch ${batchIdShort}</span>
              <span>${totalTexts} ${totalTexts === 1 ? "file" : "files"}</span>
            </div>
            <p class="batch-created">Created ${createdAt}</p>
            <nav class="file-list" aria-label="Choose a text file">
              ${tabs}
            </nav>
          </aside>
          <div class="reader">
            ${panels}
          </div>
        </section>
      </main>
      <script>
        (() => {
          const tabs = Array.from(document.querySelectorAll("[data-file-tab]"));
          const panels = Array.from(document.querySelectorAll("[data-file-panel]"));
          const loadMoreButtons = Array.from(document.querySelectorAll("[data-load-more]"));
          const copyButtons = Array.from(document.querySelectorAll("[data-copy-text]"));

          const escapeInline = (value) => String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

          const escapeRegExp = (value) => String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, "\\\\$&");

          const highlightSafe = (safe, query) => {
            const trimmed = String(query || "").trim();

            if (!trimmed) {
              return safe;
            }

            return safe.replace(new RegExp(escapeRegExp(escapeInline(trimmed)), "gi"), "<mark>$&</mark>");
          };

          const renderInline = (value, query) => {
            let safe = escapeInline(value);
            safe = highlightSafe(safe, query);
            safe = safe.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
            safe = safe.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
            safe = safe.replace(/__([^_]+)__/g, "<strong>$1</strong>");
            safe = safe.replace(/(^|\\s)(https?:\\/\\/[^\\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');

            return safe;
          };

          const countMatches = (value, query) => {
            const trimmed = String(query || "").trim();

            if (!trimmed) {
              return 0;
            }

            const matches = String(value || "").match(new RegExp(escapeRegExp(trimmed), "gi"));
            return matches ? matches.length : 0;
          };

          const roleFromBlock = (block) => {
            const match = block.match(/^\\s*(system|developer|user|human|prompt|assistant|codex|response)\\s*[:\\-]\\s*/i);

            if (!match) {
              return { label: "Text", tone: "note", text: block };
            }

            const rawRole = match[1].toLowerCase();
            const text = block.slice(match[0].length);

            if (rawRole === "assistant" || rawRole === "codex" || rawRole === "response") {
              return { label: "AI Assistant", tone: "response", text };
            }

            if (rawRole === "system" || rawRole === "developer") {
              return { label: "System", tone: "system", text };
            }

            return { label: "User", tone: "prompt", text };
          };

          const splitIntoBlocks = (text) => {
            const normalized = String(text || "").replace(/\\r\\n/g, "\\n");
            const roleLinePattern = /^\\s*(system|developer|user|human|prompt|assistant|codex|response)\\s*[:\\-]\\s*/i;
            const roleHeadingPattern = /^\\s*#{1,6}\\s*(system|developer|user|human|prompt|assistant|codex|response)\\s*:?\\s*$/i;
            const blocks = [];
            let current = [];
            let currentIsRoleBlock = false;

            const pushCurrent = () => {
              if (!current.length) {
                return;
              }

              blocks.push(current.join("\\n").trim());
              current = [];
              currentIsRoleBlock = false;
            };

            normalized.split("\\n").forEach((line) => {
              const trimmed = line.trim();
              const headingMatch = line.match(roleHeadingPattern);

              if (headingMatch) {
                pushCurrent();
                current = [headingMatch[1] + ":"];
                currentIsRoleBlock = true;
                return;
              }

              if (!trimmed) {
                if (currentIsRoleBlock) {
                  if (current.length > 1) {
                    current.push("");
                  }
                  return;
                }

                pushCurrent();
                return;
              }

              if (roleLinePattern.test(line) && current.length) {
                pushCurrent();
                current = [line];
                currentIsRoleBlock = true;
                return;
              }

              current.push(line);
            });

            pushCurrent();

            if (blocks.length === 0) {
              return [];
            }

            return blocks.flatMap((block) => {
              const role = roleFromBlock(block);
              const lines = role.text.split("\\n");

              if (lines.length <= 18) {
                return [block];
              }

              const rolePrefix = role.tone === "response"
                ? "Assistant:"
                : role.tone === "prompt"
                  ? "User:"
                  : role.tone === "system"
                    ? "System:"
                    : "";
              const groups = [];
              for (let index = 0; index < lines.length; index += 14) {
                const group = lines.slice(index, index + 14).join("\\n").trim();
                groups.push(rolePrefix ? rolePrefix + " " + group : group);
              }

              return groups;
            });
          };

          const renderTranscript = (stream, text, query) => {
            const blocks = splitIntoBlocks(text);

            if (blocks.length === 0) {
              return false;
            }

            const fragment = document.createDocumentFragment();
            blocks.forEach((block) => {
              const role = roleFromBlock(block);
              const message = document.createElement("article");
              message.className = "message message--" + role.tone;

              const label = document.createElement("div");
              label.className = "message-label";
              label.textContent = role.label;

              const body = document.createElement("div");
              body.className = "message-body";
              body.innerHTML = renderInline(role.text, query);

              message.append(label, body);
              fragment.appendChild(message);
            });

            stream.appendChild(fragment);
            return true;
          };

          const renderDocument = (stream, text, query) => {
            const normalized = String(text || "").replace(/\\r\\n/g, "\\n");
            const blocks = normalized.split(/\\n{2,}/).map((block) => block.trim()).filter(Boolean);

            if (!blocks.length) {
              return false;
            }

            const flow = document.createElement("div");
            flow.className = "document-flow";

            blocks.forEach((block) => {
              const heading = block.match(/^#{1,3}\\s+(.+)$/);
              const element = document.createElement(heading ? "h3" : "p");
              element.innerHTML = renderInline(heading ? heading[1] : block, query);
              flow.appendChild(element);
            });

            stream.appendChild(flow);
            return true;
          };

          const renderRaw = (stream, text, query) => {
            if (!String(text || "").length) {
              return false;
            }

            const raw = document.createElement("pre");
            raw.className = "raw-view";
            raw.innerHTML = highlightSafe(escapeInline(text), query);
            stream.appendChild(raw);
            return true;
          };

          const updateSearchCount = (panel) => {
            const content = panel?.querySelector("[data-text-content]");
            const input = panel?.querySelector("[data-search-input]");
            const count = panel?.querySelector("[data-search-count]");
            const query = input?.value || "";
            const matches = countMatches(content?.value || "", query);

            if (!count) {
              return;
            }

            count.textContent = query.trim()
              ? matches + " " + (matches === 1 ? "match" : "matches")
              : "No search";
          };

          const renderPanel = (panel) => {
            const stream = panel?.querySelector("[data-chat-stream]");
            const content = panel?.querySelector("[data-text-content]");
            const input = panel?.querySelector("[data-search-input]");

            if (!stream || !content) {
              return;
            }

            const mode = panel.dataset.readerMode || "transcript";
            const query = input?.value || "";
            stream.replaceChildren();

            let hasContent = false;

            if (mode === "raw") {
              hasContent = renderRaw(stream, content.value, query);
            } else if (mode === "document") {
              hasContent = renderDocument(stream, content.value, query);
            } else {
              hasContent = renderTranscript(stream, content.value, query);
            }

            if (!hasContent) {
              const empty = document.createElement("div");
              empty.className = "empty-state";
              empty.textContent = "This text file is empty.";
              stream.appendChild(empty);
            }

            updateSearchCount(panel);
          };

          const formatBytes = (value) => {
            const bytes = Number(value || 0);

            if (bytes < 1024) {
              return bytes + " B";
            }

            if (bytes < 1024 * 1024) {
              return (bytes / 1024).toFixed(1) + " KB";
            }

            return (bytes / (1024 * 1024)).toFixed(1) + " MB";
          };

          const setLoadState = (button, loaded, size, hasMore) => {
            const panel = button.closest("[data-file-panel]");
            const status = panel?.querySelector("[data-load-status]");
            const progress = panel?.querySelector("[data-progress-bar]");

            if (status) {
              status.textContent = "Loaded " + formatBytes(loaded) + " of " + formatBytes(size);
            }

            if (progress) {
              const percent = size > 0 ? Math.min(100, Math.round((loaded / size) * 100)) : 100;
              progress.style.width = percent + "%";
            }

            button.dataset.nextOffset = String(loaded);
            button.disabled = !hasMore;
            button.textContent = hasMore ? "Load more" : "Fully loaded";
          };

          const activate = (index) => {
            tabs.forEach((tab, tabIndex) => {
              const isActive = tabIndex === index;
              tab.classList.toggle("is-active", isActive);
              tab.setAttribute("aria-selected", isActive ? "true" : "false");
            });

            panels.forEach((panel, panelIndex) => {
              panel.hidden = panelIndex !== index;
            });
          };

          loadMoreButtons.forEach((button) => {
            button.addEventListener("click", async () => {
              if (button.disabled) {
                return;
              }

              const panel = button.closest("[data-file-panel]");
              const content = panel?.querySelector("[data-text-content]");
              const chunkUrl = button.dataset.chunkUrl;
              const nextOffset = Number(button.dataset.nextOffset || 0);
              const limit = Number(button.dataset.limit || ${TEXT_CHUNK_BYTES});

              if (!content || !chunkUrl || Number.isNaN(nextOffset)) {
                return;
              }

              button.disabled = true;
              button.textContent = "Loading...";

              try {
                const response = await fetch(chunkUrl + "?offset=" + encodeURIComponent(nextOffset) + "&limit=" + encodeURIComponent(limit));
                const payload = await response.json();

                if (!response.ok) {
                  throw new Error(payload.error || "Could not load more text.");
                }

                const chunk = payload.content || "";
                content.value += chunk;
                renderPanel(panel);
                setLoadState(button, payload.nextOffset, payload.size, payload.hasMore);
              } catch (error) {
                button.disabled = false;
                button.textContent = "Try again";

                const status = panel?.querySelector("[data-load-status]");
                if (status) {
                  status.textContent = error.message || "Could not load more text.";
                }
              }
            });
          });

          copyButtons.forEach((button) => {
            button.addEventListener("click", async () => {
              const panel = button.closest("[data-file-panel]");
              const content = panel?.querySelector("[data-text-content]");
              const text = content?.value || "";

              if (!navigator.clipboard || !content) {
                return;
              }

              const previous = button.textContent;
              try {
                await navigator.clipboard.writeText(text);
                button.textContent = "Copied";
                window.setTimeout(() => {
                  button.textContent = previous;
                }, 1400);
              } catch (error) {
                button.textContent = "Copy failed";
                window.setTimeout(() => {
                  button.textContent = previous;
                }, 1400);
              }
            });
          });

          tabs.forEach((tab, index) => {
            tab.addEventListener("click", () => activate(index));
            tab.addEventListener("keydown", (event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
                return;
              }

              event.preventDefault();
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const nextIndex = (index + delta + tabs.length) % tabs.length;
              tabs[nextIndex].focus();
              activate(nextIndex);
            });
          });

          panels.forEach((panel) => {
            panel.dataset.readerMode = "transcript";

            panel.querySelectorAll("[data-reader-mode]").forEach((button) => {
              button.addEventListener("click", () => {
                panel.dataset.readerMode = button.dataset.readerMode || "transcript";
                panel.querySelectorAll("[data-reader-mode]").forEach((item) => {
                  item.classList.toggle("is-active", item === button);
                });

                const label = panel.querySelector("[data-active-mode-label]");
                if (label) {
                  label.textContent = button.textContent || "Transcript";
                }

                renderPanel(panel);
              });
            });

            const search = panel.querySelector("[data-search-input]");
            if (search) {
              search.addEventListener("input", () => renderPanel(panel));
            }

            const stream = panel.querySelector("[data-chat-stream]");
            const autoLoad = panel.querySelector("[data-auto-load]");
            stream?.addEventListener("scroll", () => {
              const button = panel.querySelector("[data-load-more]");

              if (!autoLoad?.checked || !button || button.disabled) {
                return;
              }

              const remaining = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
              if (remaining < 480) {
                button.click();
              }
            });

            renderPanel(panel);
          });
        })();
      </script>
    </body>
  </html>`;
}

async function buildBatchHtml(manifest) {
  const assets = normalizeManifestAssets(manifest);
  const imageAssets = assets.filter((asset) => asset.type === "image");
  const textAssets = assets.filter((asset) => asset.type === "text");
  const videoAssets = assets.filter((asset) => asset.type === "video");

  if (textAssets.length > 0 && imageAssets.length === 0 && videoAssets.length === 0) {
    return buildTextBatchHtml(manifest, textAssets);
  }

  if (videoAssets.length > 0 && imageAssets.length === 0 && textAssets.length === 0) {
    return buildVideoBatchHtml({
      ...manifest,
      videos: videoAssets
    });
  }

  return buildImageBatchHtml({
    ...manifest,
    images: imageAssets
  });
}

function capitalizeLabel(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildMediaBatchHtml(manifest, mediaItems, { singular, plural, emptyIcon, hasVideo = false }) {
  const totalItems = mediaItems.length;
  const label = capitalizeLabel(singular);
  const batchId = escapeHtml(manifest.batchId);
  const batchUrl = buildBatchUrl(manifest.batchId);
  const batchJsonUrl = `${batchUrl}/json`;
  const batchSummary = totalItems > 1
    ? `Browse the upload one ${singular} at a time.`
    : totalItems === 1
      ? "Browse the upload at full size."
      : `This batch does not contain any ${plural} yet.`;

  const mediaSlides = mediaItems
    .map((item, index) => {
      const mediaUrl = buildAssetUrl(item.objectKey);
      const safeName = escapeHtml(item.originalName || `Uploaded ${singular}`);
      const slideNumber = index + 1;
      const isVideo = item.type === "video";
      const mediaElement = isVideo
        ? `<video src="${mediaUrl}" controls preload="metadata" class="slide-media slide-video" playsinline></video>`
        : `<img src="${mediaUrl}" alt="${safeName}" loading="${index === 0 ? "eager" : "lazy"}" class="slide-media slide-image" />`;
      const openLabel = isVideo ? "Open original" : "Open full size";

      return `
        <figure class="slide${index === 0 ? " is-active" : ""}" data-carousel-slide data-carousel-slide-index="${index}" aria-label="${label} ${slideNumber} of ${totalItems}">
          <div class="slide-frame">
            ${mediaElement}
          </div>
          <figcaption class="slide-caption">
            <div class="slide-copy">
              <p class="slide-kicker">${label} ${slideNumber} of ${totalItems}</p>
              <h2 class="slide-title">${safeName}</h2>
            </div>
            <a href="${mediaUrl}" target="_blank" rel="noreferrer" class="open-original">${openLabel}</a>
          </figcaption>
        </figure>
      `;
    })
    .join("");

  const carouselControls = totalItems > 1 ? `
          <div class="carousel-controls" aria-label="Carousel navigation">
            <button type="button" class="carousel-control" data-carousel-prev aria-label="Previous ${singular}">
              <span aria-hidden="true">&larr;</span>
            </button>
            <button type="button" class="carousel-control" data-carousel-next aria-label="Next ${singular}">
              <span aria-hidden="true">&rarr;</span>
            </button>
          </div>
  ` : "";

  const carouselDots = totalItems > 1 ? `
            <div class="carousel-dots" aria-label="Choose a ${singular}">
              ${mediaItems
                .map((_, index) => {
                  const isActive = index === 0 ? " is-active" : "";
                  const ariaCurrent = index === 0 ? "true" : "false";

                  return `
                <button type="button" class="carousel-dot${isActive}" data-carousel-dot data-target-index="${index}" aria-label="Go to ${singular} ${index + 1}" aria-current="${ariaCurrent}"></button>
              `;
                })
                .join("")}
            </div>
  ` : "";

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>AssetLink Batch ${batchId}</title>
      <style>
        :root {
          color-scheme: light;
          --bg-primary: #f7f2eb;
          --bg-secondary: rgba(255, 255, 255, 0.84);
          --bg-surface: #ffffff;
          --text-primary: #2c2721;
          --text-secondary: #6f665a;
          --accent: #b8784b;
          --accent-strong: #8f5330;
          --border: rgba(44, 39, 33, 0.12);
          --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.05);
          --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.08);
          --shadow-lg: 0 18px 40px rgba(0, 0, 0, 0.12);
          --radius: 16px;
          --radius-lg: 22px;
          --radius-xl: 30px;
          --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          --page-gutter: clamp(12px, 2.4vw, 24px);
          --section-gap: clamp(18px, 3vw, 32px);
          --slide-gap: clamp(12px, 2vw, 18px);
          --slide-min-height: min(82vh, 900px);
          --slide-frame-min-height: clamp(320px, 62vh, 760px);
          --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          --font-serif: 'Cormorant Garamond', 'Times New Roman', serif;
        }
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        html {
          font-size: 16px;
          scroll-behavior: smooth;
        }
        body {
          margin: 0;
          font-family: var(--font-sans);
          overflow-x: hidden;
          background:
            radial-gradient(circle at top left, rgba(184, 120, 75, 0.16), transparent 26%),
            radial-gradient(circle at top right, rgba(143, 83, 48, 0.08), transparent 20%),
            linear-gradient(180deg, #fdf8f3 0%, var(--bg-primary) 100%);
          color: var(--text-primary);
          line-height: 1.6;
        }
        main {
          max-width: 1380px;
          margin: 0 auto;
          padding: clamp(20px, 4vw, 40px) var(--page-gutter) clamp(28px, 5vw, 56px);
          min-height: 100vh;
          min-height: 100dvh;
        }
        .header {
          text-align: center;
          margin-bottom: var(--section-gap);
          padding-bottom: clamp(18px, 2vw, 22px);
          border-bottom: 1px solid var(--border);
        }
        h1 {
          font-family: var(--font-serif);
          font-size: clamp(2.4rem, 5vw, 3.6rem);
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 12px;
          letter-spacing: 0;
          line-height: 1.05;
          overflow-wrap: anywhere;
          word-break: break-word;
          text-wrap: balance;
        }
        .batch-info {
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: clamp(8px, 1.5vw, 10px);
          color: var(--text-secondary);
          font-size: clamp(0.95rem, 1.2vw, 1rem);
          margin-bottom: 10px;
        }
        .batch-id {
          font-family: var(--font-sans);
          font-weight: 500;
          background: var(--bg-surface);
          padding: 8px 16px;
          border-radius: 50px;
          border: 1px solid var(--border);
          font-size: 0.9rem;
        }
        .batch-summary {
          max-width: 760px;
          margin: 0 auto;
          color: var(--text-secondary);
          font-size: clamp(0.92rem, 1.2vw, 0.98rem);
          line-height: 1.55;
        }
        .actions {
          margin: 20px 0 6px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: clamp(10px, 1.6vw, 12px);
        }
        .actions a,
        .actions button {
          appearance: none;
          border: 1px solid var(--border);
          background: var(--bg-secondary);
          color: var(--accent);
          text-decoration: none;
          font-weight: 500;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 44px;
          padding: 10px 16px;
          border-radius: 999px;
          box-shadow: var(--shadow-sm);
          transition: var(--transition);
          cursor: pointer;
          font: inherit;
          min-width: min(100%, 220px);
        }
        .actions a:hover,
        .actions button:hover {
          color: var(--accent-strong);
          border-color: rgba(184, 120, 75, 0.45);
          background: var(--bg-surface);
          box-shadow: var(--shadow-md);
          transform: translateY(-2px);
        }
        .actions button:focus-visible,
        .carousel-control:focus-visible,
        .carousel-dot:focus-visible,
        .open-original:focus-visible {
          outline: 2px solid rgba(184, 120, 75, 0.45);
          outline-offset: 2px;
        }
        .carousel {
          margin-top: var(--section-gap);
          position: relative;
        }
        .carousel-shell {
          position: relative;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: clamp(20px, 3vw, var(--radius-xl));
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          backdrop-filter: blur(14px);
        }
        .carousel-viewport {
          overflow-x: auto;
          overflow-y: hidden;
          scroll-snap-type: x mandatory;
          scroll-behavior: smooth;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
          scrollbar-width: none;
        }
        .carousel-viewport::-webkit-scrollbar {
          display: none;
        }
        .carousel-track {
          display: flex;
          align-items: stretch;
        }
        .slide {
          flex: 0 0 100%;
          padding: clamp(12px, 2vw, 28px);
          display: flex;
          flex-direction: column;
          gap: var(--slide-gap);
          min-height: var(--slide-min-height);
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }
        .slide-frame {
          position: relative;
          flex: 1 1 auto;
          min-height: var(--slide-frame-min-height);
          padding: clamp(10px, 1.8vw, 18px);
          border-radius: clamp(16px, 2vw, calc(var(--radius-xl) - 10px));
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(247, 242, 234, 0.96));
          border: 1px solid rgba(44, 39, 33, 0.08);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.8),
            var(--shadow-md);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .slide-frame::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5);
        }
        .slide-image,
        .slide-video {
          width: 100%;
          height: 100%;
          object-fit: contain;
          display: block;
          border-radius: clamp(12px, 1.5vw, calc(var(--radius-xl) - 16px));
          background: transparent;
        }
        .slide-video {
          background: #000;
        }
        .slide.is-active .slide-frame {
          border-color: rgba(184, 120, 75, 0.32);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.8),
            0 16px 36px rgba(44, 39, 33, 0.14);
        }
        .slide-caption {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: clamp(12px, 1.8vw, 16px);
          padding: 0 6px 4px;
        }
        .slide-copy {
          min-width: 0;
        }
        .slide-kicker {
          margin-bottom: 6px;
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--accent);
        }
        .slide-title {
          font-family: var(--font-serif);
          font-size: clamp(1.2rem, 2.2vw, 2rem);
          font-weight: 600;
          line-height: 1.15;
          word-break: break-word;
          color: var(--text-primary);
        }
        .open-original {
          flex: 0 0 auto;
          color: var(--accent-strong);
          text-decoration: none;
          font-weight: 600;
          white-space: nowrap;
          padding: 10px 14px;
          border-radius: 999px;
          border: 1px solid rgba(184, 120, 75, 0.18);
          background: rgba(184, 120, 75, 0.1);
          box-shadow: var(--shadow-sm);
          transition: var(--transition);
        }
        .open-original:hover {
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
        }
        .carousel-controls {
          position: absolute;
          inset: 50% 0 auto;
          transform: translateY(-50%);
          display: flex;
          justify-content: space-between;
          pointer-events: none;
          padding: 0 clamp(8px, 2vw, 14px);
        }
        .carousel-control {
          pointer-events: auto;
          display: grid;
          place-items: center;
          width: clamp(42px, 4vw, 50px);
          height: clamp(42px, 4vw, 50px);
          border: 1px solid rgba(255, 255, 255, 0.55);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.92);
          color: var(--text-primary);
          overflow: hidden;
          transition: var(--transition);
          box-shadow: var(--shadow-lg);
          cursor: pointer;
        }
        .carousel-control:hover {
          background: var(--bg-surface);
          transform: scale(1.04);
        }
        .carousel-control:disabled {
          opacity: 0.4;
          cursor: default;
          transform: none;
        }
        .carousel-footer {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: clamp(10px, 1.8vw, 14px);
          margin-top: clamp(14px, 2vw, 18px);
        }
        .carousel-status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-secondary);
          box-shadow: var(--shadow-sm);
          color: var(--text-secondary);
          font-weight: 500;
          font-size: clamp(0.9rem, 1.1vw, 1rem);
        }
        .carousel-dots {
          display: flex;
          justify-content: center;
          flex-wrap: wrap;
          gap: clamp(8px, 1.5vw, 10px);
          max-width: 100%;
        }
        .carousel-dot {
          width: clamp(9px, 1vw, 10px);
          height: clamp(9px, 1vw, 10px);
          border: none;
          border-radius: 999px;
          background: rgba(44, 39, 33, 0.22);
          padding: 0;
          cursor: pointer;
          transition: var(--transition);
        }
        .carousel-dot.is-active {
          width: clamp(22px, 2.4vw, 28px);
          background: var(--accent);
        }
        .carousel-dot:hover {
          background: var(--accent-strong);
        }
        .empty {
          margin-top: var(--section-gap);
          padding: clamp(44px, 8vw, 64px) 24px;
          text-align: center;
          background: var(--bg-secondary);
          border: 2px dashed var(--border);
          border-radius: var(--radius-xl);
          box-shadow: var(--shadow-sm);
          color: var(--text-secondary);
        }
        .empty-icon {
          font-size: 3rem;
          margin-bottom: 16px;
          color: var(--accent);
          opacity: 0.7;
        }
        .empty-title {
          font-family: var(--font-serif);
          font-size: 1.35rem;
          font-weight: 600;
          margin-bottom: 8px;
          color: var(--text-primary);
        }
        .empty-description {
          font-size: clamp(0.92rem, 1.1vw, 0.95rem);
          line-height: 1.55;
          max-width: 460px;
          margin: 0 auto;
        }
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(18px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .header,
        .actions,
        .carousel,
        .empty {
          animation: fadeIn 0.5s ease-out forwards;
        }
        @media (max-width: 1024px) {
          :root {
            --slide-min-height: min(80vh, 860px);
            --slide-frame-min-height: clamp(280px, 58vh, 700px);
          }
          .slide-caption {
            align-items: center;
          }
        }
        @media (max-width: 768px) {
          main {
            padding: 20px 14px 34px;
          }
          h1 {
            font-size: clamp(2rem, 6vw, 2.8rem);
          }
          .batch-info {
            flex-direction: column;
            gap: 6px;
          }
          .actions {
            margin-top: 16px;
          }
          .actions a,
          .actions button {
            width: min(100%, 320px);
          }
          .carousel-shell {
            border: none;
            border-radius: 0;
            box-shadow: none;
            overflow: visible;
            backdrop-filter: none;
            background: transparent;
          }
          .carousel-viewport {
            overflow: visible;
            scroll-snap-type: none;
          }
          .carousel-track {
            display: block;
          }
          .slide {
            min-height: auto;
            padding: 0;
            gap: 10px;
            margin-bottom: 20px;
          }
          .slide-frame {
            min-height: auto;
            padding: 0;
            border: none;
            background: transparent;
            box-shadow: none;
          }
          .slide-frame::after {
            display: none;
          }
          .slide-image,
          .slide-video {
            width: 100%;
            height: auto;
            border-radius: var(--radius-lg);
          }
          .slide-video {
            background: #000;
          }
          .slide.is-active .slide-frame {
            border-color: transparent;
            box-shadow: none;
          }
          .slide-caption {
            flex-direction: column;
            align-items: flex-start;
            padding: 0 2px;
            gap: 8px;
          }
          .slide-kicker {
            display: none;
          }
          .slide-title {
            font-size: clamp(1.05rem, 4.8vw, 1.3rem);
          }
          .open-original {
            width: auto;
          }
          .carousel-controls,
          .carousel-status,
          .carousel-dots,
          .carousel-footer {
            display: none !important;
          }
          .empty {
            padding: 52px 20px;
          }
        }
        @media (max-width: 480px) {
          :root {
            --slide-min-height: auto;
            --slide-frame-min-height: auto;
          }
          h1 {
            font-size: clamp(1.65rem, 8vw, 2.1rem);
          }
          .batch-summary {
            font-size: 0.9rem;
          }
          .actions a,
          .actions button {
            width: 100%;
            min-width: 0;
          }
          .slide-title {
            font-size: clamp(1rem, 5vw, 1.2rem);
          }
        }
        @media (max-height: 720px) and (orientation: landscape) {
          :root {
            --slide-min-height: min(92vh, 640px);
            --slide-frame-min-height: clamp(220px, 58vh, 520px);
          }
          main {
            padding-top: 18px;
            padding-bottom: 24px;
          }
          .header {
            margin-bottom: 16px;
            padding-bottom: 14px;
          }
          .carousel {
            margin-top: 18px;
          }
          .slide-caption {
            flex-direction: row;
            align-items: center;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          html {
            scroll-behavior: auto;
          }
          .carousel-viewport {
            scroll-behavior: auto;
          }
          *,
          *::before,
          *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
        @media print {
          body {
            background: white;
            color: #000;
          }
          main {
            max-width: none;
            padding: 0;
          }
          .actions,
          .carousel-controls,
          .carousel-status,
          .carousel-dots {
            display: none !important;
          }
          .header {
            border-bottom: none;
            margin-bottom: 20px;
          }
          .carousel-shell {
            border: none;
            box-shadow: none;
            background: transparent;
          }
          .carousel-viewport {
            overflow: visible;
          }
          .carousel-track {
            display: block;
          }
          .slide {
            padding: 0 0 28px;
            min-height: auto;
            break-after: page;
            page-break-after: always;
          }
          .slide-frame {
            display: block;
            min-height: auto;
            padding: 0;
            border: none;
            box-shadow: none;
            background: transparent;
          }
          .slide-frame::after {
            display: none;
          }
          .slide-image,
          .slide-video {
            width: 100%;
            height: auto;
            max-height: 90vh;
          }
          .slide-caption {
            padding: 12px 0 0;
          }
        }
      </style>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Cormorant+Garamond:wght@600&display=swap" rel="stylesheet">
    </head>
    <body>
      <main>
        <div class="header">
          <h1>Batch ${batchId}</h1>
          <div class="batch-info">
            <span>${totalItems} ${totalItems === 1 ? singular : plural}</span>
            <span class="batch-id">${batchId}</span>
          </div>
          <p class="batch-summary">${batchSummary}</p>
        </div>
        <div class="actions">
          <a href="${batchJsonUrl}" target="_blank" rel="noreferrer">
            View JSON Data
          </a>
          <button type="button" data-print>
            Print Gallery
          </button>
        </div>
        ${totalItems > 0 ? `
          <section class="carousel" aria-label="Batch ${singular} carousel" data-carousel${hasVideo ? ' data-carousel-has-video="true"' : ""}>
            <div class="carousel-shell">
              <div class="carousel-viewport" data-carousel-viewport tabindex="0">
                <div class="carousel-track">
                  ${mediaSlides}
                </div>
              </div>
              ${carouselControls}
            </div>
            <div class="carousel-footer">
              <p class="carousel-status" data-carousel-status aria-live="polite">${label} 1 of ${totalItems}</p>
              ${carouselDots}
            </div>
          </section>
        ` : `
          <div class="empty">
            <div class="empty-icon">${emptyIcon}</div>
            <h2 class="empty-title">No ${plural} uploaded yet</h2>
            <p class="empty-description">Upload ${plural} to browse them here in a full-size carousel.</p>
          </div>
        `}
      </main>
      <script>
        (() => {
          const printButton = document.querySelector('[data-print]');
          printButton?.addEventListener('click', () => window.print());

          const carousel = document.querySelector('[data-carousel]');
          if (!carousel) {
            return;
          }

          const isMobileLayout = window.matchMedia("(max-width: 768px)").matches;
          if (isMobileLayout) {
            return;
          }

          const viewport = carousel.querySelector('[data-carousel-viewport]');
          const slides = Array.from(carousel.querySelectorAll('[data-carousel-slide]'));
          const prevButton = carousel.querySelector('[data-carousel-prev]');
          const nextButton = carousel.querySelector('[data-carousel-next]');
          const status = carousel.querySelector('[data-carousel-status]');
          const dots = Array.from(carousel.querySelectorAll('[data-carousel-dot]'));
          let currentIndex = 0;

          if (!slides.length) {
            return;
          }

          slides.forEach((slide, index) => {
            slide.dataset.carouselSlideIndex = String(index);
          });

          const updateState = (index) => {
            const total = slides.length;
            currentIndex = ((index % total) + total) % total;

            slides.forEach((slide, slideIndex) => {
              slide.classList.toggle('is-active', slideIndex === currentIndex);
            });

            dots.forEach((dot, dotIndex) => {
              const isActive = dotIndex === currentIndex;
              dot.classList.toggle('is-active', isActive);
              dot.setAttribute('aria-current', isActive ? 'true' : 'false');
            });

            if (status) {
              status.textContent = '${label} ' + (currentIndex + 1) + ' of ' + total;
            }

            if (carousel.dataset.carouselHasVideo === 'true') {
              slides.forEach((slide, slideIndex) => {
                if (slideIndex !== currentIndex) {
                  slide.querySelector('video')?.pause();
                }
              });
            }
          };

          const scrollToIndex = (index, behavior) => {
            updateState(index);
            slides[currentIndex].scrollIntoView({
              behavior: behavior || 'smooth',
              block: 'nearest',
              inline: 'start'
            });
          };

          if ("IntersectionObserver" in window) {
            const observer = new IntersectionObserver((entries) => {
              let visibleSlide = null;

              entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                  return;
                }

                if (!visibleSlide || entry.intersectionRatio > visibleSlide.intersectionRatio) {
                  visibleSlide = entry;
                }
              });

              if (!visibleSlide) {
                return;
              }

              const nextIndex = Number(visibleSlide.target.dataset.carouselSlideIndex);
              if (!Number.isNaN(nextIndex) && nextIndex !== currentIndex) {
                updateState(nextIndex);
              }
            }, {
              root: viewport,
              threshold: [0.55, 0.75, 0.9]
            });

            slides.forEach((slide) => {
              observer.observe(slide);
            });
          }

          prevButton?.addEventListener('click', () => scrollToIndex(currentIndex - 1));
          nextButton?.addEventListener('click', () => scrollToIndex(currentIndex + 1));

          dots.forEach((dot) => {
            dot.addEventListener('click', () => {
              const targetIndex = Number(dot.dataset.targetIndex);
              if (Number.isNaN(targetIndex)) {
                return;
              }

              scrollToIndex(targetIndex);
            });
          });

          window.addEventListener('keydown', (event) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
              return;
            }

            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              scrollToIndex(currentIndex - 1);
              return;
            }

            if (event.key === 'ArrowRight') {
              event.preventDefault();
              scrollToIndex(currentIndex + 1);
              return;
            }

            if (event.key === 'Home') {
              event.preventDefault();
              scrollToIndex(0);
              return;
            }

            if (event.key === 'End') {
              event.preventDefault();
              scrollToIndex(slides.length - 1);
            }
          });

          updateState(0);
        })();
      </script>
    </body>
  </html>`;
}

function buildImageBatchHtml(manifest) {
  return buildMediaBatchHtml(manifest, manifest.images, {
    singular: "image",
    plural: "images",
    emptyIcon: "📷"
  });
}

function buildVideoBatchHtml(manifest) {
  return buildMediaBatchHtml(manifest, manifest.videos, {
    singular: "video",
    plural: "videos",
    emptyIcon: "🎬",
    hasVideo: true
  });
}

app.get("/", (req, res) => {
  res.json({
    service: "AssetLink",
    uploadEndpoint: "POST /upload",
    videoUploadEndpoint: "POST /upload-video",
    textUploadEndpoint: "POST /upload-text",
    textChunkEndpoint: "GET /uploads/:batchId/text/:assetIndex?offset=<bytes>&limit=<bytes>",
    auth: "Authorization: Bearer <API_TOKEN>",
    uploadResult: "Each upload returns a batch-specific link at /uploads/:batchId",
    imageField: "images",
    videoField: "videos",
    textField: "texts"
  });
});

app.post("/upload", requireToken, async (req, res, next) => {
  let parser;

  try {
    parser = busboy({
      headers: req.headers
    });
  } catch (error) {
    return res.status(400).json({
      error: "Request must be multipart/form-data"
    });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const batchId = crypto.randomUUID();
      const uploaded = [];
      const uploadTasks = [];
      let fileCount = 0;
      let imageIndex = 0;
      let failed = false;

      const fail = (error) => {
        if (failed) {
          return;
        }
        failed = true;
        reject(error);
      };

      parser.on("file", (fieldName, fileStream, info) => {
        const originalName = info.filename || "upload";
        const mimeType = info.mimeType || "application/octet-stream";

        if (fieldName !== "images") {
          fileStream.resume();
          return;
        }

        if (!mimeType.startsWith("image/")) {
          fileStream.resume();
          fail(new Error(`Unsupported file type for ${originalName}`));
          return;
        }

        fileCount += 1;
        const currentImageIndex = imageIndex;
        imageIndex += 1;

        const objectKey = safeObjectName(originalName);
        const uploadTask = uploadObjectStream({
          objectName: objectKey,
          stream: fileStream,
          contentType: mimeType
        })
          .then(() => {
            uploaded[currentImageIndex] = {
              type: "image",
              originalName,
              objectKey,
              mimeType,
              url: buildAssetUrl(objectKey)
            };
          })
          .catch(fail);

        fileStream.on("error", fail);
        uploadTasks.push(uploadTask);
      });

      parser.on("error", fail);

      parser.on("close", async () => {
        if (failed) {
          return;
        }

        try {
          await Promise.all(uploadTasks);

          if (fileCount === 0) {
            return reject(new Error("At least one image file is required in the images field"));
          }

          await saveBatchManifest(batchId, uploaded);

          resolve({
            message: "Images uploaded successfully",
            batchId,
            batchUrl: buildBatchUrl(batchId),
            batchJsonUrl: `${buildBatchUrl(batchId)}/json`,
            images: uploaded
          });
        } catch (error) {
          fail(error);
        }
      });

      req.pipe(parser);
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.message === "At least one image file is required in the images field") {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.message.startsWith("Unsupported file type for ")) {
      return res.status(400).json({
        error: error.message
      });
    }

    return next(error);
  }
});

app.post("/upload-video", requireToken, async (req, res, next) => {
  let parser;

  try {
    parser = busboy({
      headers: req.headers
    });
  } catch (error) {
    return res.status(400).json({
      error: "Request must be multipart/form-data"
    });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const batchId = crypto.randomUUID();
      const uploaded = [];
      const uploadTasks = [];
      let fileCount = 0;
      let videoIndex = 0;
      let failed = false;

      const fail = (error) => {
        if (failed) {
          return;
        }
        failed = true;
        reject(error);
      };

      parser.on("file", (fieldName, fileStream, info) => {
        const originalName = info.filename || "upload";
        const mimeType = info.mimeType || "application/octet-stream";
        const resolvedMimeType = resolveVideoMimeType(originalName, mimeType);

        if (fieldName !== "videos") {
          fileStream.resume();
          return;
        }

        if (!resolvedMimeType) {
          fileStream.resume();
          fail(new Error(`Unsupported file type for ${originalName}`));
          return;
        }

        fileCount += 1;
        const currentVideoIndex = videoIndex;
        videoIndex += 1;

        const objectKey = safeObjectName(originalName);
        const uploadTask = uploadObjectStream({
          objectName: objectKey,
          stream: fileStream,
          contentType: resolvedMimeType
        })
          .then(() => {
            uploaded[currentVideoIndex] = {
              type: "video",
              originalName,
              objectKey,
              mimeType: resolvedMimeType,
              url: buildAssetUrl(objectKey)
            };
          })
          .catch(fail);

        fileStream.on("error", fail);
        uploadTasks.push(uploadTask);
      });

      parser.on("error", fail);

      parser.on("close", async () => {
        if (failed) {
          return;
        }

        try {
          await Promise.all(uploadTasks);

          if (fileCount === 0) {
            return reject(new Error("At least one video file is required in the videos field"));
          }

          await saveBatchManifest(batchId, uploaded);

          resolve({
            message: "Videos uploaded successfully",
            batchId,
            batchUrl: buildBatchUrl(batchId),
            batchJsonUrl: `${buildBatchUrl(batchId)}/json`,
            videos: uploaded
          });
        } catch (error) {
          fail(error);
        }
      });

      req.pipe(parser);
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.message === "At least one video file is required in the videos field") {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.message.startsWith("Unsupported file type for ")) {
      return res.status(400).json({
        error: error.message
      });
    }

    return next(error);
  }
});

app.post("/upload-text", requireToken, async (req, res, next) => {
  let parser;

  try {
    parser = busboy({
      headers: req.headers
    });
  } catch (error) {
    return res.status(400).json({
      error: "Request must be multipart/form-data"
    });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const batchId = crypto.randomUUID();
      const uploaded = [];
      const uploadTasks = [];
      let fileCount = 0;
      let textIndex = 0;
      let failed = false;

      const fail = (error) => {
        if (failed) {
          return;
        }
        failed = true;
        reject(error);
      };

      parser.on("file", (fieldName, fileStream, info) => {
        const originalName = info.filename || "upload.txt";
        const mimeType = info.mimeType || "application/octet-stream";
        const detectedMimeType = mime.lookup(originalName) || mimeType;

        if (!TEXT_UPLOAD_FIELDS.has(fieldName)) {
          fileStream.resume();
          return;
        }

        if (!isSupportedTextFile(originalName, mimeType)) {
          fileStream.resume();
          fail(new Error(`Unsupported text file type for ${originalName}`));
          return;
        }

        fileCount += 1;
        const currentTextIndex = textIndex;
        textIndex += 1;

        const objectKey = safeObjectName(originalName);
        const uploadTask = uploadObjectStream({
          objectName: objectKey,
          stream: fileStream,
          contentType: "text/plain; charset=utf-8"
        })
          .then(() => {
            uploaded[currentTextIndex] = {
              type: "text",
              originalName,
              objectKey,
              mimeType: detectedMimeType,
              url: buildAssetUrl(objectKey)
            };
          })
          .catch(fail);

        fileStream.on("error", fail);
        uploadTasks.push(uploadTask);
      });

      parser.on("error", fail);

      parser.on("close", async () => {
        if (failed) {
          return;
        }

        try {
          await Promise.all(uploadTasks);

          if (fileCount === 0) {
            return reject(new Error("At least one text file is required in the texts field"));
          }

          await saveBatchManifest(batchId, uploaded);

          resolve({
            message: "Text files uploaded successfully",
            batchId,
            batchUrl: buildBatchUrl(batchId),
            batchJsonUrl: `${buildBatchUrl(batchId)}/json`,
            texts: uploaded
          });
        } catch (error) {
          fail(error);
        }
      });

      req.pipe(parser);
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.message === "At least one text file is required in the texts field") {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.message.startsWith("Unsupported text file type for ")) {
      return res.status(400).json({
        error: error.message
      });
    }

    return next(error);
  }
});

app.get("/assets/:objectKey", async (req, res, next) => {
  try {
    const objectKey = req.params.objectKey;
    const meta = await statObject(objectKey);
    const contentType = meta.metaData["content-type"] || mime.lookup(objectKey) || "application/octet-stream";
    const size = Number(meta.size || 0);
    const range = parseByteRange(req.headers.range, size);

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (range?.invalid) {
      res.setHeader("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }

    if (range) {
      const stream = await getObjectRangeStream(objectKey, range.start, range.length);

      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader("Content-Length", range.length);
      res.setHeader("Content-Type", contentType);
      return stream.pipe(res);
    }

    res.setHeader("Content-Type", contentType);
    if (size > 0) {
      res.setHeader("Content-Length", size);
    }

    const stream = await getObjectStream(objectKey);
    return stream.pipe(res);
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey") {
      return res.status(404).json({
        error: "Asset not found"
      });
    }
    return next(error);
  }
});

app.get("/images", async (req, res, next) => {
  try {
    const objects = await listObjects();
    return res.json({
      total: objects.filter((item) => !item.name.startsWith("uploads/") && !TEXT_EXTENSIONS.has(path.extname(item.name).toLowerCase())).length,
      images: objects
        .filter((item) => !item.name.startsWith("uploads/") && !TEXT_EXTENSIONS.has(path.extname(item.name).toLowerCase()))
        .map((item) => ({
        objectKey: item.name,
        size: item.size,
        lastModified: item.lastModified,
        url: buildAssetUrl(item.name)
        }))
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/uploads/:batchId/text/:assetIndex", async (req, res, next) => {
  try {
    const manifest = await getBatchManifest(req.params.batchId);
    const textAssets = normalizeManifestAssets(manifest).filter((asset) => asset.type === "text");
    const assetIndex = Number(req.params.assetIndex);

    if (!Number.isSafeInteger(assetIndex) || assetIndex < 0 || assetIndex >= textAssets.length) {
      return res.status(404).json({
        error: "Text asset not found"
      });
    }

    const asset = textAssets[assetIndex];
    const meta = await statObject(asset.objectKey);
    const size = Number(meta.size || 0);
    const offset = Math.min(parseNonNegativeInteger(req.query.offset, 0), size);
    const limit = clampChunkLimit(req.query.limit);
    const length = Math.min(limit, size - offset);
    const buffer = length > 0
      ? await getObjectRangeBuffer(asset.objectKey, offset, length)
      : Buffer.alloc(0);
    const nextOffset = offset + buffer.length;

    return res.json({
      batchId: manifest.batchId,
      assetIndex,
      originalName: asset.originalName,
      mimeType: asset.mimeType || mime.lookup(asset.objectKey) || "text/plain",
      offset,
      nextOffset,
      limit,
      size,
      hasMore: nextOffset < size,
      content: buffer.toString("utf8")
    });
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey" || error.name === "S3Error") {
      return res.status(404).json({
        error: "Upload batch or text asset not found"
      });
    }
    return next(error);
  }
});

app.get("/uploads/:batchId/json", async (req, res, next) => {
  try {
    const manifest = await getBatchManifest(req.params.batchId);
    return res.json({
      ...manifest,
      batchUrl: buildBatchUrl(manifest.batchId)
    });
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey" || error.name === "S3Error") {
      return res.status(404).json({
        error: "Upload batch not found"
      });
    }
    return next(error);
  }
});

app.get("/uploads/:batchId", async (req, res, next) => {
  try {
    const manifest = await getBatchManifest(req.params.batchId);
    const html = await buildBatchHtml(manifest);
    return res.type("html").send(html);
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey" || error.name === "S3Error") {
      return res.status(404).json({
        error: "Upload batch not found"
      });
    }
    return next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    error: "Internal server error"
  });
});

ensureBucket()
  .then(() => {
    const { protocol, server } = createListeningServer();

    server.listen(config.port, () => {
      console.log(`AssetLink listening on ${protocol} port ${config.port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
