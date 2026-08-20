const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("../cloudinary");
const Project = require("../models/Project");
const { PROJECT_ID } = require("../constants");
const requireAdmin = require("../middleware/requireAdmin");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — kept at full resolution, unlike area photos
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are accepted"));
    }
    cb(null, true);
  },
});

function uploadBufferToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "vikrant-control-room/sitemap", resource_type: "image" },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// POST /api/sitemap  (multipart/form-data: map=<file>) — replaces the current site map
router.post("/", requireAdmin, upload.single("map"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'map')" });
    const result = await uploadBufferToCloudinary(req.file.buffer);
    const siteMap = {
      id: result.public_id,
      url: result.secure_url,
      width: result.width,
      height: result.height,
      name: req.file.originalname || "site-map.jpg",
      uploadedAt: new Date().toISOString(),
    };
    // Written straight to the database — same reasoning as /api/photos: this must
    // never be lost to a stale tab's full-state overwrite (see /api/state).
    await Project.findByIdAndUpdate(PROJECT_ID, { $set: { "state.siteMap": siteMap } }, { upsert: true });
    res.json(siteMap);
  } catch (err) {
    console.error("POST /api/sitemap failed:", err.message);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

// DELETE /api/sitemap — remove the current site map
router.delete("/", requireAdmin, async (req, res) => {
  try {
    const doc = await Project.findById(PROJECT_ID).lean();
    const current = doc && doc.state && doc.state.siteMap;
    if (current && current.id) {
      await cloudinary.uploader.destroy(current.id).catch(() => {});
    }
    await Project.findByIdAndUpdate(PROJECT_ID, { $unset: { "state.siteMap": "" } });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/sitemap failed:", err.message);
    res.status(500).json({ error: "Delete failed: " + err.message });
  }
});

module.exports = router;
