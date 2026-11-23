// Per-provider adapters. Webmail DOMs change often: if tracking stops working on a
// provider, this is the ONLY file you should need to fix (update the selectors).
//
// Each adapter answers:
//   matches()              -> is this page this provider?
//   composeRoots()         -> all open compose containers
//   sendButton(root)       -> the Send button inside a compose container (or null)
//   bodyEl(root)           -> the editable body element (or null)
//   subject(root)          -> subject text
//   recipients(root)       -> array of recipient addresses
//   owner()                -> the signed-in address, if discoverable (best effort)

(function () {
  const q = (root, sel) => (root ? root.querySelector(sel) : null);
  const qa = (root, sel) => (root ? Array.from(root.querySelectorAll(sel)) : []);
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const emailsIn = (text) => Array.from(new Set((text || "").match(EMAIL_RE) || []));
  const textIsSend = (element) => /^send(\s+now)?$/i.test((element?.textContent || "").trim());

  const gmail = {
    name: "gmail",
    matches: () => location.hostname === "mail.google.com",
    composeRoots: () => qa(document, 'div[role="dialog"]').filter((d) => q(d, 'div[aria-label="Message Body"]')),
    sendButton: (root) =>
      q(root, 'div[role="button"][data-tooltip^="Send"]') ||
      q(root, 'div[role="button"][aria-label^="Send"]') ||
      Array.from(root.querySelectorAll("div[role='button'], button")).find(textIsSend),
    bodyEl: (root) => q(root, 'div[aria-label="Message Body"][contenteditable="true"]'),
    subject: (root) => (q(root, 'input[name="subjectbox"]') || {}).value || "",
    recipients: (root) => {
      const spans = qa(root, "span[email]").map((s) => s.getAttribute("email"));
      const inputs = qa(root, 'input[name="to"], input[name="cc"], input[name="bcc"]').map((i) => i.value);
      return Array.from(new Set([...spans, ...inputs.flatMap(emailsIn)]));
    },
    owner: () => {
      const a = q(document, 'a[aria-label*="Google Account"]');
      return a ? emailsIn(a.getAttribute("aria-label"))[0] : null;
    },
  };

  const outlook = {
    name: "outlook",
    matches: () => /(^|\.)outlook\.(live|office|office365)\.com$/.test(location.hostname),
    composeRoots: () => {
      // Compose pane or pop-out: find the body textbox and walk up to a stable container.
      return qa(document, 'div[role="textbox"][aria-label^="Message body"]').map(
        (b) => b.closest('div[role="main"], div[role="dialog"], form') || b.parentElement.parentElement.parentElement
      );
    },
    sendButton: (root) =>
      q(root, 'button[aria-label="Send"]') ||
      q(root, 'button[title="Send"]') ||
      q(document, 'button[aria-label="Send"]') ||
      Array.from(root.querySelectorAll("button, [role='button']")).find(
        (button) =>
          textIsSend(button) ||
          /^send$/i.test((button.getAttribute("aria-label") || "").trim()) ||
          /^send$/i.test((button.getAttribute("title") || "").trim())
      ),
    bodyEl: (root) => q(root, 'div[role="textbox"][aria-label^="Message body"]'),
    subject: (root) =>
      (q(root, 'input[aria-label="Add a subject"]') || q(root, 'input[placeholder="Add a subject"]') || {}).value || "",
    recipients: (root) => {
      const wells = qa(root, 'div[aria-label="To"], div[aria-label="Cc"], div[aria-label="Bcc"]');
      return Array.from(new Set(wells.flatMap((w) => emailsIn(w.textContent + " " + (w.getAttribute("title") || "")))));
    },
    owner: () => {
      const b = q(document, '#O365_MainLink_Me, button[aria-label^="Account manager"]');
      return b ? emailsIn(b.getAttribute("aria-label") || b.textContent)[0] : null;
    },
  };

  const zoho = {
    name: "zoho",
    matches: () => /(^|\.)mail\.zoho\./.test(location.hostname),
    // Zoho often renders the editor inside an iframe; we handle both cases.
    composeRoots: () =>
      qa(document, '.zmComposeWrap, .zmCompose, [id^="composeContainer"], .composeWrapper').filter(Boolean),
    sendButton: (root) =>
      q(root, 'button[data-zm-action="send"], [data-action="send"], .zmSendBtn, button[title="Send"]') ||
      qa(root, "button, div[role='button']").find((b) => /^send$/i.test((b.textContent || "").trim())) ||
      qa(root, "button, div[role='button']").find((b) =>
        /send/i.test((b.getAttribute("title") || "") + " " + (b.getAttribute("aria-label") || "") +
          " " + (b.getAttribute("data-action") || ""))
      ) ||
      null,
    bodyEl: (root) => {
      const iframe = q(root, "iframe.ze_area, iframe[id^='ze_'], iframe.zmEditor, iframe");
      if (iframe && iframe.contentDocument && iframe.contentDocument.body) return iframe.contentDocument.body;
      return q(root, '[contenteditable="true"]');
    },
    subject: (root) => (q(root, 'input[name="subject"], input[id*="subject" i], input[placeholder*="Subject" i]') || {}).value || "",
    recipients: (root) =>
      Array.from(
        new Set(
          qa(root, '[data-zm-email], .zmEmailChip, .zmRcpt, [class*="recipient" i]').flatMap((e) =>
            emailsIn((e.getAttribute("data-zm-email") || "") + " " + (e.getAttribute("title") || "") + " " + e.textContent)
          )
        )
      ),
    owner: () => {
      const el = q(document, '[class*="profile" i][title*="@"], [title*="@"][class*="user" i]');
      return el ? emailsIn(el.getAttribute("title"))[0] : null;
    },
  };

  const yahoo = {
    name: "yahoo",
    matches: () => location.hostname === "mail.yahoo.com",
    composeRoots: () =>
      qa(document, '[data-test-id="compose-modal"], [data-test-id="compose"], div[role="dialog"]').filter((d) =>
        q(d, '[data-test-id="rte"], [contenteditable="true"]')
      ),
    sendButton: (root) =>
      q(root, 'button[data-test-id="compose-send-button"]') ||
      q(root, 'button[title="Send"], button[aria-label="Send"]') ||
      Array.from(root.querySelectorAll("button, [role='button']")).find(
        (button) =>
          textIsSend(button) ||
          /^send$/i.test((button.getAttribute("aria-label") || "").trim()) ||
          /^send$/i.test((button.getAttribute("title") || "").trim())
      ),
    bodyEl: (root) => q(root, '[data-test-id="rte"], div[contenteditable="true"]'),
    subject: (root) => (q(root, 'input[data-test-id="compose-subject"], input[placeholder="Subject"]') || {}).value || "",
    recipients: (root) =>
      Array.from(
        new Set(
          qa(root, '[data-test-id="pill"], [data-test-id="to-field"], [data-test-id="cc-field"]').flatMap((e) =>
            emailsIn(e.getAttribute("title") || e.textContent)
          )
        )
      ),
    owner: () => {
      const el = q(document, '[data-test-id="account-switcher"], [aria-label*="Account"]');
      return el ? emailsIn(el.getAttribute("aria-label") || el.textContent)[0] : null;
    },
  };

  window.__MAILTRACK_PROVIDERS__ = [gmail, outlook, zoho, yahoo];
})();
