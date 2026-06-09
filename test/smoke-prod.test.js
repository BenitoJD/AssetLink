const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const baseUrl = process.env.PRODUCTION_BASE_URL || "https://203.57.85.94:3010";
const runProdSmoke = process.env.RUN_PROD_SMOKE === "1";

function prodFetch(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
}

describe("production smoke", { skip: !runProdSmoke }, () => {
  it("GET / is healthy", async () => {
    const response = await prodFetch("/");
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.service, "AssetLink");
  });

  it("rejects unauthenticated uploads", async () => {
    const response = await prodFetch("/upload", { method: "POST" });
    const json = await response.json();

    assert.equal(response.status, 401);
    assert.equal(json.error, "Unauthorized");
  });

  it("returns 404 for unknown batch viewers", async () => {
    const response = await prodFetch("/uploads/00000000-0000-0000-0000-000000000000");
    const json = await response.json();

    assert.equal(response.status, 404);
    assert.equal(json.error, "Upload batch not found");
  });
});
