const express = require("express");
const streamifier = require("streamifier");
const { google } = require("googleapis");
const cloudinary = require("../cloudinary");
const Project = require("../models/Project");
const ChatSync = require("../models/ChatSync");
const { PROJECT_ID } = require("../constants");
const { SYNC_ID, authedClient } = require("../services/googleAuth");
const requireAdmin = require("../middleware/requireAdmin");

/*
 * Vendor quotations posted in the site's Google Chat room → the Vendor quotes tab.
 *
 * Only quote-related messages are picked up: the message text or an attached
 * file name has to read like a quotation (quote / quotation / offer / proforma /
 * PI / estimate / price list / rate list / tender / bid). Their files (PDF,
 * Excel/CSV, images) are copied to Cloudinary once.
 *
 * Each becomes one record in state.chatQuotes — an inbox the team reviews on
 * the dashboard ("Add to comparison" or "Dismiss"), because a chat message
 * rarely carries the clean rate + item the comparison table needs.
 *
 * No duplicates: one record per Chat message (its resource name is the id),
 * pushed atomically only if absent; files get a public_id derived from the
 * attachment with overwrite:false. state.chatQuotes is written only by this
 * route (PUT /api/state never touches it), so a browser save can't wipe it.
 */
const router = express.Router();

const DEFAULT_SPACE = process.env.CHAT_PHOTO_SPACE || "spaces/AAQAdEiPJJU";
const MAX_FILES_PER_CALL = 10;
const OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;
const QUOTE_RE = /(quot(e|es|ed|ation|ations)?\b|\bqtn\b|\boffer\b|proforma|pro-forma|\bestimate\b|price\s*list|rate\s*list|\btender\b|\bbid\b)/i;
const PI_RE = /\bPI\b/; // case-sensitive: "PI" = proforma invoice
const FILE_RE = /^(application\/pdf|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/csv|image\/)/i;
let running = false;

const isQuoteText = (s) => QUOTE_RE.test(s || "") || PI_RE.test(s || "");
const fileId = (key) => "q_" + String(key).replace(/^spaces\//, "").replace(/[^A-Za-z0-9_-]+/g, "_");

// "Emkay India offer.pdf" → "Emkay India"; "quotation from Akshat Enterprises" → "Akshat Enterprises"
function guessVendor(text, fileNames) {
  const t = String(text || "");
  let m = t.match(/(?:from|by|of)\s+(?:m\/s\.?\s*)?([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,3})/);
  if (m) return m[1].trim();
  m = t.match(/(?:m\/s\.?\s*)([A-Za-z][\w&.\-]*(?:\s+[A-Za-z][\w&.\-]*){0,3})/i);
  if (m) return m[1].trim();
  for (const f of fileNames) {
    const base = String(f).replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ");
    m = base.match(/^(.*?)\s*[-–(]?\s*(quot|qtn|offer|proforma|estimate|pi\b)/i);
    if (m && m[1] && /[a-z]/i.test(m[1]) && m[1].length <= 40) return m[1].replace(/[-–(]+$/, "").trim();
  }
  m = t.match(/([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,3})\s+(?:quot|offer|proforma|estimate)/);
  return m ? m[1].trim() : "";
}

// "Rs 65K", "₹27,000", "INR 1.2 lakh" → number (first amount mentioned)
function extractAmount(text) {
  const m = String(text || "").match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(k|lakh|lac|l)?\b/i)
    || String(text || "").match(/\b([\d,]+(?:\.\d+)?)\s*(k|lakh|lac)\b/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ""));
  const u = (m[2] || "").toLowerCase();
  if (u === "k") n *= 1e3; else if (u) n *= 1e5;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function upload(buffer, publicId, name) {
  return new Promise((resolve, reject) => {
    const s = cloudinary.uploader.upload_stream(
      { folder: "vikrant-control-room/quotes/chat", public_id: publicId, overwrite: false,
        resource_type: "auto", filename_override: name, tags: ["google_chat_quote"] },
      (err, r) => (err ? reject(err) : resolve(r))
    );
    streamifier.createReadStream(buffer).pipe(s);
  });
}

async function download(chat, drive, att) {
  if (att.attachmentDataRef && att.attachmentDataRef.resourceName) {
    const r = await chat.media.download({ resourceName: att.attachmentDataRef.resourceName, alt: "media" }, { responseType: "arraybuffer" });
    return Buffer.from(r.data);
  }
  if (att.driveDataRef && att.driveDataRef.driveFileId) {
    const r = await drive.files.get({ fileId: att.driveDataRef.driveFileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return Buffer.from(r.data);
  }
  throw new Error("attachment has no downloadable data");
}

// POST /api/chat-quotes/sync — import the next batch of new quote messages.
// Open like the photo sync: it only copies the team's own chat, and is idempotent.
router.post("/sync", async (req, res) => {
  if (running) return res.status(409).json({ error: "A quote sync is already running — try again in a moment", busy: true });
  running = true;
  try {
    const { client, sync } = await authedClient();
    const chat = google.chat({ version: "v1", auth: client });
    const drive = google.drive({ version: "v3", auth: client });
    const space = sync.photoSpaceId || DEFAULT_SPACE;

    const doc = await Project.findById(PROJECT_ID, { "state.chatQuotes": 1 }).lean();
    const have = new Set(((doc && doc.state && doc.state.chatQuotes) || []).map((q) => q.id));
    const since = sync.quotesSyncedUntil ? new Date(new Date(sync.quotesSyncedUntil).getTime() - OVERLAP_MS) : null;

    const pending = [];
    let newest = null, pageToken;
    do {
      const { data } = await chat.spaces.messages.list({
        parent: space, pageSize: 1000, pageToken,
        ...(since ? { filter: `createTime > "${since.toISOString()}"` } : {}),
      });
      (data.messages || []).forEach((m) => {
        if (m.createTime && (!newest || m.createTime > newest)) newest = m.createTime;
        if (have.has(m.name)) return;
        const atts = (m.attachment || []).filter((a) => FILE_RE.test(a.contentType || ""));
        const names = atts.map((a) => a.contentName || "");
        if (!isQuoteText(m.text) && !names.some(isQuoteText)) return; // not about a quotation
        pending.push({ m, atts });
      });
      pageToken = data.nextPageToken;
    } while (pageToken);
    pending.sort((x, y) => String(x.m.createTime).localeCompare(String(y.m.createTime)));

    // take messages until the file budget for this call is used (text-only ones are free)
    let budget = MAX_FILES_PER_CALL, added = 0;
    const failed = [];
    const batch = [];
    for (const p of pending) {
      if (p.atts.length && budget <= 0 && batch.length) break;
      batch.push(p); budget -= p.atts.length;
    }
    for (const { m, atts } of batch) {
      const files = [];
      for (const a of atts) {
        try {
          const buf = await download(chat, drive, a);
          const up = await upload(buf, fileId(a.name), a.contentName || "quote");
          files.push({ name: a.contentName || "quote", url: up.secure_url, id: up.public_id,
            resourceType: up.resource_type, contentType: a.contentType || "" });
        } catch (e) {
          console.error("chat quote file failed", a.name, e.message);
          failed.push({ name: a.contentName || a.name, error: e.message });
          files.push({ name: a.contentName || "quote", url: null, error: e.message, contentType: a.contentType || "" });
        }
      }
      const text = String(m.text || "");
      const rec = {
        id: m.name, time: m.createTime || null, sender: (m.sender && m.sender.displayName) || "",
        text: text.slice(0, 1500), files, vendorGuess: guessVendor(text, files.map((f) => f.name)),
        amount: extractAmount(text), status: "new",
      };
      const r = await Project.updateOne(
        { _id: PROJECT_ID, "state.chatQuotes.id": { $ne: rec.id } },
        { $push: { "state.chatQuotes": rec } }
      );
      if (r.modifiedCount) added++;
    }

    const remaining = pending.length - batch.length;
    const update = { quotesLastRunAt: new Date() };
    if (remaining === 0 && newest) update.quotesSyncedUntil = newest;
    await ChatSync.updateOne({ _id: SYNC_ID }, { $set: update });

    res.json({ added, remaining, failed });
  } catch (err) {
    if (err.code === "NOT_CONNECTED") return res.status(409).json({ error: "Google is not connected yet — an admin must click Reconnect Google once" });
    const detail = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    console.error("POST /api/chat-quotes/sync failed:", detail);
    res.status(500).json({ error: "Could not read quotes from Google Chat: " + detail });
  } finally {
    running = false;
  }
});

// PATCH /api/chat-quotes/status  { id, status: "new"|"added"|"dismissed", quoteId? }
router.patch("/status", requireAdmin, async (req, res) => {
  try {
    const { id, status, quoteId } = req.body || {};
    if (!id || !["new", "added", "dismissed"].includes(status)) return res.status(400).json({ error: "id and a valid status are required" });
    const set = { "state.chatQuotes.$.status": status };
    if (quoteId !== undefined) set["state.chatQuotes.$.quoteId"] = quoteId;
    const r = await Project.updateOne({ _id: PROJECT_ID, "state.chatQuotes.id": id }, { $set: set });
    if (!r.matchedCount) return res.status(404).json({ error: "Chat quote not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/chat-quotes/status failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
