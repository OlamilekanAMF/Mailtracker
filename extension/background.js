// Background service worker: talks to the backend on behalf of content scripts
// (avoids mixed-content / CORS problems on the webmail pages), shows "your email was
// opened" notifications and fires no-reply reminders.

async function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get(["serverUrl", "apiKey", "owner"], (s) => resolve(s || {}))
  );
}
const storageGet = (keys) => new Promise((res) => chrome.storage.local.get(keys, (s) => res(s || {})));
const storageSet = (obj) => new Promise((res) => chrome.storage.local.set(obj, () => res()));

async function api(path, options = {}) {
  const { serverUrl, apiKey } = await getSettings();
  if (!serverUrl || !apiKey) throw new Error("Set server URL and API key in the extension options.");
  const res = await fetch(serverUrl.replace(/\/+$/, "") + path, {
    ...options,
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Backend error ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- notifications

const ICON = "icons/icon128.png";
const REOPEN_NOTIFY_MS = 60 * 60 * 1000; // repeat opens notify at most once an hour per email
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const MAIL_HOME = {
  gmail: "https://mail.google.com/mail/u/0/",
  outlook: "https://outlook.office.com/mail/",
  zoho: "https://mail.zoho.com/",
  yahoo: "https://mail.yahoo.com/",
};

function mailUrl(provider, subject) {
  if (provider === "gmail" || !provider) {
    const s = String(subject || "").replace(/"/g, "");
    return MAIL_HOME.gmail + "#search/" + encodeURIComponent('subject:"' + s + '"');
  }
  return MAIL_HOME[provider] || MAIL_HOME.gmail;
}

function notify(id, title, message, extra = {}) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(
        id,
        { type: "basic", iconUrl: ICON, title, message, priority: 2, ...extra },
        () => {
          void chrome.runtime.lastError;
          resolve();
        }
      );
    } catch (_) {
      resolve();
    }
  });
}

// So a click on a notification can open the right mailbox view.
async function rememberNotif(id, meta) {
  const { notifMeta = {} } = await storageGet(["notifMeta"]);
  notifMeta[id] = { subject: meta.subject || "", provider: meta.provider || "gmail", at: Date.now() };
  const ids = Object.keys(notifMeta);
  if (ids.length > 60) {
    ids.sort((a, b) => notifMeta[a].at - notifMeta[b].at).slice(0, ids.length - 60).forEach((k) => delete notifMeta[k]);
  }
  await storageSet({ notifMeta });
}

chrome.notifications.onClicked.addListener(async (id) => {
  const { notifMeta = {} } = await storageGet(["notifMeta"]);
  const meta = notifMeta[id];
  if (meta) chrome.tabs.create({ url: mailUrl(meta.provider, meta.subject) });
  chrome.notifications.clear(id);
});

const humanAgo = (ms) => {
  const h = Math.round(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
};

// ---------------------------------------------------------------- opens feed

let polling = false;
let lastPollAt = 0;

async function pollOpens() {
  if (polling) return;
  polling = true;
  try {
    const s = await storageGet(["owner", "enabled", "notifyOpens", "lastOpenId", "notified", "serverUrl", "apiKey"]);
    if (s.enabled === false || s.notifyOpens === false || !s.serverUrl || !s.apiKey) return;

    const q = new URLSearchParams();
    if (s.owner) q.set("owner", s.owner);
    if (typeof s.lastOpenId === "number") q.set("after", String(s.lastOpenId));
    const data = await api("/api/opens" + (String(q) ? "?" + q : ""));

    if (typeof s.lastOpenId !== "number" || data.latestId < s.lastOpenId) {
      // First run, or the backend database was reset: start from "now", never replay history.
      await storageSet({ lastOpenId: data.latestId });
      return;
    }

    const notified = s.notified || {};
    const now = Date.now();
    for (const o of data.opens || []) {
      const last = notified[o.emailId] || 0;
      if (!o.first && now - last < REOPEN_NOTIFY_MS) continue;
      notified[o.emailId] = now;
      const to = (o.recipients || []).join(", ") || "your recipient";
      const id = `mt-open-${o.emailId}-${o.id}`;
      await rememberNotif(id, { subject: o.subject, provider: o.provider });
      await notify(
        id,
        o.first ? "Your email was opened" : "Your email was opened again",
        `“${o.subject || "(no subject)"}” to ${to}`
      );
    }
    for (const k of Object.keys(notified)) if (now - notified[k] > WEEK_MS) delete notified[k];
    await storageSet({ lastOpenId: data.latestId, notified });
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- reminders

// Claim a due reminder exactly once, re-reading storage so a reply detected by the
// Gmail page in the meantime is not overwritten.
async function claimReminder(id) {
  const { reminders = {} } = await storageGet(["reminders"]);
  const r = reminders[id];
  if (!r || r.status !== "active" || r.at > Date.now()) return null;
  r.status = "fired";
  r.firedAt = Date.now();
  await storageSet({ reminders });
  return r;
}

async function checkReminders() {
  const { reminders = {}, enabled } = await storageGet(["reminders", "enabled"]);
  if (enabled === false) return;
  const now = Date.now();
  for (const r0 of Object.values(reminders)) {
    if (r0.status !== "active" || r0.at > now) continue;
    const r = await claimReminder(r0.id);
    if (!r) continue;
    const id = `mt-rem-${r.id}`;
    await rememberNotif(id, { subject: r.subject, provider: "gmail" });
    await notify(
      id,
      "No reply yet",
      `No reply to “${r.subject || "(no subject)"}” from ${(r.recipients || []).join(", ") || "the recipient"} after ${humanAgo(now - r.createdAt)}.`,
      { requireInteraction: true }
    );
  }
}

// ---------------------------------------------------------------- scheduling

async function tick() {
  try {
    await pollOpens();
  } catch (_) {
    /* backend asleep or offline: try again next tick */
  }
  try {
    await checkReminders();
  } catch (_) {
    /* best effort */
  }
}

function ensureAlarm() {
  chrome.alarms.get("mt-tick", (a) => {
    void chrome.runtime.lastError;
    if (!a) chrome.alarms.create("mt-tick", { delayInMinutes: 0.1, periodInMinutes: 0.5 });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  tick();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "mt-tick") tick();
});
ensureAlarm();

// ---------------------------------------------------------------- messages

const ID_RE = /^[a-f0-9]{32}$/;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "register") {
        await api("/api/emails", {
          method: "POST",
          body: JSON.stringify({
            id: msg.id,
            owner: msg.owner,
            provider: msg.provider,
            subject: msg.subject,
            recipients: msg.recipients,
          }),
        });
        sendResponse({ ok: true });
      } else if (msg.type === "status") {
        // Retry once: registration may still be in flight.
        try {
          await api(`/api/emails/${msg.id}/status`, { method: "POST", body: JSON.stringify({ status: msg.status }) });
        } catch (_) {
          await new Promise((r) => setTimeout(r, 1500));
          await api(`/api/emails/${msg.id}/status`, { method: "POST", body: JSON.stringify({ status: msg.status }) });
        }
        sendResponse({ ok: true });
      } else if (msg.type === "list") {
        const { owner } = await getSettings();
        const q = msg.all || !owner ? "" : `?owner=${encodeURIComponent(owner)}`;
        sendResponse({ ok: true, data: await api("/api/emails" + q) });
      } else if (msg.type === "ping") {
        sendResponse({ ok: true, data: await api("/health") });
      } else if (msg.type === "poll") {
        // Sent every few seconds by an open webmail tab: gives near-instant notifications.
        if (Date.now() - lastPollAt > 5000) {
          lastPollAt = Date.now();
          await tick();
        }
        sendResponse({ ok: true });
      } else if (msg.type === "self-view") {
        // The owner is looking at their own sent email: its pixel loads are not reads.
        if (!ID_RE.test(String(msg.id || ""))) throw new Error("bad id");
        await api(`/api/emails/${msg.id}/self-view`, { method: "POST", body: "{}" });
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async response
});
