const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["serverUrl", "apiKey", "owner", "enabled"], (s) => {
  $("serverUrl").value = s.serverUrl || "";
  $("apiKey").value = s.apiKey || "";
  $("owner").value = s.owner || "";
  $("enabled").checked = s.enabled !== false;
});

$("save").onclick = () => {
  chrome.storage.local.set(
    {
      serverUrl: $("serverUrl").value.trim(),
      apiKey: $("apiKey").value.trim(),
      owner: $("owner").value.trim(),
      enabled: $("enabled").checked,
    },
    () => {
      $("err").textContent = "";
      $("status").textContent = "Saved.";
      setTimeout(() => ($("status").textContent = ""), 2000);
    }
  );
};

$("test").onclick = () => {
  // Save first so the background worker uses the current values.
  chrome.storage.local.set(
    { serverUrl: $("serverUrl").value.trim(), apiKey: $("apiKey").value.trim() },
    () => {
      chrome.runtime.sendMessage({ type: "list", all: true }, (res) => {
        if (res && res.ok) {
          $("err").textContent = "";
          $("status").textContent = "Connected. Backend and API key work.";
        } else {
          $("status").textContent = "";
          $("err").textContent = (res && res.error) || "Could not connect.";
        }
      });
    }
  );
};
