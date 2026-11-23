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
      chrome.storage.local.get(["serverUrl", "apiKey", "owner", "enabled"], (s) => resolve(s || {}))
    );

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
    chrome.runtime.sendMessage({
      type: "register",
      id: result.id,
      owner,
      provider: provider.name,
      subject: provider.subject(root),
      recipients: provider.recipients(root),
    });
    pending.delete(root);
    watchForSent(root, result.id);
  }

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
