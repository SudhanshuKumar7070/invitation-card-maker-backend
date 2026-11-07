import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import sharp from "sharp";
import { createApp } from "./app.js";
import { generateTemplateWithGemini } from "./gemini-template-generator.js";

const generatedPng = await sharp({
  create: { width: 30, height: 45, channels: 3, background: "#f8f2e7" },
}).png().toBuffer();

function successResponse(image = generatedPng) {
  return {
    ok: true,
    json: async () => ({
      output_image: { data: image.toString("base64"), mime_type: "image/png" },
    }),
  };
}

test("requests a stateless portrait invitation from the lightweight Gemini image model", async () => {
  let request;
  const result = await generateTemplateWithGemini("Ivory and gold floral wedding card", {
    apiKey: "user-key",
    aspectRatio: "2:3",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return successResponse();
    },
  });

  assert.equal(request.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(request.headers["x-goog-api-key"], "user-key");
  const body = JSON.parse(request.body);
  assert.equal(body.model, "gemini-3.1-flash-lite-image");
  assert.equal(body.store, false);
  assert.match(body.input, /Ivory and gold floral wedding card/);
  assert.match(body.input, /lower-middle/);
  assert.match(body.input, /Do not render any words/);
  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(result.image, generatedPng);
});

test("rejects missing keys, excessive prompts, and unsupported card ratios", async () => {
  await assert.rejects(generateTemplateWithGemini("A card", { apiKey: "" }), {
    status: 400,
    message: "Enter a valid Gemini API key (up to 1024 characters) to create a template.",
  });
  await assert.rejects(generateTemplateWithGemini("x".repeat(1201), { apiKey: "user-key" }), { status: 400 });
  await assert.rejects(
    generateTemplateWithGemini("A card", { apiKey: "user-key", aspectRatio: "1:1" }),
    { status: 400 },
  );
});

test("returns actionable quota errors and rejects invalid model image output", async () => {
  await assert.rejects(
    generateTemplateWithGemini("A card", {
      apiKey: "user-key",
      fetchImpl: async () => ({ ok: false, status: 429 }),
    }),
    { status: 429, message: /quota or rate limit/ },
  );
  await assert.rejects(
    generateTemplateWithGemini("A card", {
      apiKey: "user-key",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ output_image: { data: Buffer.from("not an image").toString("base64"), mime_type: "image/png" } }),
      }),
    }),
    { status: 502, message: "Gemini returned an invalid image. Please try again." },
  );
});

test("extracts image data from a model-output step in an Interactions API response", async () => {
  const result = await generateTemplateWithGemini("A card", {
    apiKey: "user-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        steps: [{
          type: "model_output",
          content: [{ type: "image", data: generatedPng.toString("base64"), mime_type: "image/png" }],
        }],
      }),
    }),
  });

  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(result.image, generatedPng);
});

test("template endpoint returns generated image bytes without returning the user's key", async () => {
  let upstreamKey;
  const server = createApp({
    templateFetch: async (_url, options) => {
      upstreamKey = options.headers["x-goog-api-key"];
      return successResponse();
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/templates/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey: "user-key",
        aspectRatio: "2:3",
        prompt: "Minimal emerald and ivory floral design",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(upstreamKey, "user-key");
    assert.equal(body.mimeType, "image/png");
    assert.deepEqual(Buffer.from(body.image, "base64"), generatedPng);
    assert.equal(JSON.stringify(body).includes("user-key"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("template endpoint requires a user-provided key", async () => {
  const server = createApp({
    templateFetch: async () => { throw new Error("Gemini must not run without a key."); },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/templates/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "A floral card" }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /Enter a valid Gemini API key/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("unknown API routes return JSON rather than an HTML error page", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/templates/unknown`, {
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type").includes("application/json"), true);
    assert.match(body.error, /Restart the backend/);
  } finally {
    server.close();
    await once(server, "close");
  }
});
