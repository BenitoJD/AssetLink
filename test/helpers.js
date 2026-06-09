const http = require("http");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function withApp(app, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();

      try {
        await run(`http://127.0.0.1:${port}`);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
  });
}

async function readBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("application/json")) {
    return {
      contentType,
      text,
      json: JSON.parse(text)
    };
  }

  return { contentType, text, json: null };
}

function multipartUpload(baseUrl, token, fields) {
  const form = new FormData();

  for (const field of fields) {
    const blob = new Blob([field.buffer], { type: field.mimeType });
    form.append(field.name, blob, field.filename);
  }

  return fetch(`${baseUrl}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
}

function multipartVideoUpload(baseUrl, token, fields) {
  const form = new FormData();

  for (const field of fields) {
    const blob = new Blob([field.buffer], { type: field.mimeType });
    form.append(field.name, blob, field.filename);
  }

  return fetch(`${baseUrl}/upload-video`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
}

function multipartTextUpload(baseUrl, token, fields) {
  const form = new FormData();

  for (const field of fields) {
    const blob = new Blob([field.buffer], { type: field.mimeType });
    form.append(field.name, blob, field.filename);
  }

  return fetch(`${baseUrl}/upload-text`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });
}

module.exports = {
  PNG_1X1,
  withApp,
  readBody,
  multipartUpload,
  multipartVideoUpload,
  multipartTextUpload
};
