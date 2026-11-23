// Mailtrack backend: pixel endpoint + small API for the extension.
// Run: npm install && API_KEY=your-secret PUBLIC_URL=https://your-host node server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const DB_PATH = process.env.DB_PATH || "mailtrack.db";
// Opens within this many seconds of sending are flagged as "likely prefetch / own view"
const PREFETCH_WINDOW_SEC = Number(process.env.PREFETCH_WINDOW_SEC || 15);

if (!API_KEY) {
  console.error("API_KEY is required. Set it in backend/.env or the process environment.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    provider TEXT,
    subject TEXT,
    recipients TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS opens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT,
    likely_prefetch INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_opens_email ON opens(email_id);
`);

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "100kb" }));

const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

function requireKey(req, res, next) {
  const key = req.get("x-api-key");
  if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// Public: tracking pixel. Always returns the GIF, never leaks whether the id exists.
app.get("/p/:id.gif", (req, res) => {
  const id = req.params.id;
  try {
    const email = db.prepare("SELECT * FROM emails WHERE id = ?").get(id);
    if (email) {
      const now = Date.now();
      const prefetch =
        email.sent_at && now - email.sent_at < PREFETCH_WINDOW_SEC * 1000 ? 1 : 0;
      db.prepare(
        "INSERT INTO opens (email_id, opened_at, user_agent, ip, likely_prefetch) VALUES (?,?,?,?,?)"
      ).run(id, now, req.get("user-agent") || "", req.ip || "", prefetch);
    }
  } catch (e) {
    console.error("pixel error", e);
  }
  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.send(PIXEL);
});

// Extension: register an email before it is sent. Returns the pixel id.
app.post("/api/emails", requireKey, (req, res) => {
  const { owner, provider, subject, recipients } = req.body || {};
  if (!owner) return res.status(400).json({ error: "owner required" });
  // The extension generates the id client-side (it must be in the email before send).
  const clientId = req.body && req.body.id;
  const id = /^[a-f0-9]{32}$/.test(clientId || "") ? clientId : crypto.randomBytes(16).toString("hex");
  db.prepare(
    "INSERT OR IGNORE INTO emails (id, owner, provider, subject, recipients, status, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(
    id,
    String(owner).slice(0, 200),
    String(provider || "").slice(0, 40),
    String(subject || "").slice(0, 300),
    JSON.stringify(Array.isArray(recipients) ? recipients.slice(0, 50) : []),
    "pending",
    Date.now()
  );
  res.json({ id });
});

// Extension: update status (sent | unconfirmed | failed)
app.post("/api/emails/:id/status", requireKey, (req, res) => {
  const status = req.body && req.body.status;
  if (!["sent", "unconfirmed", "failed"].includes(status))
    return res.status(400).json({ error: "bad status" });
  const sentAt = status === "sent" ? Date.now() : null;
  const r = db
    .prepare(
      "UPDATE emails SET status = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?"
    )
    .run(status, sentAt, req.params.id);
  res.json({ ok: r.changes > 0 });
});

// Extension: list emails (optionally for one owner)
app.get("/api/emails", requireKey, (req, res) => {
  const owner = req.query.owner;
  const rows = owner
    ? db.prepare("SELECT * FROM emails WHERE owner = ? ORDER BY created_at DESC LIMIT 200").all(owner)
    : db.prepare("SELECT * FROM emails ORDER BY created_at DESC LIMIT 200").all();
  const openStmt = db.prepare(
    "SELECT COUNT(*) AS n, MIN(opened_at) AS first, MAX(opened_at) AS last FROM opens WHERE email_id = ? AND likely_prefetch = 0"
  );
  const prefetchStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM opens WHERE email_id = ? AND likely_prefetch = 1"
  );
  const out = rows.map((r) => {
    const o = openStmt.get(r.id);
    const p = prefetchStmt.get(r.id);
    return {
      id: r.id,
      owner: r.owner,
      provider: r.provider,
      subject: r.subject,
      recipients: JSON.parse(r.recipients || "[]"),
      status: r.status,
      createdAt: r.created_at,
      sentAt: r.sent_at,
      opens: o.n,
      firstOpenedAt: o.first,
      lastOpenedAt: o.last,
      prefetchHits: p.n,
    };
  });
  res.json({ emails: out });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Mailtrack backend on :${PORT}`));
