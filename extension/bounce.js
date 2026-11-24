// Bounce detection. A mail provider accepts a message first and only then sends back a
// "Delivery Status Notification" if the address does not exist. This script watches the
// webmail page for such notices and marks the matching tracked email as Bounced.
//
// It only works while a webmail tab is open (it reads what is on screen). Selectors for
// Gmail are the most reliable; the others are best effort. Adjust SELECTORS if a provider
// changes its page structure.

(function () {
  const provider = (window.__MAILTRACK_PROVIDERS__ || []).find((p) => p.matches());
  if (!provider) return;

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const SENDER_RE = /mail delivery subsystem|mailer-daemon|postmaster|mail delivery system|microsoft outlook/i;
  const BOUNCE_RE =
    /delivery status notification|undeliverable|address not found|delivery has failed|wasn'?t delivered|couldn'?t be delivered|message not delivered|delivery failure|returned mail|failure notice|not delivered/i;
  const IGNORE_ADDR_RE = /^(mailer-daemon|postmaster|no-?reply)@/i;

  // Elements that each hold ONE message (a list row or an opened message), never a whole page.
  const SELECTORS = {
    gmail: ["tr.zA", "div.adn"],
    outlook: ['div[role="option"]', 'div[id^="UniqueMessageBody"]'],
    zoho: [".zmLItem", ".zmListItem", 'li[class*="zmLItem"]', 'div[class*="mailListItem"]'],
    yahoo: ['[data-test-id="message-list-item"]', 'li[data-test-id="virtual-list-item"]'],
  }[provider.name] || [];
  if (!SELECTORS.length) return;

  const WEEK = 7 * 24 * 3600 * 1000;
  const storageGet = (keys) => new Promise((res) => chrome.storage.local.get(keys, (s) => res(s || {})));
  const storageSet = (obj) => new Promise((res) => chrome.storage.local.set(obj, res));

  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  };

  const textOf = (el) => ((el.getAttribute("aria-label") || "") + " " + (el.textContent || "")).slice(0, 4000);

  // Best effort: the time the notice arrived, from a title="..." attribute such as
  // "Tue, Nov 24, 2026, 4:59 AM". Returns null if none can be parsed.
  function noticeTime(el) {
    let best = null;
    for (const node of el.querySelectorAll("[title]")) {
      const t = Date.parse(node.getAttribute("title"));
      if (!isNaN(t) && t > Date.UTC(2020, 0, 1) && (best === null || t > best)) best = t;
    }
    return best;
  }

  async function markBounced(id) {
    // Re-read right before writing so we don't overwrite a send registered meanwhile.
    const { recent = [] } = await storageGet(["recent"]);
    const entry = recent.find((r) => r.id === id);
    if (entry) entry.status = "bounced";
    await storageSet({ recent });
    chrome.runtime.sendMessage({ type: "status", id, status: "bounced" });
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const { enabled, recent = [], handled = {}, owner } = await storageGet(["enabled", "recent", "handled", "owner"]);
      if (enabled === false || !recent.length) return;

      const now = Date.now();
      const candidates = recent.filter((r) => now - r.createdAt < WEEK && r.status !== "bounced");
      if (!candidates.length) return;

      let changed = false;
      const nodes = document.querySelectorAll(SELECTORS.join(","));
      for (const node of nodes) {
        const text = textOf(node);
        if (!SENDER_RE.test(text) || !BOUNCE_RE.test(text)) continue;

        const key = hash(text.replace(/\s+/g, " ").slice(0, 400));
        if (handled[key]) continue;

        const addrs = Array.from(new Set((text.match(EMAIL_RE) || []).map((a) => a.toLowerCase())))
          .filter((a) => !IGNORE_ADDR_RE.test(a) && a !== (owner || "").toLowerCase());
        if (!addrs.length) continue;

        const arrived = noticeTime(node);
        const match = candidates
          .filter((r) => !r.bounced && (r.recipients || []).some((x) => addrs.includes(String(x).toLowerCase())))
          // A notice that arrived before the email was sent cannot be about it.
          .filter((r) => arrived === null || arrived >= r.createdAt - 60 * 1000)
          .sort((a, b) => b.createdAt - a.createdAt)[0];

        handled[key] = now;
        changed = true;
        if (match) {
          match.bounced = true; // local guard for the rest of this scan
          await markBounced(match.id);
        }
      }

      if (changed) {
        // Keep the handled-notices map from growing forever.
        const keys = Object.keys(handled);
        if (keys.length > 300) keys.sort((a, b) => handled[a] - handled[b]).slice(0, keys.length - 300).forEach((k) => delete handled[k]);
        await storageSet({ handled });
      }
    } catch (_) {
      /* best effort */
    } finally {
      scanning = false;
    }
  }

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 3000);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  setInterval(scan, 20000);
  schedule();
})();
