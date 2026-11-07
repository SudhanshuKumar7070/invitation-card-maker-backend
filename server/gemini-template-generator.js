import sharp from "sharp";

export const DEFAULT_TEMPLATE_MODEL = "gemini-3.1-flash-lite-image";
const allowedAspectRatios = new Set(["2:3", "3:4"]);
const maximumImageBytes = 5 * 1024 * 1024;

function findImageOutput(value) {
  if (!value || typeof value !== "object") return null;
  const mimeType = value.mime_type || value.mimeType;
  if (
    typeof value.data === "string" &&
    ["image/png", "image/jpeg", "image/webp"].includes(mimeType)
  ) {
    return { data: value.data, mimeType };
  }
  for (const nestedValue of Object.values(value)) {
    const image = findImageOutput(nestedValue);
    if (image) return image;
  }
  return null;
}

export async function generateTemplateWithGemini(
  prompt,
  {
    apiKey,
    aspectRatio = "2:3",
    model = DEFAULT_TEMPLATE_MODEL,
    fetchImpl = fetch,
  } = {},
) {
  const trimmedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmedApiKey || trimmedApiKey.length > 1024) {
    const error = new Error("Enter a valid Gemini API key (up to 1024 characters) to create a template.");
    error.status = 400;
    throw error;
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 1200) {
    const error = new Error("Describe your invitation in 1 to 1200 characters.");
    error.status = 400;
    throw error;
  }
  if (!allowedAspectRatios.has(aspectRatio)) {
    const error = new Error("Choose a supported portrait card ratio.");
    error.status = 400;
    throw error;
  }

  const designPrompt = [
    "Create a single, beautiful, print-ready invitation card background as a flat, straight-on image.",
    `Portrait aspect ratio ${aspectRatio}.`,
    `The user's design request is: ${prompt.trim()}`,
    "Leave a clear, uncluttered area in the lower-middle of the card for a guest name to be added later.",
    "Do not render any words, letters, numbers, dates, names, logos, borders outside the canvas, mockups, hands, or perspective views. Use elegant, balanced, print-friendly artwork and keep decorative details inside the edges.",
  ].join("\n");

  let response;
  try {
    response = await fetchImpl("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": trimmedApiKey,
      },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model,
        input: designPrompt,
        store: false,
      }),
    });
  } catch (cause) {
    if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
      const error = new Error("Gemini took too long to create the design. Please try again.");
      error.status = 504;
      throw error;
    }
    const error = new Error("Could not reach Gemini. Check your internet connection and try again.");
    error.status = 502;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      response.status === 401 || response.status === 403
        ? "Google rejected this API key or the key does not have access to image generation."
        : response.status === 429
          ? "Gemini's quota or rate limit was reached. Check your AI Studio account and try again later."
          : response.status === 404
            ? "The Gemini image model is not available for this API key."
            : "Gemini couldn't create this design. Check your API key and try again.",
    );
    error.status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error("Gemini returned an unreadable response. Please try again.");
    error.status = 502;
    throw error;
  }

  const generatedImage = findImageOutput(result.output_image || result.outputImage || result);
  if (!generatedImage) {
    const error = new Error("Gemini did not return an invitation image. Try a simpler design description.");
    error.status = 502;
    throw error;
  }

  const { mimeType } = generatedImage;
  const image = Buffer.from(generatedImage.data, "base64");
  if (!image.length || image.length > maximumImageBytes) {
    const error = new Error("Gemini returned an image that is empty or too large. Please try again.");
    error.status = 502;
    throw error;
  }

  try {
    const metadata = await sharp(image, { limitInputPixels: 40_000_000 }).metadata();
    const expectedFormat = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[mimeType];
    if (metadata.format !== expectedFormat) throw new Error("Image format mismatch.");
  } catch {
    const error = new Error("Gemini returned an invalid image. Please try again.");
    error.status = 502;
    throw error;
  }

  return { image, mimeType };
}
