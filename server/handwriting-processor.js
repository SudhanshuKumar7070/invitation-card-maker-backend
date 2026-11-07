import sharp from "sharp";

const MAX_IMAGE_PIXELS = 40_000_000;

export async function prepareGuestListImage(buffer) {
  const image = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS });
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
    const error = new Error("This image is too large to process. Please use an image with fewer than 40 megapixels.");
    error.status = 400;
    throw error;
  }

  const normalized = image
    .rotate()
    .resize({ width: 2400, height: 4000, fit: "inside", withoutEnlargement: false })
    .flatten({ background: "#ffffff" })
    .greyscale()
    .normalize()
    .sharpen();

  const clear = await normalized.clone().png().toBuffer();
  const highContrast = await normalized.clone().threshold(168).png().toBuffer();
  return [clear, highContrast];
}

function parseLine(text) {
  return text
    .replace(/^\s*(?:(?:\d{1,3}|[A-Za-z])[.)\]:-]\s*|[-*•▪◦]\s*)+/, "")
    .replace(/^[|:;,]+\s*/, "")
    .replace(/[|~]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:]+$/, "")
    .trim();
}

export function normalizeGuestNames(rawNames) {
  const seen = new Set();
  return rawNames.flatMap((rawName) => {
    if (typeof rawName !== "string") return [];
    const name = parseLine(rawName);
    const key = name.toLocaleLowerCase();
    const letterCount = (name.match(/\p{L}/gu) || []).length;
    if (
      letterCount < 2 ||
      name.length > 80 ||
      /^(?:guest\s*list|invitees|names?)\b/i.test(name) ||
      seen.has(key)
    ) return [];
    seen.add(key);
    return [name];
  }).slice(0, 200);
}

function cleanOcrLines(data) {
  const sourceLines = data.lines?.length
    ? data.lines.map((line) => ({ text: line.text, confidence: line.confidence }))
    : data.text.split(/\r?\n/).map((text) => ({ text, confidence: data.confidence }));

  const confidenceByName = new Map(
    sourceLines.map(({ text, confidence }) => [
      normalizeGuestNames([text])[0]?.toLocaleLowerCase(),
      Number.isFinite(confidence) ? confidence : data.confidence,
    ]),
  );
  return normalizeGuestNames(sourceLines.map(({ text }) => text)).map((name) => ({
    name,
    confidence: confidenceByName.get(name.toLocaleLowerCase()),
  }));
}

export async function readHandwrittenNames(worker, buffer) {
  const images = await prepareGuestListImage(buffer);
  const pageModes = ["6", "11", "4"];
  let bestResult = { names: [], score: -1 };

  for (const image of images) {
    for (const pageMode of pageModes) {
      const { data } = await worker.recognize(image, {
        tessedit_pageseg_mode: pageMode,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });
      const lines = cleanOcrLines(data);
      if (!lines.length) continue;

      const meanConfidence = lines.reduce((total, line) => total + line.confidence, 0) / lines.length;
      const score = meanConfidence + Math.min(lines.length, 20) * 2;
      if (score > bestResult.score) {
        bestResult = { names: lines.map((line) => line.name), score };
      }
    }
  }

  return bestResult.names;
}
