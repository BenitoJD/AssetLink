const crypto = require("crypto");
const path = require("path");

const busboy = require("busboy");
const express = require("express");
const mime = require("mime-types");

const config = require("./config");
const {
  ensureBucket,
  getObjectBuffer,
  getObjectStream,
  listObjects,
  statObject,
  uploadObject,
  uploadObjectStream
} = require("./minio");

const app = express();

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

function buildBatchUrl(batchId) {
  return `${config.publicBaseUrl}/uploads/${encodeURIComponent(batchId)}`;
}

function safeObjectName(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

function batchManifestKey(batchId) {
  return `uploads/${batchId}.json`;
}

async function saveBatchManifest(batchId, images) {
  const manifest = {
    batchId,
    createdAt: new Date().toISOString(),
    images
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

function buildBatchHtml(manifest) {
  const imageCards = manifest.images
    .map((item) => {
      const url = buildAssetUrl(item.objectKey);
      return `
        <figure class="card">
          <a href="${url}" target="_blank" rel="noreferrer">
            <img src="${url}" alt="${item.originalName}" loading="lazy" />
          </a>
          <figcaption>${item.originalName}</figcaption>
        </figure>
      `;
    })
    .join("");

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>AssetLink Gallery</title>
      <style>
        :root {
          color-scheme: light;
          --bg: #f5efe6;
          --surface: #fffdf8;
          --text: #1e1d1a;
          --muted: #6f6a5e;
          --border: #ddd2bf;
          --accent: #b85c38;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          font-family: Georgia, "Times New Roman", serif;
          background:
            radial-gradient(circle at top left, rgba(184, 92, 56, 0.15), transparent 30%),
            linear-gradient(180deg, #f9f4eb 0%, var(--bg) 100%);
          color: var(--text);
        }
        main {
          max-width: 1200px;
          margin: 0 auto;
          padding: 32px 20px 48px;
        }
        h1 {
          margin: 0 0 8px;
          font-size: clamp(2rem, 4vw, 3.5rem);
        }
        p {
          margin: 0 0 24px;
          color: var(--muted);
          font-size: 1rem;
        }
        .grid {
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        }
        .card {
          margin: 0;
          padding: 12px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 18px;
          box-shadow: 0 10px 30px rgba(30, 29, 26, 0.08);
        }
        img {
          display: block;
          width: 100%;
          aspect-ratio: 1 / 1;
          object-fit: cover;
          border-radius: 12px;
          background: #efe3d2;
        }
        figcaption {
          margin-top: 10px;
          word-break: break-word;
          color: var(--muted);
          font-size: 0.92rem;
        }
        .empty {
          padding: 24px;
          background: var(--surface);
          border: 1px dashed var(--border);
          border-radius: 18px;
        }
        .actions a {
          color: var(--accent);
        }
      </style>
    </head>
    <body>
      <main>
        <h1>Upload ${manifest.batchId}</h1>
        <p class="actions">${manifest.images.length} image(s) from this upload only. JSON: <a href="/uploads/${manifest.batchId}/json">/uploads/${manifest.batchId}/json</a></p>
        ${imageCards ? `<section class="grid">${imageCards}</section>` : '<div class="empty">No images uploaded yet.</div>'}
      </main>
    </body>
  </html>`;
}

app.get("/", (req, res) => {
  res.json({
    service: "AssetLink",
    uploadEndpoint: "POST /upload",
    auth: "Authorization: Bearer <API_TOKEN>",
    uploadResult: "Each upload returns a batch-specific link at /uploads/:batchId"
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

        const objectKey = safeObjectName(originalName);
        const uploadTask = uploadObjectStream({
          objectName: objectKey,
          stream: fileStream,
          contentType: mimeType
        })
          .then(() => {
            uploaded.push({
              originalName,
              objectKey,
              url: buildAssetUrl(objectKey)
            });
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

app.get("/assets/:objectKey", async (req, res, next) => {
  try {
    const objectKey = req.params.objectKey;
    const meta = await statObject(objectKey);
    const stream = await getObjectStream(objectKey);

    res.setHeader("Content-Type", meta.metaData["content-type"] || mime.lookup(objectKey) || "application/octet-stream");
    stream.pipe(res);
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey") {
      return res.status(404).json({
        error: "Image not found"
      });
    }
    return next(error);
  }
});

app.get("/images", async (req, res, next) => {
  try {
    const objects = await listObjects();
    return res.json({
      total: objects.filter((item) => !item.name.startsWith("uploads/")).length,
      images: objects
        .filter((item) => !item.name.startsWith("uploads/"))
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
    const html = buildBatchHtml(manifest);
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
    app.listen(config.port, () => {
      console.log(`AssetLink listening on port ${config.port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
