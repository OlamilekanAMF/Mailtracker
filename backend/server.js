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
const PREFETCH_WINDOW_SEC = Number(process.env.PREFETCH_WINDOW_SEC || 30);
// If the extension never confirms a send, opens start counting after this long anyway.
const PENDING_GRACE_SEC = Number(process.env.PENDING_GRACE_SEC || 120);
// While the sender views their own email in Gmail, Gmail loads the tracking image for them.
// The extension reports that; pixel loads this many seconds after (and LOOKBACK before) the
// report are the sender's own view, not a read.
const SELF_VIEW_GRACE_SEC = Number(process.env.SELF_VIEW_GRACE_SEC || 20);
const SELF_VIEW_LOOKBACK_SEC = Number(process.env.SELF_VIEW_LOOKBACK_SEC || 15);
// "Your email was opened" notifications wait this long, so a self-view report can cancel them.
const NOTIFY_DELAY_SEC = Number(process.env.NOTIFY_DELAY_SEC || 5);

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
// Add columns that older databases don't have yet.
const emailCols = db.prepare("PRAGMA table_info(emails)").all().map((c) => c.name);
if (!emailCols.includes("self_until")) db.exec("ALTER TABLE emails ADD COLUMN self_until INTEGER");

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
      // likely_prefetch: 0 = real open, 1 = auto-load shortly after sending,
      // 2 = not a read at all (sender's own compose window, or mail that never arrived),
      // 3 = the sender viewing their own email (reported by the extension).
      let flag;
      if (email.self_until && now < email.self_until) {
        flag = 3; // the sender is looking at their own email right now
      } else if (email.status === "bounced" || email.status === "failed") {
        flag = 2;
      } else if (email.status === "pending" && now - email.created_at < PENDING_GRACE_SEC * 1000) {
        // The compose window loads the pixel itself before the send is confirmed.
        flag = 2;
      } else {
        const base = email.sent_at || email.created_at;
        flag = now - base < PREFETCH_WINDOW_SEC * 1000 ? 1 : 0;
      }
      db.prepare(
        "INSERT INTO opens (email_id, opened_at, user_agent, ip, likely_prefetch) VALUES (?,?,?,?,?)"
      ).run(id, now, req.get("user-agent") || "", req.ip || "", flag);
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

// Extension: update status (sent | unconfirmed | failed | bounced)
app.post("/api/emails/:id/status", requireKey, (req, res) => {
  const status = req.body && req.body.status;
  if (!["sent", "unconfirmed", "failed", "bounced"].includes(status))
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
  const selfStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM opens WHERE email_id = ? AND likely_prefetch = 3"
  );
  const out = rows.map((r) => {
    const o = openStmt.get(r.id);
    const p = prefetchStmt.get(r.id);
    const sv = selfStmt.get(r.id);
    // Mail that bounced or failed was never delivered, so it cannot have been read.
    if (r.status === "bounced" || r.status === "failed") {
      o.n = 0;
      o.first = null;
      o.last = null;
    }
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
      selfHits: sv.n,
    };
  });
  res.json({ emails: out });
});

// Extension: the sender is viewing their own email. Ignore the pixel loads this causes.
app.post("/api/emails/:id/self-view", requireKey, (req, res) => {
  const email = db.prepare("SELECT owner FROM emails WHERE id = ?").get(req.params.id);
  const account = String((req.body && req.body.account) || "").trim().toLowerCase();
  // Only the SENDER's own mailbox counts as a self-view. Another Google account open in the
  // same browser (for example the recipient's) must never suppress a real read.
  if (!email || !account || account !== String(email.owner).trim().toLowerCase()) {
    return res.json({ ok: false, ignored: true });
  }
  const now = Date.now();
  const r = db
    .prepare("UPDATE emails SET self_until = ? WHERE id = ?")
    .run(now + SELF_VIEW_GRACE_SEC * 1000, req.params.id);
  // Gmail may already have loaded the image a moment before this report arrived.
  db.prepare(
    "UPDATE opens SET likely_prefetch = 3 WHERE email_id = ? AND likely_prefetch = 0 AND opened_at > ?"
  ).run(req.params.id, now - SELF_VIEW_LOOKBACK_SEC * 1000);
  res.json({ ok: r.changes > 0 });
});

// Extension: new real opens after a cursor, for "your email was opened" notifications.
// Without ?after it only returns the current cursor, so old opens never notify.
app.get("/api/opens", requireKey, (req, res) => {
  const owner = req.query.owner;
  const after = req.query.after === undefined ? NaN : Number(req.query.after);
  if (Number.isNaN(after)) {
    const m = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM opens").get();
    return res.json({ opens: [], latestId: m.m });
  }

  const cutoff = Date.now() - NOTIFY_DELAY_SEC * 1000;
  const LIMIT = 50;
  const params = [after, cutoff];
  let sql =
    "SELECT o.id, o.email_id, o.opened_at, e.subject, e.recipients, e.provider " +
    "FROM opens o JOIN emails e ON e.id = o.email_id " +
    "WHERE o.id > ? AND o.opened_at <= ? AND o.likely_prefetch = 0 AND e.status NOT IN ('bounced','failed')";
  if (owner) {
    sql += " AND e.owner = ?";
    params.push(owner);
  }
  sql += ` ORDER BY o.id ASC LIMIT ${LIMIT}`;
  const rows = db.prepare(sql).all(...params);

  // Ids grow with time, so everything older than the cutoff is a prefix: the cursor can
  // safely move to the newest such id. (If the database was reset this goes backwards,
  // which tells the extension to start over.)
  let latestId;
  if (rows.length === LIMIT) {
    latestId = rows[rows.length - 1].id;
  } else {
    latestId = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM opens WHERE opened_at <= ?").get(cutoff).m;
  }

  const firstStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM opens WHERE email_id = ? AND likely_prefetch = 0 AND id < ?"
  );
  res.json({
    opens: rows.map((r) => ({
      id: r.id,
      emailId: r.email_id,
      openedAt: r.opened_at,
      subject: r.subject,
      recipients: JSON.parse(r.recipients || "[]"),
      provider: r.provider,
      first: firstStmt.get(r.email_id, r.id).n === 0,
    })),
    latestId,
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Mailtrack backend on :${PORT}`));
