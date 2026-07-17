const express = require("express");
const path = require("path");
const multer = require("multer");
const { parseProductFile } = require("../services/parsers/csvParser");
const { attachUploadedImages } = require("../services/imageMatcher");
const { analyzeCatalog } = require("../services/catalogAnalyzer");

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) =>
    cb(null, path.join(__dirname, "..", "..", "uploads")),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 30 },
});

router.post(
  "/",
  upload.fields([
    { name: "productFile", maxCount: 1 },
    { name: "images", maxCount: 2000 },
  ]),
  async (req, res) => {
    try {
      const file = req.files?.productFile?.[0];
      const images = req.files?.images || [];

      if (!file) {
        return res
          .status(400)
          .json({ ok: false, message: "Sube un CSV o Excel." });
      }

      const parsed = parseProductFile(file.path);
      parsed.products = attachUploadedImages(parsed.products, images);
      const analysis = analyzeCatalog(parsed);

      analysis.inventoryOnly = parsed.inventoryOnly;

      // Un solo res.json con su return por buena práctica
      return res.json({
        ok: true,
        analysis,
      });
      
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, message: error.message });
    }
  },
);

module.exports = router;
