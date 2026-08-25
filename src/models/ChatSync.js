const mongoose = require("mongoose");

/*
 * Singleton document (like Project) holding everything the Chat-sync feature
 * needs across requests: the OAuth refresh token for the Google account that
 * is a member of the site's Chat space, which space to read, and which
 * messages have already been reviewed so re-running preview doesn't
 * re-surface the same items.
 */
const ChatSyncSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "vikrant-unit3-chat" },
    refreshToken: { type: String, default: null },
    spaceId: { type: String, default: null }, // e.g. "spaces/AAQAdEiPJJU"
    spaceDisplayName: { type: String, default: null },
    lastSyncedMessageTime: { type: Date, default: null },
    seenMessageIds: { type: [String], default: [] },
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model("ChatSync", ChatSyncSchema);
