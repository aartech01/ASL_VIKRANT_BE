const express = require("express");
const streamifier = require("streamifier");
const { google } = require("googleapis");
const cloudinary = require("../cloudinary");
const Project = require("../models/Project");
const ChatSync = require("../models/ChatSync");
const { PROJECT_ID } = require("../constants");
const { SYNC_ID, authedClient } = require("../services/googleAuth");

/*
 * Pull every photo posted in the site's Google Chat room into the Photos tab.
 *
 * Uses the same saved Google connection as Chat/Sheet sync (it already holds
 * chat.messages.readonly for attachment downloads and drive.readonly for
 * photos shared from Drive), so nobody has to sign in again.
 *
 * No duplicates, by three independent guards:
 *   1. every imported attachment's Chat resource name is remembered in
 *      ChatSync.importedPhotoKeys, so it is never fetched twice — even if
 *      someone later deletes that photo from the dashboard on purpose;
 *   2. the Cloudinary public_id is derived from that resource name with
 *      overwrite:false, so a repeat upload returns the existing image;
 *   3. the photo record is pushed with an atomic "only if this id is not
 *      already in state.photos" condition.
 *
 * Work is done in small batches (MAX_PER_CALL) so a first import of a long
 * chat history never hits a request timeout; the response says how many are
 * still waiting and the dashboard simply calls again until none are left.
 */
const router = express.Router();

const DEFAULT_SPACE = process.env.CHAT_PHOTO_SPACE || "spaces/AAQAdEiPJJU";
const MAX_PER_CALL = 12;
const OVERLAP_MS = 2 * 24 * 60 * 60 * 1000; // re-scan 2 days behind the cursor; guard 1 skips repeats
let running = false;

const isImage = (a) => /^image\//i.test(a.contentType || "");
const cloudId = (key) => "chat_" + String(key).replace(/^spaces\//, "").replace(/[^A-Za-z0-9_-]+/g, "_");

function uploadBuffer(buffer, publicId, isHeic) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "vikrant-control-room/chat",
        public_id: publicId,
        overwrite: false,
        resource_type: "image",
        tags: ["google_chat"],
        ...(isHeic ? { format: "jpg" } : {}), // browsers can't show HEIC from iPhones
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function download(chat, drive, att) {
  if (att.attachmentDataRef && att.attachmentDataRef.resourceName) {
    const r = await chat.media.download(
      { resourceName: att.attachmentDataRef.resourceName, alt: "media" },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(r.data);
  }
  if (att.driveDataRef && att.driveDataRef.driveFileId) {
    const r = await drive.files.get(
      { fileId: att.driveDataRef.driveFileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(r.data);
  }
  throw new Error("attachment has no downloadable data");
}

// GET /api/chat-photos/status — for the Photos tab's status line
router.get("/status", async (req, res) => {
  try {
    const sync = await ChatSync.findById(SYNC_ID).lean();
    res.json({
      connected: !!(sync && sync.refreshToken),
      space: (sync && sync.photoSpaceId) || DEFAULT_SPACE,
      imported: ((sync && sync.importedPhotoKeys) || []).length,
      lastRunAt: (sync && sync.photosLastRunAt) || null,
      running,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat-photos/sync — import the next batch of new chat photos.
// Open to any visitor (like photo upload): it only ever copies photos that
// are already in the team's own chat room, and is idempotent.
router.post("/sync", async (req, res) => {
  if (running) return res.status(409).json({ error: "A photo sync is already running — try again in a moment", busy: true });
  running = true;
  try {
    const { client, sync } = await authedClient();
    const chat = google.chat({ version: "v1", auth: client });
    const drive = google.drive({ version: "v3", auth: client });
    const space = sync.photoSpaceId || DEFAULT_SPACE;
    const done = new Set(sync.importedPhotoKeys || []);
    const since = sync.photosSyncedUntil ? new Date(new Date(sync.photosSyncedUntil).getTime() - OVERLAP_MS) : null;

    // 1. find every image attachment in the room not yet imported (oldest first)
    const pending = [];
    let newest = null;
    let pageToken;
    do {
      const { data } = await chat.spaces.messages.list({
        parent: space,
        pageSize: 1000,
        pageToken,
        ...(since ? { filter: `createTime > "${since.toISOString()}"` } : {}),
      });
      (data.messages || []).forEach((m) => {
        if (m.createTime && (!newest || m.createTime > newest)) newest = m.createTime;
        (m.attachment || []).forEach((a) => {
          if (!isImage(a) || done.has(a.name)) return;
          pending.push({ m, a });
        });
      });
      pageToken = data.nextPageToken;
    } while (pageToken);
    pending.sort((x, y) => String(x.m.createTime).localeCompare(String(y.m.createTime)));

    // 2. import a batch
    const batch = pending.slice(0, MAX_PER_CALL);
    const imported = [];
    const failed = [];
    for (const { m, a } of batch) {
      try {
        const buf = await download(chat, drive, a);
        const isHeic = /heic|heif/i.test(a.contentType || "") || /\.hei[cf]$/i.test(a.contentName || "");
        const up = await uploadBuffer(buf, cloudId(a.name), isHeic);
        const photo = {
          id: up.public_id,
          name: a.contentName || "chat-photo.jpg",
          area: "",
          url: up.secure_url,
          source: "chat",
          chatAttachment: a.name,
          chatMessage: m.name,
          sender: (m.sender && m.sender.displayName) || "",
          takenAt: m.createTime || null,
          caption: String(m.text || "").slice(0, 300),
        };
        await Project.updateOne(
          { _id: PROJECT_ID, "state.photos.id": { $ne: photo.id } },
          { $push: { "state.photos": photo } }
        );
        await ChatSync.updateOne({ _id: SYNC_ID }, { $addToSet: { importedPhotoKeys: a.name } });
        imported.push(photo.id);
      } catch (e) {
        console.error("chat photo import failed for", a.name, e.message);
        failed.push({ name: a.contentName || a.name, error: e.message });
      }
    }

    // 3. advance the scan cursor only once everything up to `newest` is in
    const remaining = pending.length - imported.length;
    const update = { photosLastRunAt: new Date(), photoSpaceId: space };
    if (remaining === 0 && newest) update.photosSyncedUntil = newest;
    await ChatSync.updateOne({ _id: SYNC_ID }, { $set: update });

    res.json({ imported: imported.length, remaining, failed, totalImported: done.size + imported.length });
  } catch (err) {
    if (err.code === "NOT_CONNECTED") return res.status(409).json({ error: "Google is not connected yet — an admin must click Reconnect Google once" });
    const detail = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    console.error("POST /api/chat-photos/sync failed:", detail);
    res.status(500).json({ error: "Could not read photos from Google Chat: " + detail });
  } finally {
    running = false;
  }
});

module.exports = router;
