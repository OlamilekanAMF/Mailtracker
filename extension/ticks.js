// Delivery ticks in the Gmail message list (Sent view):
//   grey check = sent, green double check = read, red cross = bounced.
// Rows are matched to tracked emails by subject + recipient + time. If ticks land in the
// wrong place after a Gmail redesign, the only things to adjust are the selectors in
// rowInfo() and the insertion point in apply().

(function () {
  const D = window.__mtData;
  if (!D) return;

  const NS = "http://www.w3.org/2000/svg";
  const COLORS = { read: "#1a9e6b", sent: "#9aa0a6", pending: "#c4c7c5", bounced: "#d93025" };
  const PATHS = {
    read: ["M1.5 12.5l4.5 4.5L15.5 8", "M9.5 16.5l1.5 1.5L22 7"],
    sent: ["M5 12.5l4.5 4.5L19 7"],
    pending: ["M5 12.5l4.5 4.5L19 7"],
    bounced: ["M6 6l12 12", "M18 6L6 18"],
  };

  const style = document.createElement("style");
  style.textContent =
    ".mt-tick{display:inline-flex;align-items:center;vertical-align:middle;margin-right:6px;line-height:0}" +
    ".mt-tick svg{width:18px;height:18px}";
  document.documentElement.appendChild(style);

  const fmt = (t) =>
    t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

  function stateOf(e) {
    if (e.status === "bounced" || e.status === "failed") return "bounced";
    if (e.opens > 0) return "read";
    if (e.status === "sent") return "sent";
    return "pending";
  }

  function titleOf(e) {
    const s = stateOf(e);
    if (s === "bounced") return "Not delivered (bounced)";
    if (s === "read") return `Read${e.opens > 1 ? ` ${e.opens} times` : ""} · first opened ${fmt(e.firstOpenedAt)}`;
    if (s === "sent") return "Sent, not opened yet";
    return e.status === "unconfirmed" ? "Send not confirmed" : "Sending…";
  }

  function svgFor(state) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", COLORS[state]);
    svg.setAttribute("stroke-width", "2.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    for (const d of PATHS[state]) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  // Only rows of the Sent view are handled: they start with "To: ...".
  function rowInfo(row) {
    const who = row.querySelector("td.yX");
    if (!who || !/^to\s*:/i.test(who.textContent.trim())) return null;
    const subjEl = row.querySelector("span.bog") || row.querySelector("td.xY .y6 span");
    const recipients = Array.from(who.querySelectorAll("[email]"))
      .map((n) => (n.getAttribute("email") || "").toLowerCase())
      .filter(Boolean);
    const timeEl = row.querySelector("td.xW [title]");
    return {
      subject: subjEl ? subjEl.textContent : "",
      recipients,
      time: timeEl ? D.parseTime(timeEl.getAttribute("title")) : null,
    };
  }

  function match(info) {
    const subj = D.norm(info.subject);
    let best = null;
    for (const e of D.mine()) {
      if (D.norm(e.subject) !== subj) continue;
      if (
        info.recipients.length &&
        !(e.recipients || []).some((r) => info.recipients.includes(String(r).toLowerCase()))
      )
        continue;
      const t = e.sentAt || e.createdAt;
      if (info.time && t > info.time + 2 * 60 * 1000) continue; // the email can't be newer than its row
      if (!best || t > (best.sentAt || best.createdAt)) best = e;
    }
    return best;
  }

  function apply() {
    document.querySelectorAll("tr.zA").forEach((row) => {
      const existing = row.querySelector(".mt-tick");
      const info = rowInfo(row);
      const host = row.querySelector("td.yX div.yW") || row.querySelector("td.yX");
      const e = info && host ? match(info) : null;
      if (!e) {
        if (existing) existing.remove();
        return;
      }
      const state = stateOf(e);
      const key = state + "|" + titleOf(e);
      if (existing && existing.dataset.mt === key) return;
      const el = existing || document.createElement("span");
      el.className = "mt-tick";
      el.dataset.mt = key;
      el.title = titleOf(e);
      el.textContent = "";
      el.appendChild(svgFor(state));
      if (!existing) host.insertBefore(el, host.firstChild);
    });
  }

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 300);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  D.onChange(schedule);
  schedule();
})();
