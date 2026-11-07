import express from "express";
import cors from "cors";
import multer from "multer";
import { createWorker } from "tesseract.js";
import { readGuestListNames } from "./guest-list-parser.js";
import { DEFAULT_TEMPLATE_MODEL, generateTemplateWithGemini } from "./gemini-template-generator.js";

const defaultFrontendOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

export function createApp({
  getWorker: suppliedWorker,
  geminiFetch = fetch,
  geminiModel = process.env.GEMINI_MODEL,
  templateFetch = geminiFetch,
  templateModel = DEFAULT_TEMPLATE_MODEL,
  frontendOrigins = (process.env.FRONTEND_ORIGINS || defaultFrontendOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
} = {}) {
  const app = express();
  app.use(cors({
    origin(origin, callback) {
      if (!origin || frontendOrigins.includes(origin)) {
        callback(null, origin || false);
        return;
      }
      callback(new Error("This website is not allowed to use the invitation API."));
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: 600,
  }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, fieldSize: 2048, fields: 2, files: 1, parts: 3 },
    fileFilter: (_req, file, callback) => {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
        callback(new Error("Please upload a PNG, JPG, or WebP image."));
        return;
      }
      callback(null, true);
    },
  });

  let workerPromise;
  const getLocalOcrWorker = () => {
    if (suppliedWorker) return suppliedWorker();
    workerPromise ??= createWorker("eng");
    return workerPromise;
  };

  app.post("/api/scan", upload.single("image"), async (req, res, next) => {
    if (!req.file) {
      res.status(400).json({ error: "Choose an image of your handwritten guest list first." });
      return;
    }

    try {
      const useGemini = req.body.useGemini === "true";
      const apiKey = req.body.geminiApiKey;
      if (useGemini && !apiKey?.trim()) {
        res.status(400).json({ error: "Enter your Gemini API key, or turn off Gemini to use local OCR." });
        return;
      }

      const { names, parser, fallback, fallbackReason } = await readGuestListNames({
        buffer: req.file.buffer,
        getWorker: getLocalOcrWorker,
        useGemini,
        apiKey,
        model: geminiModel,
        fetchImpl: geminiFetch,
      });

      res.json({
        names,
        parser,
        fallback,
        fallbackReason,
        message: names.length ? undefined : "No names were detected. Try a brighter, sharper photo with one name per line, or enter names manually.",
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/templates/generate", express.json({ limit: "4kb" }), async (req, res, next) => {
    try {
      const { prompt, apiKey, aspectRatio } = req.body || {};
      const { image, mimeType } = await generateTemplateWithGemini(prompt, {
        apiKey,
        aspectRatio,
        model: templateModel,
        fetchImpl: templateFetch,
      });
      res.json({ image: image.toString("base64"), mimeType });
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "API endpoint not found. Restart the backend to load the latest routes." });
  });

  app.use((error, _req, res, _next) => {
    const status = error instanceof multer.MulterError
      ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      : error.type === "entity.too.large" || error.type === "entity.parse.failed"
        ? 400
      : error.status || (error.message?.startsWith("Please upload") ? 400 : 500);
    res.status(status).json({
      error: status === 500 ? "We couldn't process this request. Please try again." : error.message,
    });
  });

  return app;
}
