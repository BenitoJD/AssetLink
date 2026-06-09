const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  parseByteRange,
  escapeHtml,
  isSupportedTextFile,
  resolveVideoMimeType,
  normalizeManifestAssets,
  buildMediaBatchHtml
} = require("../src/server");

describe("parseByteRange", () => {
  it("parses open-ended ranges", () => {
    assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99, length: 100 });
    assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19, length: 10 });
    assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99, length: 10 });
  });

  it("rejects invalid ranges", () => {
    assert.equal(parseByteRange("bytes=200-10", 100).invalid, true);
    assert.equal(parseByteRange("invalid", 100), null);
  });
});

describe("escapeHtml", () => {
  it("escapes unsafe characters", () => {
    assert.equal(escapeHtml('<script>"&\nline</script>'), "&lt;script&gt;&quot;&amp; line&lt;/script&gt;");
  });
});

describe("isSupportedTextFile", () => {
  it("accepts text extensions and mime types", () => {
    assert.equal(isSupportedTextFile("notes.txt", "application/octet-stream"), true);
    assert.equal(isSupportedTextFile("data.json", "application/json"), true);
    assert.equal(isSupportedTextFile("clip.mp4", "video/mp4"), false);
  });
});

describe("resolveVideoMimeType", () => {
  it("detects video mime types from file extension", () => {
    assert.equal(resolveVideoMimeType("clip.mp4", "application/octet-stream"), "video/mp4");
    assert.equal(resolveVideoMimeType("notes.txt", "text/plain"), null);
  });
});

describe("normalizeManifestAssets", () => {
  it("normalizes legacy image and video arrays", () => {
    const assets = normalizeManifestAssets({
      images: [{ objectKey: "a.jpg", originalName: "a.jpg" }],
      videos: [{ objectKey: "b.mp4", originalName: "b.mp4" }]
    });

    assert.equal(assets.length, 2);
    assert.equal(assets[0].type, "image");
    assert.equal(assets[1].type, "video");
  });
});

describe("buildMediaBatchHtml", () => {
  const manifest = { batchId: "batch-123" };
  const items = [
    {
      type: "image",
      originalName: "photo.jpg",
      objectKey: "photo.jpg"
    },
    {
      type: "video",
      originalName: "clip.mp4",
      objectKey: "clip.mp4"
    }
  ];

  it("renders grid and theater UI for mixed media", () => {
    const html = buildMediaBatchHtml(manifest, items, {
      singular: "file",
      plural: "files",
      emptyIcon: "🎞️",
      hasVideo: true
    });

    assert.match(html, /gallery-grid/);
    assert.match(html, /data-theater/);
    assert.match(html, /grid-tile/);
    assert.match(html, /filmstrip/);
    assert.match(html, /photo\.jpg/);
    assert.match(html, /clip\.mp4/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /Open image/);
    assert.match(html, /Open video/);
    assert.doesNotMatch(html, /carousel-viewport/);
  });

  it("renders empty state when there are no items", () => {
    const html = buildMediaBatchHtml(manifest, [], {
      singular: "image",
      plural: "images",
      emptyIcon: "📷"
    });

    assert.match(html, /Nothing here yet/);
    assert.doesNotMatch(html, /<div class="theater"/);
  });
});
