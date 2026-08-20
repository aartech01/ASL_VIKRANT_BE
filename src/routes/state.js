const express = require("express");
const Project = require("../models/Project");
const { PROJECT_ID } = require("../constants");
const requireAdmin = require("../middleware/requireAdmin");

const router = express.Router();

// GET /api/state — fetch the shared dashboard state
router.get("/", async (req, res) => {
  try {
    const doc = await Project.findById(PROJECT_ID).lean();
    if (!doc) return res.json({ state: null, updatedAt: null });
    res.json({ state: doc.state, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error("GET /api/state failed:", err.message);
    res.status(500).json({ error: "Could not load shared state" });
  }
});

// PUT /api/state — overwrite the shared dashboard state
router.put("/", requireAdmin, async (req, res) => {
  try {
    const { state, updatedBy } = req.body || {};
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "Body must include a 'state' object" });
    }
    // Photos are added/removed only through /api/photos, which writes straight to
    // the database. If a stale browser tab's full-state push were allowed to carry
    // its own (possibly outdated) photos list, it could silently wipe out photos
    // another session just uploaded. So this route never lets the client overwrite
    // that field — it always keeps whatever is already stored.
    const existing = await Project.findById(PROJECT_ID).lean();
    state.photos = (existing && existing.state && existing.state.photos) || [];
    state.siteMap = (existing && existing.state && existing.state.siteMap) || null;
    const doc = await Project.findByIdAndUpdate(
      PROJECT_ID,
      { state, updatedBy: updatedBy || "" },
      { upsert: true, new: true }
    );
    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error("PUT /api/state failed:", err.message);
    res.status(500).json({ error: "Could not save shared state" });
  }
});

module.exports = router;
