
# AssetLink

Minimal image and text upload API backed by MinIO. Each upload request creates its own batch link, so if you upload 10 images or text files in one POST, the returned link shows only that batch.

## What it does

- `GET /` returns basic API information.
- `POST /upload` uploads images to MinIO.
- `POST /upload-text` uploads text-based files to MinIO.
- Response includes direct asset links and a batch-specific link.
- `GET /uploads/:batchId` shows images in a carousel or text files in a browser reader.
- `GET /uploads/:batchId/text/:assetIndex` returns paged text chunks for long-file viewing.
- `GET /uploads/:batchId/json` returns the same batch as JSON.
- Very basic auth using a single bearer token.
- Uploads stream directly to MinIO instead of buffering whole files in memory.

## Quick start

### 1. Start MinIO

```bash
docker compose up -d
```

MinIO API: `http://localhost:9100`

MinIO console: `http://localhost:9101`

Default login:

- user: `minioadmin`
- password: `minioadmin`

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

You can keep the defaults for local development.

### 4. Start the API

```bash
npm run dev
```

API base URL: `http://localhost:3000`

## API

### Upload images

Use multipart form data with field name `images`.

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
      "originalName": "image-1.jpg",
      "objectKey": "1710000000000-uuid.jpg",
      "url": "http://localhost:3000/assets/1710000000000-uuid.jpg"
    }
  ]
}
```

### Upload text files

Use multipart form data with field name `texts`.

Accepted files include text-like formats such as `.txt`, `.md`, `.csv`, `.json`, `.log`, `.xml`, `.yaml`, `.yml`, `.html`, `.js`, `.ts`, and `text/*` uploads.

```bash
curl -X POST http://localhost:3000/upload-text \
  -H "Authorization: Bearer super-secret-token" \
  -F "texts=@/path/to/notes.txt" \
  -F "texts=@/path/to/readme.md"
```

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

### View one upload batch

```bash
curl http://localhost:3000/uploads/<batchId>/json
```

### Open one upload batch in the browser

Open this in the browser:

```text
http://localhost:3000/uploads/<batchId>
```

Image batches use left/right arrows, dots, or swipe gestures. Text batches show a reader with file tabs. Long text files are loaded in chunks, so files larger than 2 MB can be viewed without embedding the entire file in the page.

### Load text chunks

The text viewer uses this endpoint automatically. You can also call it directly:

```bash
curl "http://localhost:3000/uploads/<batchId>/text/0?offset=0&limit=131072"
```

Response:

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

## Environment variables

See `.env.example`.

- `API_TOKEN`: bearer token for uploads.
- `PUBLIC_BASE_URL`: base URL used in returned links.
- `MINIO_*`: MinIO connection settings.
- `MINIO_BUCKET`: bucket name for stored assets.

## Production usage

Current VPS deployment:

- API: `https://203.57.85.94:3010`
- MinIO API: `http://203.57.85.94:9100`
- MinIO console: `http://203.57.85.94:9101`
- API token: use the value from `/opt/assetlink/.env` with `Authorization: Bearer ...`
- HTTPS on the app port uses a self-signed certificate on the same `3010` port, so browsers will warn until you trust it.
- Plain HTTP on `3010` is not served in the current VPS setup.

Example production upload:

```bash
curl -k -X POST https://203.57.85.94:3010/upload \
  -H "Authorization: Bearer <API_TOKEN>" \
  -F "images=@/path/to/image-1.jpg" \
  -F "images=@/path/to/image-2.png"
```

Latest tested batch link:

```text
https://203.57.85.94:3010/uploads/2617d273-ef10-414f-9de5-7bc10b660194
```

Remote management:

```bash
ssh -i ~/.ssh/id_rsa root@203.57.85.94
cd /opt/assetlink
docker compose --env-file .env -f docker-compose.prod.yml ps
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
docker compose --env-file .env -f docker-compose.prod.yml logs -f
```

## Notes

- This is intentionally minimal and does not include user accounts, signed URLs, or advanced security.
- Every upload gets a unique batch link, so repeated uploads stay separated.
