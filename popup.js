// Extension popup controller. Keeps provider settings lightweight and opens
// the full title review workflow inside the active ChatGPT tab.
const SETTINGS_KEY = "cso.settings";

let activeTab;
let settings = {};

function isChatGptUrl(url) {
  return url?.startsWith("https://chatgpt.com/") || url?.startsWith("https://chat.openai.com/");
}

async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] || {};
}

async function saveSettings(nextSettings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
}

function render() {
  document.getElementById("deepseekKey").value = settings.deepseekApiKey || "";
  document.getElementById("deepseekModel").value = settings.deepseekModel || "deepseek-v4-flash";
}

async function init() {
  settings = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (!isChatGptUrl(tab?.url)) {
    document.getElementById("status").textContent = "Open chatgpt.com to rename sessions.";
    document.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    return;
  }

  document.getElementById("status").textContent = "Ready.";
  render();
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  settings = {
    deepseekApiKey: document.getElementById("deepseekKey").value.trim(),
    deepseekModel: document.getElementById("deepseekModel").value.trim() || "deepseek-v4-flash"
  };
  await saveSettings(settings);
  document.getElementById("status").textContent = "Settings saved locally.";
  if (activeTab?.id) {
    await chrome.tabs.sendMessage(activeTab.id, { type: "CSR_SAVE_SETTINGS", settings }).catch(() => {});
  }
});

document.getElementById("startWorkflow").addEventListener("click", async () => {
  if (!activeTab?.id) return;
  document.getElementById("status").textContent = "Opening title review...";
  const response = await chrome.tabs.sendMessage(activeTab.id, { type: "CSR_START_WORKFLOW" }).catch((error) => ({ ok: false, error: error.message }));
  document.getElementById("status").textContent = response?.ok ? "Title review opened in ChatGPT." : response?.error || "Could not open title review.";
});

document.getElementById("stopRename").addEventListener("click", async () => {
  if (!activeTab?.id) return;
  await chrome.tabs.sendMessage(activeTab.id, { type: "CSR_STOP_RENAME" }).catch(() => {});
  document.getElementById("status").textContent = "Stop requested.";
});

init();
