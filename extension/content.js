// Content script: detects Send in the compose window, inserts a tracking pixel,
// registers the email with the backend (via the background worker) and reports
// whether the message appears to have left the compose window.

(function () {
  const provider = (window.__MAILTRACK_PROVIDERS__ || []).find((p) => p.matches());
  if (!provider) return;

  const ID_RE = /\/p\/([a-f0-9]{32})\.gif/;
  const handled = new WeakMap(); // compose root -> pixel id (avoid double insertion)
  const pending = new WeakSet();
  const watched = new WeakMap();

  const randomId = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  };

  const getSettings = () =>
    new Promise((resolve) =>
      chrome.storage.local.get(["serverUrl", "apiKey", "owner", "enabled", "autoRemindHours"], (s) => resolve(s || {}))
    );

  // Keep a small local list of recent sends so bounce.js can match delivery-failure
  // notices (which only name the failed address) back to the right tracked email.
  const rememberSend = (entry) => {
    try {
      chrome.storage.local.get(["recent"], (s) => {
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        const recent = ((s && s.recent) || []).filter((r) => r.createdAt > cutoff);
        recent.push(entry);
        chrome.storage.local.set({ recent: recent.slice(-200) });
      });
    } catch (_) {
      /* best effort */
    }
  };

  const findRoot = (target) => {
    try {
      return provider.composeRoots().find((r) => r && r.contains(target)) || null;
    } catch (_) {
      return null;
    }
  };

  const isSendClick = (e) => {
    const btn = e.target.closest && e.target.closest('button, [role="button"], div[data-tooltip]');
    if (!btn) return null;
    const root = findRoot(btn);
    if (!root) return null;
    const send = provider.sendButton(root);
    if (send && (send === btn || send.contains(btn) || btn.contains(send))) return root;
    return null;
  };

  const isSendShortcut = (e) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return null;
    return findRoot(e.target);
  };

  function insertPixel(root, serverUrl) {
    const body = provider.bodyEl(root);
    if (!body) return null;

    // Reuse an existing pixel if this compose already has one.
    const existing = body.querySelector("img[data-mailtrack]");
    if (existing) {
      const m = (existing.getAttribute("src") || "").match(ID_RE);
      return m ? { id: m[1], isNew: false } : null;
    }

    const id = randomId();
    const img = body.ownerDocument.createElement("img");
    img.setAttribute("data-mailtrack", "1");
    img.setAttribute("src", `${serverUrl.replace(/\/+$/, "")}/p/${id}.gif`);
    img.setAttribute("width", "1");
    img.setAttribute("height", "1");
    img.setAttribute("alt", "");
    img.setAttribute("style", "border:0;width:1px;height:1px;");
    body.appendChild(img);
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return { id, isNew: true };
  }

  function watchForSent(root, id) {
    if (watched.get(root) === id) return;
    watched.set(root, id);
    const started = Date.now();
    let lastRootState = true;
    const timer = setInterval(() => {
      const rootStillPresent = root.isConnected && provider.bodyEl(root);
      const gone = !rootStillPresent && lastRootState;
      lastRootState = Boolean(rootStillPresent);
      if (gone) {
        clearInterval(timer);
        watched.delete(root);
        chrome.runtime.sendMessage({ type: "status", id, status: "sent" });
      } else if (Date.now() - started > 20000) {
        clearInterval(timer);
        watched.delete(root);
        chrome.runtime.sendMessage({ type: "status", id, status: "unconfirmed" });
      }
    }, 500);
  }

  async function onSend(root) {
    if (pending.has(root)) return;
    const settings = await getSettings();
    if (settings.enabled === false || !settings.serverUrl || !settings.apiKey) return;
    if (handled.has(root)) {
      // Second send attempt (e.g. after an error): re-watch the same pixel.
      watchForSent(root, handled.get(root));
      return;
    }

    pending.add(root);
    const result = insertPixel(root, settings.serverUrl);
    if (!result) {
      pending.delete(root);
      return;
    }
    handled.set(root, result.id);

    const owner = settings.owner || provider.owner() || "unknown";
    const recipients = provider.recipients(root);
    chrome.runtime.sendMessage({
      type: "register",
      id: result.id,
      owner,
      provider: provider.name,
      subject: provider.subject(root),
      recipients,
    });
    rememberSend({ id: result.id, recipients, createdAt: Date.now(), status: "pending" });

    // Optional automatic "no reply" reminder (Settings), Gmail only.
    if (provider.name === "gmail" && Number(settings.autoRemindHours) > 0) {
      const createdAt = Date.now();
      const subject = provider.subject(root);
      chrome.storage.local.get(["reminders"], (s) => {
        const reminders = (s && s.reminders) || {};
        reminders[result.id] = {
          id: result.id,
          subject,
          recipients,
          createdAt,
          at: createdAt + Number(settings.autoRemindHours) * 3600 * 1000,
          status: "active",
        };
        chrome.storage.local.set({ reminders });
      });
    }
    pending.delete(root);
    watchForSent(root, result.id);
  }

  // While a webmail tab is visible, nudge the background worker every 10 seconds so "your
  // email was opened" notifications arrive quickly (it checks every 30s on its own).
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    try {
      chrome.runtime.sendMessage({ type: "poll" }, () => void chrome.runtime.lastError);
    } catch (_) {
      /* extension was reloaded: refresh this tab */
    }
  }, 10000);

  // Capture phase so we run before the page's own handler sends the message.
  document.addEventListener(
    "click",
    (e) => {
      const root = isSendClick(e);
      if (root) onSend(root);
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      const root = isSendShortcut(e);
      if (root) onSend(root);
    },
    true
  );
})();
