import { getGeminiFallbackReason, readNamesWithGemini } from "./gemini-parser.js";
import { readHandwrittenNames } from "./handwriting-processor.js";

export async function readGuestListNames({
  buffer,
  getWorker,
  useGemini,
  apiKey,
  model,
  fetchImpl,
}) {
  if (useGemini && apiKey?.trim()) {
    try {
      const names = await readNamesWithGemini(buffer, { apiKey, model, fetchImpl });
      return { names, parser: "gemini", fallback: false, fallbackReason: undefined };
    } catch (error) {
      const fallbackReason = getGeminiFallbackReason(error);
      console.warn(
        "[scan] Gemini failed; falling back to local OCR.",
        error.networkCode || error.code || error.name || "request_failed",
        error.status ? `HTTP ${error.status}` : "",
      );
      const worker = await getWorker();
      const names = await readHandwrittenNames(worker, buffer);
      return { names, parser: "local", fallback: true, fallbackReason };
    }
  }

  if (useGemini) {
    const error = new Error("Enter your Gemini API key, or turn off Gemini to use local OCR.");
    error.status = 400;
    throw error;
  }

  const worker = await getWorker();
  const names = await readHandwrittenNames(worker, buffer);
  return { names, parser: "local", fallback: false, fallbackReason: undefined };
}
