const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("../cloudinary");
const requireAdmin = require("../middleware/requireAdmin");

const router = express.Router();

// Vendor quotations are commercial documents, not survey photos — kept admin-gated (unlike
// /api/photos) since there's been no request to open this one up to every visitor.
const ALLOWED = /^(application\/pdf|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/csv|image\/)/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per quotation file
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.test(file.mimetype)) {
      return cb(new Error("Only PDF, Excel/CSV, or image files are accepted"));
    }
    cb(null, true);
  },
});

function uploadBufferToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vikrant-control-room/quotes",
        resource_type: "auto", // Cloudinary picks image vs. raw based on the file itself
        use_filename: true,
        filename_override: filename,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// POST /api/quotes  (multipart/form-data: file=<file>) — returns the Cloudinary id/url to store
// alongside the quote's metadata, which lives in the general project state (see /api/state).
router.post("/", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')" });
    const result = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname);
    res.json({ id: result.public_id, url: result.secure_url, resourceType: result.resource_type });
  } catch (err) {
    console.error("POST /api/quotes failed:", err.message);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

// DELETE /api/quotes/:publicId(*) — remove a quotation file from Cloudinary.
router.delete("/*", requireAdmin, async (req, res) => {
  try {
    const publicId = req.params[0];
    if (!publicId) return res.status(400).json({ error: "Missing file id" });
    await cloudinary.uploader.destroy(publicId, { resource_type: "raw" }).catch(() => {});
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/quotes failed:", err.message);
    res.status(500).json({ error: "Delete failed: " + err.message });
  }
});

module.exports = router;
