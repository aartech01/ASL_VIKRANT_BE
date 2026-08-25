const express = require("express");
const { google } = require("googleapis");
const Project = require("../models/Project");
const ChatSync = require("../models/ChatSync");
const { PROJECT_ID } = require("../constants");
const requireAdmin = require("../middleware/requireAdmin");
const { SCOPES, SYNC_ID: CHAT_SYNC_ID, oauthClient, authedClient } = require("../services/googleAuth");

const router = express.Router();

async function chatClientForSavedAccount() {
  const { client, sync } = await authedClient();
  return { chat: google.chat({ version: "v1", auth: client }), sync };
}

// A message reads like "Rs 320 cement purchas for electric pole installation" —
// pull the number out so we can compare it against what's already recorded and
// suggest an amount without the person retyping it.
function extractAmount(text) {
  const m = String(text || "").match(/rs\.?\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function boqLineAmount(b) {
  return (Number(b.rate) || 0) * (Number(b.qty) || 1);
}

// Best-effort duplicate check: same rupee amount already sitting in a BOQ line
// or mentioned in a daily log note almost certainly means someone already
// keyed this transaction in directly, which is exactly the situation that
// prompted this feature (see chat history from 2026-08-25).
function findLikelyDuplicate(amount, state) {
  if (amount == null) return null;
  const boq = Array.isArray(state.boq) ? state.boq : [];
  const hit = boq.find((b) => Math.round(boqLineAmount(b)) === Math.round(amount));
  if (hit) return { type: "boq", area: hit.area, desc: hit.desc, owner: hit.owner };
  const logs = Array.isArray(state.dailyLogs) ? state.dailyLogs : [];
  const logHit = logs.find((l) => String(l.notes || "").includes(String(Math.round(amount))));
  if (logHit) return { type: "dailyLog", date: logHit.date };
  return null;
}

// GET /api/chat-sync/status — what's configured so far, for the frontend to
// decide whether to show "Connect Google Chat" or the actual sync button.
router.get("/status", requireAdmin, async (req, res) => {
  const sync = await ChatSync.findById(CHAT_SYNC_ID).lean();
  res.json({
    connected: !!(sync && sync.refreshToken),
    spaceId: (sync && sync.spaceId) || null,
    spaceDisplayName: (sync && sync.spaceDisplayName) || null,
    lastSyncedMessageTime: (sync && sync.lastSyncedMessageTime) || null,
  });
});

// GET /api/chat-sync/oauth2/start?key=... — one-time step, done by opening this
// URL in a browser signed in as the account that is a member of the Chat space.
// A query-string key (not a header) because this has to work as a plain link/redirect.
router.get("/oauth2/start", (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).send("Admin key required (as ?key=...)");
  }
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token back even if this account consented before
    scope: SCOPES,
  });
  res.redirect(url);
});

// GET /api/chat-sync/oauth2callback — Google redirects here with ?code=...
router.get("/oauth2callback", async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.status(400).send("Google returned an error: " + error);
    if (!code) return res.status(400).send("Missing code");
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send(
          "Google did not return a refresh token. Revoke this app's access at " +
            "https://myaccount.google.com/permissions and try the connect link again."
        );
    }
    await ChatSync.findByIdAndUpdate(
      CHAT_SYNC_ID,
      { refreshToken: tokens.refresh_token },
      { upsert: true }
    );
    res.send("Google Chat connected. You can close this tab and go back to Vikrant.");
  } catch (err) {
    console.error("GET /api/chat-sync/oauth2callback failed:", err.message);
    res.status(500).send("OAuth exchange failed: " + err.message);
  }
});

// GET /api/chat-sync/spaces — list spaces the connected account can see, so the
// correct one (e.g. "A-147") can be picked once and saved.
router.get("/spaces", requireAdmin, async (req, res) => {
  try {
    const { chat } = await chatClientForSavedAccount();
    const out = [];
    let pageToken;
    do {
      const { data } = await chat.spaces.list({ pageSize: 100, pageToken });
      (data.spaces || []).forEach((s) =>
        out.push({ name: s.name, displayName: s.displayName || s.name })
      );
      pageToken = data.nextPageToken;
    } while (pageToken);
    res.json({ spaces: out });
  } catch (err) {
    if (err.code === "NOT_CONNECTED") return res.status(409).json({ error: err.message });
    console.error("GET /api/chat-sync/spaces failed:", err.message);
    res.status(500).json({ error: "Could not list Chat spaces" });
  }
});

// POST /api/chat-sync/space  { spaceId, spaceDisplayName }
router.post("/space", requireAdmin, async (req, res) => {
  const { spaceId, spaceDisplayName } = req.body || {};
  if (!spaceId) return res.status(400).json({ error: "spaceId is required" });
  await ChatSync.findByIdAndUpdate(
    CHAT_SYNC_ID,
    { spaceId, spaceDisplayName: spaceDisplayName || spaceId },
    { upsert: true }
  );
  res.json({ ok: true });
});

// GET /api/chat-sync/preview — new messages since the last sync, each flagged
// with whatever look like a matching entry already in Vikrant, and never
// written anywhere; the caller decides what (if anything) to commit.
router.get("/preview", requireAdmin, async (req, res) => {
  try {
    const { chat, sync } = await chatClientForSavedAccount();
    if (!sync.spaceId) {
      return res.status(409).json({ error: "No Chat space selected yet (see /api/chat-sync/spaces)" });
    }
    const seen = new Set(sync.seenMessageIds || []);
    const since = sync.lastSyncedMessageTime
      ? new Date(sync.lastSyncedMessageTime)
      : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // first run: look back 14 days

    const messages = [];
    let pageToken;
    do {
      const { data } = await chat.spaces.messages.list({
        parent: sync.spaceId,
        pageSize: 100,
        pageToken,
        filter: `createTime > "${since.toISOString()}"`,
      });
      (data.messages || []).forEach((m) => messages.push(m));
      pageToken = data.nextPageToken;
    } while (pageToken);

    const projectDoc = await Project.findById(PROJECT_ID).lean();
    const state = (projectDoc && projectDoc.state) || {};

    const candidates = messages
      .filter((m) => !seen.has(m.name) && m.text)
      .map((m) => {
        const amount = extractAmount(m.text);
        return {
          messageId: m.name,
          createTime: m.createTime,
          sender: (m.sender && m.sender.displayName) || null,
          text: m.text,
          extractedAmount: amount,
          likelyDuplicate: findLikelyDuplicate(amount, state),
        };
      })
      .sort((a, b) => new Date(a.createTime) - new Date(b.createTime));

    res.json({ candidates, spaceDisplayName: sync.spaceDisplayName });
  } catch (err) {
    if (err.code === "NOT_CONNECTED") return res.status(409).json({ error: err.message });
    console.error("GET /api/chat-sync/preview failed:", err.message);
    res.status(500).json({ error: "Could not read Chat messages" });
  }
});

// POST /api/chat-sync/commit
// body: { items: [{ messageId, createTime, action: "skip"|"dailyLog"|"boq",
//                    dailyLog?: {date, notes}, boq?: {area, trade, desc, phase, owner, amount} }] }
// Every messageId listed is marked seen regardless of action, so a rejected
// item never resurfaces in a later preview.
router.post("/commit", requireAdmin, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "items must be a non-empty array" });

    const projectDoc = await Project.findById(PROJECT_ID).lean();
    const state = (projectDoc && projectDoc.state) || {};
    if (!Array.isArray(state.dailyLogs)) state.dailyLogs = [];
    if (!Array.isArray(state.boq)) state.boq = [];

    let latestTime = null;
    items.forEach((item, i) => {
      if (item.createTime && (!latestTime || new Date(item.createTime) > new Date(latestTime))) {
        latestTime = item.createTime;
      }
      const uid = Date.now() + i;
      if (item.action === "dailyLog" && item.dailyLog) {
        state.dailyLogs.push({
          id: "dl" + uid,
          date: item.dailyLog.date,
          weather: item.dailyLog.weather || "Clear",
          crew: Number(item.dailyLog.crew) || 0,
          notes: item.dailyLog.notes || "",
        });
      } else if (item.action === "boq" && item.boq) {
        state.boq.push({
          id: "b" + uid,
          area: item.boq.area || "OTHER",
          trade: item.boq.trade || "Other",
          desc: item.boq.desc || "",
          unit: "lump sum",
          qty: 1,
          rateKey: null,
          rate: Number(item.boq.amount) || 0,
          phase: Number(item.boq.phase) || 1,
          note: "Added via Chat sync",
          status: item.boq.status || "Done",
          owner: item.boq.owner || "",
        });
      }
      // action === "skip" (or anything else) just gets marked seen below.
    });

    // Same guard as PUT /api/state: never let this route's state write clobber
    // photos/siteMap uploaded by another session in the meantime.
    state.photos = (projectDoc && projectDoc.state && projectDoc.state.photos) || [];
    state.siteMap = (projectDoc && projectDoc.state && projectDoc.state.siteMap) || null;

    await Project.findByIdAndUpdate(
      PROJECT_ID,
      { state, updatedBy: "chat-sync" },
      { upsert: true }
    );

    const sync = await ChatSync.findById(CHAT_SYNC_ID).lean();
    const seen = new Set((sync && sync.seenMessageIds) || []);
    items.forEach((item) => seen.add(item.messageId));
    const update = { seenMessageIds: [...seen] };
    if (latestTime) update.lastSyncedMessageTime = latestTime;
    await ChatSync.findByIdAndUpdate(CHAT_SYNC_ID, update, { upsert: true });

    res.json({ ok: true, applied: items.filter((i) => i.action !== "skip").length });
  } catch (err) {
    console.error("POST /api/chat-sync/commit failed:", err.message);
    res.status(500).json({ error: "Could not commit Chat sync items" });
  }
});

module.exports = router;
