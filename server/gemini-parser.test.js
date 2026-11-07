import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import sharp from "sharp";
import { createApp } from "./app.js";
import { getGeminiFallbackReason, readNamesWithGemini } from "./gemini-parser.js";
import { readGuestListNames } from "./guest-list-parser.js";

const guestListImage = await sharp(Buffer.from(
  '<svg width="600" height="180"><rect width="100%" height="100%" fill="white"/><text x="20" y="70" font-size="32">1. Alice Green</text><text x="20" y="130" font-size="32">2. Bob Jones</text></svg>',
)).png().toBuffer();

function successResponse(names) {
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ names }) }] } }],
    }),
  };
}

test("sends one compressed image and validates Gemini guest-name output", async () => {
  let request;
  const names = await readNamesWithGemini(guestListImage, {
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, ...options };
      return successResponse(["1. Alice Green", "Bob Jones", "alice green", "Guest List"]);
    },
  });

  assert.deepEqual(names, ["Alice Green", "Bob Jones"]);
  assert.match(request.url, /gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(request.headers["x-goog-api-key"], "test-key");
  assert.equal(request.signal.aborted, false);

  const body = JSON.parse(request.body);
  assert.equal(body.generationConfig.maxOutputTokens, 512);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.contents[0].parts.length, 2);
  const imagePart = body.contents[0].parts[1].inlineData;
  assert.equal(imagePart.mimeType, "image/jpeg");
  const image = await sharp(Buffer.from(imagePart.data, "base64")).metadata();
  assert.equal(image.format, "jpeg");
  assert.ok(image.width <= 1800 && image.height <= 1800);
});

test("rejects malformed or empty Gemini output so the caller can fall back", async () => {
  await assert.rejects(
    readNamesWithGemini(guestListImage, {
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"names":[]}' }] } }] }),
      }),
    }),
    { code: "no_names" },
  );
});

test("uses local OCR when Gemini fails and makes no second Gemini request", async () => {
  let geminiRequests = 0;
  let localRecognitions = 0;
  let localWorkerInitializations = 0;
  const result = await readGuestListNames({
    buffer: guestListImage,
    getWorker: async () => {
      localWorkerInitializations += 1;
      return {
        recognize: async () => {
          localRecognitions += 1;
          return { data: { text: "1. Alice Green\n2. Bob Jones", confidence: 90 } };
        },
      };
    },
    useGemini: true,
    apiKey: "test-key",
    fetchImpl: async () => {
      geminiRequests += 1;
      return { ok: false, status: 429 };
    },
  });

  assert.deepEqual(result, {
    names: ["Alice Green", "Bob Jones"],
    parser: "local",
    fallback: true,
    fallbackReason: "Gemini's quota or rate limit was reached. Check the key's quota and billing settings.",
  });
  assert.equal(geminiRequests, 1);
  assert.equal(localRecognitions, 6);
  assert.equal(localWorkerInitializations, 1);
});

test("does not call Gemini when the local-only option is selected", async () => {
  const result = await readGuestListNames({
    buffer: guestListImage,
    getWorker: async () => ({
      recognize: async () => ({
        data: { text: "Alice Green\nBob Jones", confidence: 90 },
      }),
    }),
    useGemini: false,
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("Gemini must not be called for local-only scans");
    },
  });

  assert.equal(result.parser, "local");
  assert.equal(result.fallback, false);
  assert.deepEqual(result.names, ["Alice Green", "Bob Jones"]);
});

test("does not initialize local OCR when Gemini successfully reads the image", async () => {
  let workerInitializations = 0;
  const result = await readGuestListNames({
    buffer: guestListImage,
    getWorker: async () => {
      workerInitializations += 1;
      throw new Error("Local OCR should not be initialized for a successful Gemini scan");
    },
    useGemini: true,
    apiKey: "test-key",
    fetchImpl: async () => successResponse(["Alice Green", "Bob Jones"]),
  });

  assert.deepEqual(result, {
    names: ["Alice Green", "Bob Jones"],
    parser: "gemini",
    fallback: false,
    fallbackReason: undefined,
  });
  assert.equal(workerInitializations, 0);
});

test("maps Gemini errors to actionable fallback reasons without exposing raw errors", () => {
  assert.match(getGeminiFallbackReason({ status: 403 }), /key/);
  assert.match(getGeminiFallbackReason({ status: 429 }), /quota/);
  assert.match(getGeminiFallbackReason({ code: "http_400" }), /API key/);
  assert.match(getGeminiFallbackReason({ status: 400, apiMessage: "API key not valid. Please pass a valid API key." }), /Google rejected this API key/);
  assert.match(getGeminiFallbackReason({ code: "network_error", networkCode: "ENOTFOUND" }), /DNS/);
  assert.match(getGeminiFallbackReason({ code: "network_error", networkCode: "ECONNRESET" }), /outbound HTTPS/);
  assert.match(getGeminiFallbackReason({ code: "network_error", networkCode: "CERT_AUTHORITY_INVALID" }), /certificate/);
  assert.equal(
    getGeminiFallbackReason({ message: "private details" }),
    "Could not connect to Gemini.",
  );
});

test("classifies rejected network connections without exposing underlying error details", async () => {
  await assert.rejects(
    readNamesWithGemini(guestListImage, {
      apiKey: "test-key",
      fetchImpl: async () => {
        const cause = new Error("private network configuration");
        cause.code = "ECONNRESET";
        const error = new TypeError("fetch failed", { cause });
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.equal(error.networkCode, "ECONNRESET");
      assert.equal(error.name, "TypeError");
      assert.doesNotMatch(error.message, /private network configuration|test-key/);
      return true;
    },
  );
});

test("requires a user-supplied key when Gemini is selected", async () => {
  await assert.rejects(
    readGuestListNames({
      buffer: guestListImage,
      getWorker: async () => { throw new Error("Local OCR should not run when key is missing"); },
      useGemini: true,
      apiKey: "",
      fetchImpl: async () => {
        throw new Error("Gemini must not be called without a user key");
      },
    }),
    { status: 400, message: "Enter your Gemini API key, or turn off Gemini to use local OCR." },
  );
});

test("scan endpoint forwards the user's key to Gemini and keeps OCR lazy", async () => {
  let upstreamKey;
  let workerInitializations = 0;
  const server = createApp({
    getWorker: async () => {
      workerInitializations += 1;
      throw new Error("Local OCR should not run when Gemini succeeds");
    },
    geminiFetch: async (_url, options) => {
      upstreamKey = options.headers["x-goog-api-key"];
      return successResponse(["Alice Green", "Bob Jones"]);
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const form = new FormData();
    form.append("image", new Blob([guestListImage], { type: "image/png" }), "guest-list.png");
    form.append("useGemini", "true");
    form.append("geminiApiKey", "user-owned-test-key");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scan`, {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.names, ["Alice Green", "Bob Jones"]);
    assert.equal(body.parser, "gemini");
    assert.equal(upstreamKey, "user-owned-test-key");
    assert.equal(JSON.stringify(body).includes("user-owned-test-key"), false);
    assert.equal(workerInitializations, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("scan endpoint requires a user key without initializing OCR", async () => {
  let workerInitializations = 0;
  const server = createApp({
    getWorker: async () => {
      workerInitializations += 1;
      throw new Error("Local OCR should not run when a Gemini key is missing");
    },
    geminiFetch: async () => {
      throw new Error("Gemini must not run when the user has not supplied a key");
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const form = new FormData();
    form.append("image", new Blob([guestListImage], { type: "image/png" }), "guest-list.png");
    form.append("useGemini", "true");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scan`, {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /Enter your Gemini API key/);
    assert.equal(workerInitializations, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});
