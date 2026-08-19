const express = require("express");
const Project = require("../models/Project");

const router = express.Router();
const PROJECT_ID = "vikrant-unit3";

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
router.put("/", async (req, res) => {
  try {
    const { state, updatedBy } = req.body || {};
    if (!state || typeof state !== "object") {
      return res.status(400).json({ error: "Body must include a 'state' object" });
    }
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
