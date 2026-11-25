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

  window.__mtData = {
    get emails() {
      return emails;
    },
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
