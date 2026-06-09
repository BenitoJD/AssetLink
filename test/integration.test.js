const assert = require("node:assert/strict");
const { before, describe, it } = require("node:test");

const config = require("../src/config");
const { app } = require("../src/server");
const {
  PNG_1X1,
  withApp,
  readBody,
  multipartUpload,
  multipartVideoUpload,
  multipartTextUpload
} = require("./helpers");

const token = config.apiToken;

before(async () => {
  const net = require("net");
  const { endPoint, port } = config.minio;

  await new Promise((resolve, reject) => {
    const socket = net.connect(port, endPoint);
    socket.setTimeout(2000);
    socket.on("connect", () => {
      socket.end();
      resolve();
    });
    socket.on("error", () => {
      reject(new Error(`MinIO is not reachable at ${endPoint}:${port}. Run: docker compose up -d`));
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`MinIO timed out at ${endPoint}:${port}`));
    });
  });
});

describe("AssetLink integration", () => {
  it("GET / returns service metadata", async () => {
    await withApp(app, async (base) => {
      const response = await fetch(`${base}/`);
      const body = await readBody(response);

      assert.equal(response.status, 200);
      assert.equal(body.json.service, "AssetLink");
      assert.equal(body.json.imageField, "images");
    });
  });

  it("rejects uploads without a bearer token", async () => {
    await withApp(app, async (base) => {
      const response = await fetch(`${base}/upload`, { method: "POST" });
      const body = await readBody(response);

      assert.equal(response.status, 401);
      assert.equal(body.json.error, "Unauthorized");
    });
  });

  it("rejects unsupported image uploads", async () => {
    await withApp(app, async (base) => {
      const response = await multipartUpload(base, token, [
        {
          name: "images",
          filename: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("hello")
        }
      ]);
      const body = await readBody(response);

      assert.equal(response.status, 400);
      assert.match(body.json.error, /Unsupported file type/);
    });
  });

  it("uploads images and serves batch viewer, JSON, and assets", async () => {
    await withApp(app, async (base) => {
      const uploadResponse = await multipartUpload(base, token, [
        {
          name: "images",
          filename: "one.png",
          mimeType: "image/png",
          buffer: PNG_1X1
        },
        {
          name: "images",
          filename: "two.png",
          mimeType: "image/png",
          buffer: PNG_1X1
        }
      ]);
      const uploadBody = await readBody(uploadResponse);

      assert.equal(uploadResponse.status, 201);
      assert.equal(uploadBody.json.images.length, 2);
      assert.match(uploadBody.json.message, /uploaded successfully/i);

      const batchId = uploadBody.json.batchId;
      const objectKey = uploadBody.json.images[0].objectKey;

      const viewerResponse = await fetch(`${base}/uploads/${batchId}`);
      const viewerBody = await readBody(viewerResponse);

      assert.equal(viewerResponse.status, 200);
      assert.match(viewerBody.contentType, /html/);
      assert.match(viewerBody.text, /gallery-grid/);
      assert.match(viewerBody.text, /data-theater/);
      assert.match(viewerBody.text, /share-panel/);
      assert.match(viewerBody.text, /View uploaded screenshots/);
      assert.match(viewerBody.text, /Open image/);
      assert.match(viewerBody.text, /target="_blank"/);
      assert.match(viewerBody.text, /rel="noopener noreferrer"/);
      assert.match(viewerBody.text, /one\.png/);
      assert.match(viewerBody.text, /two\.png/);
      assert.match(viewerBody.text, /2 images/);

      const jsonResponse = await fetch(`${base}/uploads/${batchId}/json`);
      const jsonBody = await readBody(jsonResponse);

      assert.equal(jsonResponse.status, 200);
      assert.equal(jsonBody.json.batchId, batchId);
      assert.equal(jsonBody.json.images.length, 2);

      const assetResponse = await fetch(`${base}/assets/${encodeURIComponent(objectKey)}`);
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers.get("content-type") || "", /image\/png/);
      assert.equal(assetResponse.headers.get("accept-ranges"), "bytes");

      const assetBuffer = Buffer.from(await assetResponse.arrayBuffer());
      assert.equal(assetBuffer.equals(PNG_1X1), true);

      const rangeResponse = await fetch(`${base}/assets/${encodeURIComponent(objectKey)}`, {
        headers: { Range: "bytes=0-3" }
      });
      assert.equal(rangeResponse.status, 206);
      assert.match(rangeResponse.headers.get("content-range") || "", /bytes 0-3\//);
    });
  });

  it("uploads mixed images and videos to the same batch", async () => {
    await withApp(app, async (base) => {
      const response = await multipartUpload(base, token, [
        {
          name: "images",
          filename: "cover.png",
          mimeType: "image/png",
          buffer: PNG_1X1
        },
        {
          name: "videos",
          filename: "clip.mp4",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("fake-mp4-bytes")
        }
      ]);
      const body = await readBody(response);

      assert.equal(response.status, 201);
      assert.equal(body.json.images.length, 1);
      assert.equal(body.json.videos.length, 1);

      const viewerResponse = await fetch(`${base}/uploads/${body.json.batchId}`);
      const viewerBody = await readBody(viewerResponse);

      assert.match(viewerBody.text, /2 files/);
      assert.match(viewerBody.text, /is-video/);
      assert.match(viewerBody.text, /filmstrip/);
      assert.match(viewerBody.text, /View uploaded videos/);
      assert.match(viewerBody.text, /Open video/);
      assert.match(viewerBody.text, /data-theater-open/);
    });
  });

  it("uploads videos through /upload-video", async () => {
    await withApp(app, async (base) => {
      const response = await multipartVideoUpload(base, token, [
        {
          name: "videos",
          filename: "demo.mp4",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("fake-mp4-bytes")
        }
      ]);
      const body = await readBody(response);

      assert.equal(response.status, 201);
      assert.equal(body.json.videos.length, 1);

      const viewerResponse = await fetch(`${base}/uploads/${body.json.batchId}`);
      const viewerBody = await readBody(viewerResponse);

      assert.match(viewerBody.text, /data-theater/);
      assert.match(viewerBody.text, /demo\.mp4/);
    });
  });

  it("uploads text files and serves the text reader", async () => {
    await withApp(app, async (base) => {
      const response = await multipartTextUpload(base, token, [
        {
          name: "texts",
          filename: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Line one\nLine two")
        }
      ]);
      const body = await readBody(response);

      assert.equal(response.status, 201);
      assert.equal(body.json.texts.length, 1);

      const viewerResponse = await fetch(`${base}/uploads/${body.json.batchId}`);
      const viewerBody = await readBody(viewerResponse);

      assert.match(viewerBody.text, /reader/);
      assert.doesNotMatch(viewerBody.text, /gallery-grid/);

      const chunkResponse = await fetch(`${base}/uploads/${body.json.batchId}/text/0?offset=0&limit=64`);
      const chunkBody = await readBody(chunkResponse);

      assert.equal(chunkResponse.status, 200);
      assert.match(chunkBody.json.content, /Line one/);
    });
  });

  it("returns 404 for unknown batches", async () => {
    await withApp(app, async (base) => {
      const response = await fetch(`${base}/uploads/does-not-exist`);
      const body = await readBody(response);

      assert.equal(response.status, 404);
      assert.equal(body.json.error, "Upload batch not found");
    });
  });
});
