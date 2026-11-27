// Shared data for the Gmail content scripts (ticks.js, reminders.js): the user's tracked
// emails, refreshed regularly, plus a few helpers. Gmail only.

(function () {
  const provider = (window.__MAILTRACK_PROVIDERS__ || []).find((p) => p.matches());
  if (!provider || provider.name !== "gmail") return;

  let emails = [];
  const listeners = new Set();
  let loading = false;

  const send = (msg, cb) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        if (cb) cb(res);
      });
    } catch (_) {
      if (cb) cb(null); // extension was reloaded: this page needs a refresh
    }
  };

  function load() {
    if (loading) return;
    loading = true;
    send({ type: "list" }, (res) => {
      loading = false;
      if (!res || !res.ok || !res.data) return;
      emails = res.data.emails || [];
      listeners.forEach((f) => {
        try {
          f(emails);
        } catch (_) {
          /* ignore listener errors */
        }
      });
    });
  }

  // Compare subjects ignoring "Re:" / "Fwd:" prefixes, case and spacing.
  // Gmail displays "(no subject)" for an empty subject.
  const norm = (s) => {
    const n = String(s || "")
      .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return n === "(no subject)" ? "" : n;
  };

  // Gmail puts full dates in title="Tue, Nov 24, 2026, 4:59 AM".
  const parseTime = (s) => {
    const t = Date.parse(s);
    return isNaN(t) || t < Date.UTC(2020, 0, 1) ? null : t;
  };

  // The Google account this tab is signed in to, read from the page title
  // ("Inbox (2) - you@gmail.com - Gmail") or the account button. "" if unknown.
  const EMAIL = "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}";
  function account() {
    const t = document.title.match(new RegExp("-\\s*(" + EMAIL + ")\\s*-\\s*[^-]+$", "i"));
    if (t) return t[1].toLowerCase();
    const el = document.querySelector('a[aria-label*="Google Account"], button[aria-label*="Google Account"]');
    const m = el && (el.getAttribute("aria-label") || "").match(new RegExp(EMAIL, "i"));
    return m ? m[0].toLowerCase() : "";
  }

  // Tracked emails that belong to the account open in THIS tab. With several Google accounts
  // in one browser, another account's tab (for example the recipient's) is not the sender's
  // mailbox and must not be treated as such.
  const mine = () => {
    const a = account();
    return a ? emails.filter((e) => String(e.owner || "").trim().toLowerCase() === a) : emails;
  };

  window.__mtData = {
    get emails() {
      return emails;
    },
    account,
    mine,
    onChange: (f) => listeners.add(f),
    refresh: load,
    send,
    norm,
    parseTime,
  };

  load();
  setInterval(() => {
    if (document.visibilityState === "visible") load();
  }, 15000);
})();
