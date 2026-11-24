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
    // Written as one atomic $set of every other top-level field, rather than
    // read-then-overwrite: the old read/write gap let a photo pushed by
    // /api/photos or the Chat photo import in between be silently wiped.
    const set = { updatedBy: updatedBy || "" };
    Object.keys(state).forEach((k) => {
      // chatQuotes is owned by /api/chat-quotes, like photos by /api/photos
      if (k !== "photos" && k !== "siteMap" && k !== "chatQuotes" && !k.includes(".") && !k.startsWith("$")) set["state." + k] = state[k];
    });
    const doc = await Project.findByIdAndUpdate(PROJECT_ID, { $set: set }, { upsert: true, new: true });
    res.json({ ok: true, updatedAt: doc.updatedAt });
  } catch (err) {
    console.error("PUT /api/state failed:", err.message);
    res.status(500).json({ error: "Could not save shared state" });
  }
});

module.exports = router;
