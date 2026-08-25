const { google } = require("googleapis");
const ChatSync = require("../models/ChatSync");

/*
 * One shared Google connection (one refresh token, one consent) powers both
 * the Chat sync and the Sheet sync — same account, just different scopes and
 * different API clients built from the same authed OAuth2 client. Keeping
 * this in one place means adding a third source later only means adding a
 * scope here, not another connect flow.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  // Needed because the expense spreadsheet is an uploaded .xlsx file, never
  // converted to a native Google Sheet — reading it means downloading the raw
  // file via Drive, which spreadsheets.readonly alone doesn't cover.
  "https://www.googleapis.com/auth/drive.readonly",
];
const SYNC_ID = "vikrant-unit3-chat"; // matches the id chatSync.js already uses in production

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

async function authedClient() {
  const sync = await ChatSync.findById(SYNC_ID).lean();
  if (!sync || !sync.refreshToken) {
    throw Object.assign(new Error("Google is not connected yet"), { code: "NOT_CONNECTED" });
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: sync.refreshToken });
  return { client, sync };
}

module.exports = { SCOPES, SYNC_ID, oauthClient, authedClient };
