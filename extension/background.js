// Background service worker: talks to the backend on behalf of content scripts
// (avoids mixed-content / CORS problems on the webmail pages).

async function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get(["serverUrl", "apiKey", "owner"], (s) => resolve(s || {}))
  );
}

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
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async response
});
