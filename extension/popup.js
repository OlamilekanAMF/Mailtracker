const list = document.getElementById("list");
const msg = document.getElementById("msg");
const allBox = document.getElementById("all");
const search = document.getElementById("search");
const refresh = document.getElementById("refresh");
let allEmails = [];
let activeFilter = "all";

const fmtRelative = (t) => {
  if (!t) return "";
  const diff = Date.now() - t;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
};

const fmtOpenTime = (t) =>
  t
    ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

function badge(text, cls) {
  const element = document.createElement("span");
  element.className = `badge ${cls}`;
  const dot = document.createElement("span");
  dot.className = "badge-dot";
  element.append(dot, document.createTextNode(text));
  return element;
}

function matchesFilter(email) {
  if (activeFilter === "read") return email.opens > 0;
  if (activeFilter === "unread") return email.status === "sent" && email.opens === 0;
  if (activeFilter === "sent") return email.status === "sent";
  if (activeFilter === "pending") return email.status === "pending" || email.status === "unconfirmed";
  return true;
}

function updateSummary(emails) {
  const sent = emails.filter((email) => email.status === "sent");
  const read = sent.filter((email) => email.opens > 0).length;
  document.getElementById("totalCount").textContent = emails.length;
  document.getElementById("readCount").textContent = read;
  document.getElementById("openRate").textContent =
    sent.length ? `${Math.round((read / sent.length) * 100)}%` : "0%";
}

function render(emails) {
  allEmails = emails;
  updateSummary(emails);
  const query = search.value.trim().toLowerCase();
  const filtered = emails.filter((email) => {
    if (!matchesFilter(email)) return false;
    if (!query) return true;
    return [email.subject, email.provider, ...(email.recipients || [])]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  list.textContent = "";
  msg.style.display = filtered.length ? "none" : "block";
  if (!filtered.length) {
    msg.textContent = emails.length
      ? "No emails match this view."
      : "No tracked emails yet. Send an email from Gmail, Outlook, Zoho or Yahoo.";
  }

  for (const email of filtered) {
    const row = document.createElement("div");
    row.className = "row";

    const provider = (email.provider || "unknown").toLowerCase();
    const avatar = document.createElement("div");
    avatar.className = `avatar ${provider}`;
    avatar.textContent = provider === "outlook" ? "OL" : provider.slice(0, 2);

    const content = document.createElement("div");
    content.className = "content";

    const top = document.createElement("div");
    top.className = "row-top";
    const subject = document.createElement("div");
    subject.className = "subj";
    subject.textContent = email.subject || "(no subject)";
    const time = document.createElement("div");
    time.className = "time";
    time.textContent = fmtRelative(email.sentAt || email.createdAt);
    top.append(subject, time);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `To ${(email.recipients || []).join(", ") || "unknown"}`;

    const badges = document.createElement("div");
    badges.className = "badges";
    if (email.status === "sent") badges.append(badge("Sent", "sent"));
    else if (email.status === "unconfirmed") badges.append(badge("Send not confirmed", "warn"));
    else if (email.status === "failed") badges.append(badge("Failed", "failed"));
    else badges.append(badge("Pending", "pending"));

    if (email.opens > 0) {
      badges.append(badge(`Read · ${email.opens} open${email.opens > 1 ? "s" : ""}`, "read"));
      if (email.firstOpenedAt) badges.append(badge(`First opened ${fmtOpenTime(email.firstOpenedAt)}`, "read"));
    } else if (email.status === "sent") {
      badges.append(badge(email.prefetchHits ? "Unread (only auto-loads)" : "Unread", "unread"));
    }

    content.append(top, meta, badges);
    row.append(avatar, content);
    list.append(row);
  }
}

function load() {
  refresh.classList.add("loading");
  msg.style.display = "block";
  msg.textContent = "Loading…";
  list.textContent = "";
  chrome.runtime.sendMessage({ type: "list", all: allBox.checked }, (res) => {
    refresh.classList.remove("loading");
    if (!res || !res.ok) {
      msg.textContent = (res && res.error) || "Could not reach the backend. Check Settings.";
      list.textContent = "";
      return;
    }
    render(res.data.emails);
  });
}

document.getElementById("refresh").onclick = load;
allBox.onchange = load;
document.getElementById("opts").onclick = (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
};
search.oninput = () => render(allEmails);
document.querySelectorAll(".filter").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    activeFilter = button.dataset.filter;
    render(allEmails);
  };
});
load();
