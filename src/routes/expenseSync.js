const express = require("express");
const { google } = require("googleapis");
const Project = require("../models/Project");
const ChatSync = require("../models/ChatSync");
const { PROJECT_ID } = require("../constants");
const requireAdmin = require("../middleware/requireAdmin");
const { SYNC_ID, authedClient } = require("../services/googleAuth");

const router = express.Router();

// Fallback when the saved sync doc predates these fields (Mongoose schema
// defaults only apply to documents created after the field was added — an
// already-existing doc just reads back as undefined, not the new default).
// ASL Unit-3 A-147.xlsx, "Expenses Sheet" tab.
const DEFAULT_SHEET_ID = "19Cm-dQ9ObyE7ICfe6TPWBPbIQ0cjPdbg";
const DEFAULT_SHEET_TAB = "Expenses Sheet";

// Column order in the "Expenses Sheet" tab, A onward — see ASL Unit-3 A-147.xlsx.
const COLS = ["date", "voucherNo", "classification", "ledger", "partyName",
  "invoiceNo", "invoiceDate", "desc", "amount", "gst", "total"];

function rowToObject(row) {
  const o = {};
  COLS.forEach((k, i) => { o[k] = (row[i] || "").toString().trim(); });
  return o;
}

// Every field concatenated is the row's identity — most rows here have no
// voucher number yet (informal entries later formalised), so no single
// column is reliably unique on its own.
function rowKey(o) {
  return COLS.map((k) => o[k] || "").join("|");
}

function num(s) {
  const n = Number(String(s || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function boqLineAmount(b) {
  return (Number(b.rate) || 0) * (Number(b.qty) || 1);
}

// Same duplicate check as chat-sync: a matching amount already sitting in a
// BOQ line, a daily log note, or a previously-synced expense means this row
// is most likely already accounted for somewhere in Vikrant.
function findLikelyDuplicate(amount, state) {
  if (!amount) return null;
  const boq = Array.isArray(state.boq) ? state.boq : [];
  const hit = boq.find((b) => Math.round(boqLineAmount(b)) === Math.round(amount));
  if (hit) return { type: "boq", area: hit.area, desc: hit.desc };
  const logs = Array.isArray(state.dailyLogs) ? state.dailyLogs : [];
  const logHit = logs.find((l) => String(l.notes || "").includes(String(Math.round(amount))));
  if (logHit) return { type: "dailyLog", date: logHit.date };
  const expenses = Array.isArray(state.expenses) ? state.expenses : [];
  const expHit = expenses.find((e) => Math.round(Number(e.amount) || 0) === Math.round(amount));
  if (expHit) return { type: "expense", desc: expHit.desc };
  return null;
}

// GET /api/expense-sync/status
router.get("/status", requireAdmin, async (req, res) => {
  const sync = await ChatSync.findById(SYNC_ID).lean();
  res.json({
    connected: !!(sync && sync.refreshToken),
    sheetId: (sync && sync.sheetId) || DEFAULT_SHEET_ID,
    sheetTab: (sync && sync.sheetTab) || DEFAULT_SHEET_TAB,
  });
});

// POST /api/expense-sync/sheet  { sheetId, sheetTab }
router.post("/sheet", requireAdmin, async (req, res) => {
  const { sheetId, sheetTab } = req.body || {};
  if (!sheetId) return res.status(400).json({ error: "sheetId is required" });
  await ChatSync.findByIdAndUpdate(
    SYNC_ID,
    { sheetId, sheetTab: sheetTab || "Expenses Sheet" },
    { upsert: true }
  );
  res.json({ ok: true });
});

// GET /api/expense-sync/preview — every sheet row not already synced or
// already matching something in Vikrant. Reads only; nothing is written.
router.get("/preview", requireAdmin, async (req, res) => {
  try {
    const { client, sync } = await authedClient();
    const sheetId = sync.sheetId || DEFAULT_SHEET_ID;
    const sheets = google.sheets({ version: "v4", auth: client });
    const tab = sync.sheetTab || DEFAULT_SHEET_TAB;
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tab}'!A2:K5000`,
    });
    const rows = (data.values || []).filter((r) => r.some((c) => c && String(c).trim()));

    const seen = new Set(sync.seenExpenseKeys || []);
    const projectDoc = await Project.findById(PROJECT_ID).lean();
    const state = (projectDoc && projectDoc.state) || {};

    const candidates = rows
      .map(rowToObject)
      .map((o) => ({ ...o, key: rowKey(o), amountNum: num(o.amount) }))
      .filter((o) => !seen.has(o.key))
      .map((o) => ({
        key: o.key,
        row: o,
        likelyDuplicate: findLikelyDuplicate(o.amountNum, state),
      }));

    res.json({ candidates, sheetTab: tab });
  } catch (err) {
    if (err.code === "NOT_CONNECTED") return res.status(409).json({ error: err.message });
    console.error("GET /api/expense-sync/preview failed:", err.message);
    res.status(500).json({ error: "Could not read the spreadsheet" });
  }
});

// POST /api/expense-sync/commit
// body: { items: [{ key, action:"add"|"skip", row:{date,voucherNo,classification,
//                    ledger,partyName,invoiceNo,invoiceDate,desc,amount,gst,total} }] }
// Every key listed is marked seen regardless of action, so a rejected row never
// resurfaces in a later preview.
router.post("/commit", requireAdmin, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "items must be a non-empty array" });

    const projectDoc = await Project.findById(PROJECT_ID).lean();
    const state = (projectDoc && projectDoc.state) || {};
    if (!Array.isArray(state.expenses)) state.expenses = [];

    items.forEach((item, i) => {
      if (item.action !== "add" || !item.row) return;
      const r = item.row;
      state.expenses.push({
        id: "exp" + Date.now() + i,
        date: r.date || "",
        voucherNo: r.voucherNo || "",
        classification: r.classification || "",
        ledger: r.ledger || "",
        partyName: r.partyName || "",
        invoiceNo: r.invoiceNo || "",
        invoiceDate: r.invoiceDate || "",
        desc: r.desc || "",
        amount: num(r.amount),
        gst: num(r.gst),
        total: num(r.total) || num(r.amount),
        source: "sheet",
        sourceKey: item.key,
      });
    });

    state.photos = (projectDoc && projectDoc.state && projectDoc.state.photos) || [];
    state.siteMap = (projectDoc && projectDoc.state && projectDoc.state.siteMap) || null;
    await Project.findByIdAndUpdate(
      PROJECT_ID,
      { state, updatedBy: "expense-sync" },
      { upsert: true }
    );

    const sync = await ChatSync.findById(SYNC_ID).lean();
    const seen = new Set((sync && sync.seenExpenseKeys) || []);
    items.forEach((item) => seen.add(item.key));
    await ChatSync.findByIdAndUpdate(SYNC_ID, { seenExpenseKeys: [...seen] }, { upsert: true });

    res.json({ ok: true, applied: items.filter((i) => i.action === "add").length });
  } catch (err) {
    console.error("POST /api/expense-sync/commit failed:", err.message);
    res.status(500).json({ error: "Could not commit expenses" });
  }
});

module.exports = router;
