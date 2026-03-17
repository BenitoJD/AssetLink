const { Client } = require("minio");
const mime = require("mime-types");

const config = require("./config");

const client = new Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey
});

const bucketName = config.minio.bucket;

const publicReadPolicy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: {
        AWS: ["*"]
      },
      Action: ["s3:GetBucketLocation", "s3:ListBucket"],
      Resource: [`arn:aws:s3:::${bucketName}`]
    },
    {
      Effect: "Allow",
      Principal: {
        AWS: ["*"]
      },
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${bucketName}/*`]
    }
  ]
};

async function ensureBucket() {
  const exists = await client.bucketExists(bucketName);

  if (!exists) {
    await client.makeBucket(bucketName);
  }

  await client.setBucketPolicy(bucketName, JSON.stringify(publicReadPolicy));
}

async function uploadObject({ objectName, buffer, contentType }) {
  await client.putObject(bucketName, objectName, buffer, buffer.length, {
    "Content-Type": contentType || mime.lookup(objectName) || "application/octet-stream"
  });
}

async function uploadObjectStream({ objectName, stream, contentType }) {
  await client.putObject(bucketName, objectName, stream, {
    "Content-Type": contentType || mime.lookup(objectName) || "application/octet-stream"
  });
}

function getObjectStream(objectName) {
  return client.getObject(bucketName, objectName);
}

async function getObjectBuffer(objectName) {
  const stream = await client.getObject(bucketName, objectName);
  const chunks = [];

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function listObjects() {
  const objects = [];

  await new Promise((resolve, reject) => {
    const stream = client.listObjectsV2(bucketName, "", true);

    stream.on("data", (item) => {
      if (item.name) {
        objects.push(item);
      }
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
}

async function statObject(objectName) {
  return client.statObject(bucketName, objectName);
}

module.exports = {
  bucketName,
  ensureBucket,
  getObjectBuffer,
  getObjectStream,
  listObjects,
  statObject,
  uploadObject,
  uploadObjectStream
};
