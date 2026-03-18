
# AssetLink

Minimal image upload API backed by MinIO. Each upload request creates its own batch link, so if you upload 10 images in one POST, the returned link shows only those 10 images.

## What it does

- `POST /upload` uploads images to MinIO.
- Response includes direct image links and a batch-specific link.
- `GET /uploads/:batchId` shows only the images from that one upload in a full-size carousel.
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

### View one upload batch

```bash
curl http://localhost:3000/uploads/<batchId>/json
```

### Open one upload batch in the browser

Open this in the browser:

```text
http://localhost:3000/uploads/<batchId>
```

Use the left/right arrows, dots, or swipe gestures to move through the images one by one.

## Environment variables

See `.env.example`.

- `API_TOKEN`: bearer token for uploads.
- `PUBLIC_BASE_URL`: base URL used in returned links.
- `MINIO_*`: MinIO connection settings.
- `MINIO_BUCKET`: bucket name for stored images.

## Production usage

Current VPS deployment:

- API: `https://203.57.85.94:3010`
- MinIO API: `http://203.57.85.94:9100`
- MinIO console: `http://203.57.85.94:9101`
- API token: `1687ddfca57572213458f5500c8cab`
- HTTPS on the app port uses a self-signed certificate, so browsers will warn until you trust it.

Example production upload:

```bash
curl -k -X POST https://203.57.85.94:3010/upload \
  -H "Authorization: Bearer 1687ddfca5757221345" \
  -F "images=@/path/to/image-1.jpg" \
  -F "images=@/path/to/image-2.png"
```

Latest tested batch link:

```text
https://203.57.85.94:3010/uploads/f6329c17-e28b-4129-ad87-4de21b51f557
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
