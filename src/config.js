require("dotenv").config();

const parseBoolean = (value, fallback = false) => {
  if (value === undefined) {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
};

const required = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

module.exports = {
  port: Number(process.env.PORT || 3000),
  apiToken: required("API_TOKEN", "super-secret-token"),
  publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:3000"),
  minio: {
    endPoint: required("MINIO_END_POINT", "127.0.0.1"),
    port: Number(process.env.MINIO_PORT || 9000),
    useSSL: parseBoolean(process.env.MINIO_USE_SSL, false),
    accessKey: required("MINIO_ACCESS_KEY", "minioadmin"),
    secretKey: required("MINIO_SECRET_KEY", "minioadmin"),
    bucket: required("MINIO_BUCKET", "assetlink-images")
  }
};
