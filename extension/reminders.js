// Gmail extras for a sent email you have open:
//   * a "Remind me if no reply" button (24h / 48h / 72h / custom date, or dismiss);
//   * reply detection, so a reminder is cancelled when the recipient answers;
//   * telling the backend that YOU are viewing your own email, so Gmail loading the
//     tracking image for you is not counted (or notified) as the recipient reading it.
// Reminders live in chrome.storage.local; background.js fires them as notifications.

(function () {
  const D = window.__mtData;
  if (!D) return;

  const HOUR = 3600 * 1000;
  const storageGet = (keys) =>
    new Promise((res) => {
      try {
        chrome.storage.local.get(keys, (s) => res(s || {}));
      } catch (_) {
        res({});
      }
    });
  const storageSet = (obj) =>
    new Promise((res) => {
      try {
        chrome.storage.local.set(obj, () => res());
      } catch (_) {
        res();
      }
    });
  const fmt = (t) =>
    new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  // ------------------------------------------------------------------ UI

  const style = document.createElement("style");
  style.textContent = `
#mt-remind{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:none;font:13px/1.3 "Google Sans",Roboto,Arial,sans-serif}
#mt-remind .mt-pill{display:flex;align-items:center;gap:6px;background:#202124;color:#fff;border-radius:20px;padding:8px 14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none}
#mt-remind .mt-pill.on{background:#188038}
#mt-remind .mt-pill.warn{background:#b06000}
#mt-remind .mt-menu{display:none;position:absolute;right:0;bottom:44px;min-width:260px;background:#fff;color:#202124;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);padding:8px 0}
#mt-remind .mt-menu.open{display:block}
#mt-remind .mt-menu h4{margin:0;padding:6px 16px 8px;font-size:13px;font-weight:600}
#mt-remind .mt-item{padding:8px 16px;cursor:pointer}
#mt-remind .mt-item:hover{background:#f1f3f4}
#mt-remind .mt-custom{display:flex;gap:6px;align-items:center;padding:8px 16px}
#mt-remind .mt-custom input{flex:1;min-width:0;font:inherit;padding:4px}
#mt-remind .mt-custom button{font:inherit;padding:4px 10px;cursor:pointer}`;
  document.documentElement.appendChild(style);

  const root = document.createElement("div");
  root.id = "mt-remind";
  const menu = document.createElement("div");
  menu.className = "mt-menu";
  const pill = document.createElement("div");
  pill.className = "mt-pill";
  root.append(menu, pill);
  document.documentElement.appendChild(root);

  pill.addEventListener("click", () => menu.classList.toggle("open"));
  document.addEventListener(
    "click",
    (e) => {
      if (!root.contains(e.target)) menu.classList.remove("open");
    },
    true
  );

  async function setReminder(email, atMs) {
    const { reminders = {} } = await storageGet(["reminders"]);
    reminders[email.id] = {
      id: email.id,
      subject: email.subject || "",
      recipients: email.recipients || [],
      createdAt: email.sentAt || email.createdAt,
      at: atMs,
      status: "active",
    };
    await storageSet({ reminders });
    menu.classList.remove("open");
  }

  async function clearReminder(email) {
    const { reminders = {} } = await storageGet(["reminders"]);
    delete reminders[email.id];
    await storageSet({ reminders });
    menu.classList.remove("open");
  }

  function addItem(label, onClick) {
    const d = document.createElement("div");
    d.className = "mt-item";
    d.textContent = label;
    d.addEventListener("click", onClick);
    menu.appendChild(d);
  }

  function buildMenu(email, r) {
    menu.textContent = "";
    const h = document.createElement("h4");
    h.textContent = "Remind me";
    menu.appendChild(h);

    const base = email.sentAt || email.createdAt;
    for (const hrs of [24, 48, 72]) {
      // Counted from when the email was sent, but never in the past.
      addItem(`if there's no reply in ${hrs}h`, () =>
        setReminder(email, Math.max(base + hrs * HOUR, Date.now() + 60 * 1000))
      );
    }

    const custom = document.createElement("div");
    custom.className = "mt-custom";
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.value = toLocalInput(Date.now() + 24 * HOUR);
    const set = document.createElement("button");
    set.textContent = "Set";
    set.addEventListener("click", () => {
      const t = new Date(input.value).getTime();
      if (!isNaN(t) && t > Date.now()) setReminder(email, t);
    });
    custom.append(input, set);
    menu.appendChild(custom);

    if (r && r.status === "active") addItem("Dismiss reminder", () => clearReminder(email));
  }

  // ------------------------------------------------------------------ thread tracking

  let currentMatches = [];
  let lastSig = "";
  let lastSelfKey = "";
  let lastSelfAt = 0;
  let busy = false;
  let again = false;

  function sendSelfView(emails) {
    lastSelfAt = Date.now();
    emails
      .filter((e) => e.status === "sent" || e.status === "unconfirmed")
      .slice(0, 5)
      .forEach((e) => D.send({ type: "self-view", id: e.id }));
  }

  async function render() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const h = document.querySelector("h2.hP");
      const open = !!h && h.offsetParent !== null;
      const subject = open ? h.textContent : "";
      currentMatches = open
        ? D.emails
            .filter((e) => D.norm(e.subject) === D.norm(subject) && e.status !== "bounced" && e.status !== "failed")
            .sort((a, b) => b.createdAt - a.createdAt)
        : [];
      const email = currentMatches[0] || null;
      if (!email) {
        root.style.display = "none";
        lastSig = "";
        lastSelfKey = "";
        return;
      }

      const key = location.hash + "|" + D.norm(subject);
      if (key !== lastSelfKey) {
        lastSelfKey = key;
        sendSelfView(currentMatches);
      }

      const { reminders = {} } = await storageGet(["reminders"]);
      const r = reminders[email.id];
      const sig = email.id + "|" + (r ? r.status + "|" + r.at : "none");
      root.style.display = "block";
      if (sig === lastSig) return;
      lastSig = sig;

      pill.className = "mt-pill";
      if (r && r.status === "active") {
        pill.textContent = "🔔 No-reply reminder · " + fmt(r.at);
        pill.classList.add("on");
      } else if (r && r.status === "replied") {
        pill.textContent = "✓ Replied";
        pill.classList.add("on");
      } else if (r && r.status === "fired") {
        pill.textContent = "🔔 No reply · reminder sent";
        pill.classList.add("warn");
      } else {
        pill.textContent = "🔔 Remind me if no reply";
      }
      buildMenu(email, r);
    } finally {
      busy = false;
      if (again) {
        again = false;
        render();
      }
    }
  }

  // Your own clicks inside the open thread (expanding a message) can load the image again.
  document.addEventListener(
    "click",
    () => {
      if (currentMatches.length && Date.now() - lastSelfAt > 2000) sendSelfView(currentMatches);
    },
    true
  );

  // ------------------------------------------------------------------ reply detection

  // A reply must arrive clearly after the send: a copy of a message you sent to yourself
  // lands within seconds and would otherwise look like an answer.
  const REPLY_MIN_DELAY = 30 * 1000;

  async function scanReplies() {
    const { reminders = {} } = await storageGet(["reminders"]);
    const active = Object.values(reminders).filter((r) => r.status === "active");
    if (!active.length) return;

    const found = {};
    const consider = (subjectNorm, fromEmails, time) => {
      for (const r of active) {
        if (found[r.id] || D.norm(r.subject) !== subjectNorm) continue;
        const rec = (r.recipients || []).map((x) => String(x).toLowerCase());
        if (!fromEmails.some((f) => rec.includes(f))) continue;
        if (time !== null && time < r.createdAt + REPLY_MIN_DELAY) continue;
        found[r.id] = time || Date.now();
      }
    };

    // 1) message list rows (inbox, search results, ...); Sent rows list recipients, so skip them
    document.querySelectorAll("tr.zA").forEach((row) => {
      const who = row.querySelector("td.yX");
      const subjEl = row.querySelector("span.bog");
      if (!who || !subjEl || /^to\s*:/i.test(who.textContent.trim())) return;
      const senders = Array.from(who.querySelectorAll("[email]")).map((n) => (n.getAttribute("email") || "").toLowerCase());
      const timeEl = row.querySelector("td.xW [title]");
      consider(D.norm(subjEl.textContent), senders, timeEl ? D.parseTime(timeEl.getAttribute("title")) : null);
    });

    // 2) messages of the thread that is open
    const h = document.querySelector("h2.hP");
    if (h) {
      const subj = D.norm(h.textContent);
      document.querySelectorAll("div.adn").forEach((msg) => {
        const gd = msg.querySelector("span.gD[email]");
        if (!gd) return;
        const timeEl = msg.querySelector("span.g3[title]");
        consider(subj, [(gd.getAttribute("email") || "").toLowerCase()], timeEl ? D.parseTime(timeEl.getAttribute("title")) : null);
      });
    }

    const ids = Object.keys(found);
    if (!ids.length) return;
    const fresh = (await storageGet(["reminders"])).reminders || {};
    let changed = false;
    for (const id of ids) {
      if (fresh[id] && fresh[id].status === "active") {
        fresh[id].status = "replied";
        fresh[id].repliedAt = found[id];
        changed = true;
      }
    }
    if (changed) await storageSet({ reminders: fresh });
  }

  // ------------------------------------------------------------------ wiring

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      render();
      scanReplies();
    }, 400);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  D.onChange(schedule);
  try {
    chrome.storage.onChanged.addListener((c) => {
      if (c.reminders) render();
    });
  } catch (_) {
    /* extension reloaded */
  }
  // Opening a conversation changes the URL hash; react to that too, not only to DOM changes.
  window.addEventListener("hashchange", schedule);
  setInterval(scanReplies, 20000);
  schedule();
})();
