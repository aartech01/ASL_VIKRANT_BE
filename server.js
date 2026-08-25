require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { connectDB } = require("./src/db");
const stateRoutes = require("./src/routes/state");
const photoRoutes = require("./src/routes/photos");
const sitemapRoutes = require("./src/routes/sitemap");
const quoteRoutes = require("./src/routes/quotes");
const chatSyncRoutes = require("./src/routes/chatSync");
const expenseSyncRoutes = require("./src/routes/expenseSync");

const app = express();
const PORT = process.env.PORT || 4000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow no-origin requests (curl, health checks) and anything on the allowlist
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS: " + origin));
    },
  })
);
app.use(morgan("tiny"));
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use("/api/state", stateRoutes);
app.use("/api/photos", photoRoutes);
app.use("/api/sitemap", sitemapRoutes);
app.use("/api/quotes", quoteRoutes);
app.use("/api/chat-sync", chatSyncRoutes);
app.use("/api/expense-sync", expenseSyncRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log("Vikrant Control Room API listening on port " + PORT));
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
