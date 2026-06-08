# AssetLink

AssetLink is a minimal upload API backed by MinIO. It supports image uploads, video uploads, and text-file uploads. Every upload request creates a new batch link, so files uploaded together are viewed together and do not mix with older uploads.

Uploads are API-only. There is no frontend upload form. The browser UI is only for opening generated batch links.

## What It Does

- `GET /` returns basic API information.
- `POST /upload` uploads image files using multipart field `images`.
- `POST /upload-video` uploads video files using multipart field `videos`.
- `POST /upload-text` uploads text-based files using multipart field `texts`.
- `GET /uploads/:batchId` opens the public viewer for one upload batch.
- `GET /uploads/:batchId/json` returns the batch manifest as JSON.
- `GET /uploads/:batchId/text/:assetIndex` returns a chunk of one uploaded text file.
- `GET /assets/:objectKey` streams the stored raw file from MinIO.
- Uploads require `Authorization: Bearer <API_TOKEN>`.
- Generated batch links are public, random-link URLs. Anyone with the link can view the batch.

## Quick Start

### 1. Start MinIO

```bash
docker compose up -d
```

Local MinIO:

- API: `http://localhost:9100`
- Console: `http://localhost:9101`
- User: `minioadmin`
- Password: `minioadmin`

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

The example values are enough for local development.

### 4. Start The API

```bash
npm run dev
```

Local API base URL:

```text
http://localhost:3000
```

### 5. Check The Service

```bash
curl http://localhost:3000/
```

Expected response shape:

```json
{
  "service": "AssetLink",
  "uploadEndpoint": "POST /upload",
  "videoUploadEndpoint": "POST /upload-video",
  "textUploadEndpoint": "POST /upload-text",
  "textChunkEndpoint": "GET /uploads/:batchId/text/:assetIndex?offset=<bytes>&limit=<bytes>",
  "auth": "Authorization: Bearer <API_TOKEN>",
  "uploadResult": "Each upload returns a batch-specific link at /uploads/:batchId",
  "imageField": "images",
  "videoField": "videos",
  "textField": "texts"
}
```

## Upload Images

Use `POST /upload` with multipart form data. File fields can be named `images`, `videos`, or both in the same request.

```bash
curl -X POST http://localhost:3000/upload \
  -H "Authorization: Bearer super-secret-token" \
  -F "images=@/path/to/image-1.jpg" \
  -F "images=@/path/to/image-2.png"
```

Example response:

```json
{
  "message": "Images uploaded successfully",
  "batchId": "0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "batchUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "batchJsonUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83/json",
  "images": [
    {
      "type": "image",
      "originalName": "image-1.jpg",
      "objectKey": "1710000000000-uuid.jpg",
      "mimeType": "image/jpeg",
      "url": "http://localhost:3000/assets/1710000000000-uuid.jpg"
    }
  ]
}
```

Open the returned `batchUrl` in a browser:

```text
http://localhost:3000/uploads/<batchId>
```

Image batches render as a gallery/carousel. For multiple images, use arrows, dots, keyboard navigation, or swipe gestures.

## Upload Videos

Use `POST /upload-video` with multipart form data. The file field must be named `videos`.

```bash
curl -X POST http://localhost:3000/upload-video \
  -H "Authorization: Bearer super-secret-token" \
  -F "videos=@/path/to/clip-1.mp4" \
  -F "videos=@/path/to/clip-2.webm"
```

Example response:

```json
{
  "message": "Videos uploaded successfully",
  "batchId": "0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "batchUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "batchJsonUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83/json",
  "videos": [
    {
      "type": "video",
      "originalName": "clip-1.mp4",
      "objectKey": "1710000000000-uuid.mp4",
      "mimeType": "video/mp4",
      "url": "http://localhost:3000/assets/1710000000000-uuid.mp4"
    }
  ]
}
```

Open the returned `batchUrl` in a browser:

```text
http://localhost:3000/uploads/<batchId>
```

Video batches render as a carousel with native browser playback controls. The asset endpoint supports HTTP range requests so videos can seek and buffer efficiently.

## Upload Text Files

Use `POST /upload-text` with multipart form data. The file field must be named `texts`.

```bash
curl -X POST http://localhost:3000/upload-text \
  -H "Authorization: Bearer super-secret-token" \
  -F "texts=@/path/to/notes.txt" \
  -F "texts=@/path/to/report.md" \
  -F "texts=@/path/to/data.json"
```

Accepted text-like files include:

- `.txt`
- `.md`, `.markdown`
- `.csv`, `.tsv`
- `.json`, `.jsonl`
- `.log`
- `.xml`
- `.yaml`, `.yml`
- `.html`, `.htm`
- `.js`, `.ts`
- `.sql`
- `.env`, `.ini`, `.conf`, `.properties`
- `text/*` MIME uploads

Example response:

```json
{
  "message": "Text files uploaded successfully",
  "batchId": "0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "batchUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "batchJsonUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83/json",
  "texts": [
    {
      "type": "text",
      "originalName": "notes.txt",
      "objectKey": "1710000000000-uuid.txt",
      "mimeType": "text/plain",
      "url": "http://localhost:3000/assets/1710000000000-uuid.txt"
    }
  ]
}
```

Open the returned `batchUrl` in a browser:

```text
http://localhost:3000/uploads/<batchId>
```

Text batches render in a reader UI:

- One tab per uploaded text file.
- The raw file can be opened from `Raw`.
- `Copy loaded` copies the text that has been loaded into the browser so far.
- Reader modes are available for `Transcript`, `Document`, and `Raw` viewing.
- `Search loaded text` highlights matches in the content already loaded into the browser.
- `Auto-load` can fetch the next chunk when the reader is scrolled near the bottom.
- Uploaded HTML is displayed as escaped text, not executed as HTML.
- Prompt-style files are displayed like a transcript when lines begin with `System:`, `Prompt:`, `User:`, `Assistant:`, `Codex:`, or `Response:`.
- Lightweight readable formatting is supported inside the viewer: `**bold**`, `__bold__`, inline backtick code, and clickable `http://` or `https://` links.
- Empty text files are accepted and show an empty-state message in the viewer.
- Long files load in chunks so the browser does not need to render the full file at once.

## Long Text Files

The text viewer is designed for large files. It loads the first `128 KB` into the page, then the `Load more` button fetches the next chunk.

The viewer uses this endpoint automatically:

```text
GET /uploads/:batchId/text/:assetIndex?offset=<bytes>&limit=<bytes>
```

Example:

```bash
curl "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83/text/0?offset=0&limit=131072"
```

Example response:

```json
{
  "batchId": "0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "assetIndex": 0,
  "originalName": "notes.txt",
  "mimeType": "text/plain",
  "offset": 0,
  "nextOffset": 131072,
  "limit": 131072,
  "size": 10485760,
  "hasMore": true,
  "content": "..."
}
```

Chunk behavior:

- `offset` is byte-based.
- `nextOffset` is the offset to request next.
- `hasMore` tells the UI whether another chunk exists.
- Default viewer chunk size is `128 KB`.
- Maximum accepted chunk size is `1 MB`, even if a larger `limit` is requested.

## Batch JSON

Every upload response includes `batchJsonUrl`.

```bash
curl http://localhost:3000/uploads/<batchId>/json
```

Text batch response shape:

```json
{
  "batchId": "0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83",
  "createdAt": "2026-05-13T12:00:00.000Z",
  "assets": [
    {
      "type": "text",
      "originalName": "notes.txt",
      "objectKey": "1710000000000-uuid.txt",
      "mimeType": "text/plain",
      "url": "http://localhost:3000/assets/1710000000000-uuid.txt"
    }
  ],
  "texts": [
    {
      "type": "text",
      "originalName": "notes.txt",
      "objectKey": "1710000000000-uuid.txt",
      "mimeType": "text/plain",
      "url": "http://localhost:3000/assets/1710000000000-uuid.txt"
    }
  ],
  "images": [],
  "videos": [],
  "batchUrl": "http://localhost:3000/uploads/0d4f5d4f-8e2b-4f33-bfd9-1e4d364e9f83"
}
```

## Raw Assets

Raw files are available at:

```text
GET /assets/:objectKey
```

Example:

```bash
curl http://localhost:3000/assets/1710000000000-uuid.txt
```

The raw asset response includes `X-Content-Type-Options: nosniff` and `Accept-Ranges: bytes`. Video playback uses HTTP range requests (`206 Partial Content`) for seeking.

## Environment Variables

See `.env.example`.

- `PORT`: API server port.
- `API_TOKEN`: bearer token required for upload endpoints.
- `PUBLIC_BASE_URL`: base URL used when returning public links.
- `MINIO_END_POINT`: MinIO host.
- `MINIO_PORT`: MinIO API port.
- `MINIO_USE_SSL`: whether the MinIO connection uses SSL.
- `MINIO_ACCESS_KEY`: MinIO access key.
- `MINIO_SECRET_KEY`: MinIO secret key.
- `MINIO_BUCKET`: bucket name for stored assets.
- `HTTPS_KEY_FILE`: optional HTTPS key path.
- `HTTPS_CERT_FILE`: optional HTTPS cert path.

## Production Usage

Current VPS deployment:

- API: `https://203.57.85.94:3010`
- MinIO API: `http://203.57.85.94:9100`
- MinIO console: `http://203.57.85.94:9101`
- API token: use the value from `/opt/assetlink/.env`.
- HTTPS uses a self-signed certificate on port `3010`, so use `curl -k` or trust the certificate.
- Plain HTTP on `3010` is not served in the current VPS setup.

### Production Image Upload

```bash
curl -k -X POST https://203.57.85.94:3010/upload \
  -H "Authorization: Bearer <API_TOKEN>" \
  -F "images=@/path/to/image-1.jpg" \
  -F "images=@/path/to/image-2.png"
```

### Production Video Upload

```bash
curl -k -X POST https://203.57.85.94:3010/upload-video \
  -H "Authorization: Bearer <API_TOKEN>" \
  -F "videos=@/path/to/clip.mp4"
```

### Production Text Upload

```bash
curl -k -X POST https://203.57.85.94:3010/upload-text \
  -H "Authorization: Bearer <API_TOKEN>" \
  -F "texts=@/path/to/notes.txt" \
  -F "texts=@/path/to/large-log.txt"
```

Open the returned `batchUrl` in a browser. The browser may warn about the self-signed certificate.

### Production Text Chunk

```bash
curl -k "https://203.57.85.94:3010/uploads/<batchId>/text/0?offset=0&limit=131072"
```

## Remote Management

```bash
ssh -i ~/.ssh/id_rsa root@203.57.85.94
cd /opt/assetlink
docker compose --env-file .env -f docker-compose.prod.yml ps
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
docker compose --env-file .env -f docker-compose.prod.yml logs -f
```

## Notes

- This service intentionally does not include user accounts, signed URLs, or per-link permissions.
- Every upload gets a unique batch link.
- Upload endpoints require the bearer token.
- Viewer links are public to anyone who has the URL.
- Text files are stored as raw text and escaped in the viewer.
- For very large text files, use the browser `Load more` control or the chunk endpoint.
