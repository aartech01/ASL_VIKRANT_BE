const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("../cloudinary");
const Project = require("../models/Project");
const { PROJECT_ID } = require("../constants");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per photo
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are accepted"));
    }
    cb(null, true);
  },
});

function uploadBufferToCloudinary(buffer, area) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vikrant-control-room",
        tags: area ? [String(area).replace(/[^a-z0-9]+/gi, "_")] : undefined,
        resource_type: "image",
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// POST /api/photos  (multipart/form-data: photo=<file>, area=<string>)
router.post("/", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'photo')" });
    const area = req.body.area || "";
    const result = await uploadBufferToCloudinary(req.file.buffer, area);
    const photo = { id: result.public_id, name: req.file.originalname || "photo.jpg", area, url: result.secure_url };
    // Recorded straight to the database so the photo can never be lost to a
    // racing full-state save from another tab (see /api/state for why).
    await Project.findByIdAndUpdate(PROJECT_ID, { $push: { "state.photos": photo } }, { upsert: true });
    res.json({
      id: result.public_id,
      url: result.secure_url,
      width: result.width,
      height: result.height,
      area,
    });
  } catch (err) {
    console.error("POST /api/photos failed:", err.message);
    res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

// DELETE /api/photos/:publicId(*) — remove a photo from Cloudinary
router.delete("/*", async (req, res) => {
  try {
    const publicId = req.params[0];
    if (!publicId) return res.status(400).json({ error: "Missing photo id" });
    await cloudinary.uploader.destroy(publicId);
    await Project.findByIdAndUpdate(PROJECT_ID, { $pull: { "state.photos": { id: publicId } } });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/photos failed:", err.message);
    res.status(500).json({ error: "Delete failed: " + err.message });
  }
});

module.exports = router;
