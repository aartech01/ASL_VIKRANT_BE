const mongoose = require("mongoose");

/*
 * Singleton document (like Project) holding everything the Google-sync
 * features need across requests: one OAuth refresh token shared by both
 * Chat sync and Sheet sync (same account, different scopes/APIs), which
 * Chat space and which spreadsheet to read, and which items from each have
 * already been reviewed so re-running preview doesn't re-surface them.
 */
const ChatSyncSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "vikrant-unit3-chat" },
    refreshToken: { type: String, default: null },
    spaceId: { type: String, default: null }, // e.g. "spaces/AAQAdEiPJJU"
    spaceDisplayName: { type: String, default: null },
    lastSyncedMessageTime: { type: Date, default: null },
    seenMessageIds: { type: [String], default: [] },
    sheetId: { type: String, default: "19Cm-dQ9ObyE7ICfe6TPWBPbIQ0cjPdbg" }, // ASL Unit-3 A-147.xlsx
    sheetTab: { type: String, default: "Expenses Sheet" },
    seenExpenseKeys: { type: [String], default: [] },
    // Chat photo import (routes/chatPhotos.js)
    photoSpaceId: { type: String, default: null }, // defaults to spaces/AAQAdEiPJJU in the route
    photosSyncedUntil: { type: Date, default: null },
    photosLastRunAt: { type: Date, default: null },
    importedPhotoKeys: { type: [String], default: [] }, // Chat attachment resource names already imported
    skippedPhotoKeys: { type: [String], default: [] }, // attachments that can never import (not a real image)
    // Chat vendor-quote import (routes/chatQuotes.js)
    quotesSyncedUntil: { type: Date, default: null },
    quotesLastRunAt: { type: Date, default: null },
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model("ChatSync", ChatSyncSchema);
