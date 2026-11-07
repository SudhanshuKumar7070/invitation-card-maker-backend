import sharp from "sharp";
import { normalizeGuestNames } from "./handwriting-processor.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export function getGeminiFallbackReason(error) {
  const status = error?.status;
  if (status === 400) {
    if (
      error?.apiStatus === "API_KEY_INVALID" ||
      /api key.{0,30}(?:not valid|invalid)|invalid api key/i.test(error?.apiMessage || "")
    ) {
      return "Google rejected this API key. Create or copy a valid key from Google AI Studio.";
    }
    return "Gemini rejected the image or request. Check the image format and try again.";
  }
  if (status === 401) {
    return "Google rejected this API key. Create or copy a valid key from Google AI Studio.";
  }
  if (status === 403) {
    return "Google denied this key. Check that the Gemini API is enabled for its project and that the key has no incompatible restrictions.";
  }
  if (status === 404) {
    return "The selected Gemini model is unavailable for this API key.";
  }
  if (status === 429) {
    return "Gemini's quota or rate limit was reached. Check the key's quota and billing settings.";
  }
  if (status >= 500) {
    return "Gemini is temporarily unavailable.";
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return "Gemini took too long to respond.";
  }
  if (error?.code === "invalid_model") {
    return "The configured Gemini model name is invalid.";
  }
  if (["empty_response", "invalid_json", "invalid_names", "no_names"].includes(error?.code)) {
    return "Gemini could not return a readable guest list from this image.";
  }
  if (error?.code === "blocked") {
    return "Gemini did not accept this image. Try another image or use local OCR.";
  }
  if (error?.code === "truncated_response") {
    return "Gemini's response was incomplete. Try a shorter guest list.";
  }
  if (error?.code === "invalid_response") {
    return "Gemini returned an unreadable response.";
  }
  if (error?.code === "image_processing") {
    return "The uploaded image could not be prepared for Gemini. Try another PNG, JPG, or WebP image.";
  }
  if (error?.code === "network_error") {
    if (["ENOTFOUND", "EAI_AGAIN"].includes(error.networkCode)) {
      return "This server could not resolve Google's API address. Check its DNS and internet connection.";
    }
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.networkCode)) {
      return "This server could not reach Google's API. Check its outbound HTTPS access, firewall, or proxy settings.";
    }
    if (["CERT_HAS_EXPIRED", "CERT_AUTHORITY_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(error.networkCode)) {
      return "This server could not verify Google's HTTPS certificate. Check its system clock and certificate/proxy configuration.";
    }
    return "This server could not reach Google's API. Check its internet connection and outbound HTTPS access.";
  }
  if (error?.code?.startsWith("http_")) {
    return "Gemini could not process this request. Check your API key and try again.";
  }
  return "Could not connect to Gemini.";
}

export async function readNamesWithGemini(
  buffer,
  {
    apiKey,
    model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    fetchImpl = fetch,
  } = {},
) {
  if (!apiKey?.trim()) {
    const error = new Error("Gemini API key is not configured.");
    error.code = "not_configured";
    throw error;
  }
  const trimmedApiKey = apiKey.trim();
  if (!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) {
    const error = new Error("Gemini model name is invalid.");
    error.code = "invalid_model";
    throw error;
  }

  let image;
  try {
    image = await sharp(buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
  } catch {
    const error = new Error("The uploaded image could not be prepared for Gemini.");
    error.code = "image_processing";
    throw error;
  }

  let response;
  try {
    response = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": trimmedApiKey,
        },
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: "Read this image of a handwritten guest list. Return only the names that are actually written, in their original order. Remove list numbers and bullets. Do not include headings, dates, notes, or other text. Do not guess or invent names; skip anything you cannot read. Return an empty names array if there are no readable names.",
              },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: image.toString("base64"),
                },
              },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 512,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                names: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
              },
              required: ["names"],
            },
          },
        }),
      },
    );
  } catch (cause) {
    if (cause?.name === "TimeoutError" || cause?.name === "AbortError") throw cause;
    const error = new Error("Could not reach the Gemini API.");
    error.code = "network_error";
    error.networkCode = cause?.cause?.code || cause?.code;
    error.name = cause?.name === "TypeError" ? "TypeError" : "GeminiNetworkError";
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Gemini request failed with status ${response.status}.`);
    error.code = `http_${response.status}`;
    error.status = response.status;
    try {
      const body = await response.json();
      error.apiStatus = body.error?.status;
      error.apiMessage = body.error?.message;
    } catch {
      error.apiStatus = undefined;
      error.apiMessage = undefined;
    }
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error("Gemini returned an unreadable response.");
    error.code = "invalid_response";
    throw error;
  }
  if (result.promptFeedback?.blockReason) {
    const error = new Error("Gemini blocked the guest-list image.");
    error.code = "blocked";
    throw error;
  }
  const output = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!output) {
    const error = new Error("Gemini returned no names.");
    error.code = result.candidates?.[0]?.finishReason === "MAX_TOKENS" ? "truncated_response" : "empty_response";
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    const error = new Error("Gemini returned invalid JSON.");
    error.code = "invalid_json";
    throw error;
  }

  if (!Array.isArray(parsed.names)) {
    const error = new Error("Gemini response did not contain a names array.");
    error.code = "invalid_names";
    throw error;
  }

  const names = normalizeGuestNames(parsed.names);
  if (!names.length) {
    const error = new Error("Gemini did not detect any readable names.");
    error.code = "no_names";
    throw error;
  }
  return names;
}
