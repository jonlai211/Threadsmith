// Extension popup controller. Stores provider settings, requests host access
// for custom endpoints, and opens the title review workflow in the ChatGPT tab.
const { config } = window.Threadsmith;

let activeTab;
let settings = config.normalizeSettings(null);

function $(id) {
  return document.getElementById(id);
}

function isChatGptUrl(url) {
  return url?.startsWith("https://chatgpt.com/") || url?.startsWith("https://chat.openai.com/");
}

function populateProviders() {
  const select = $("providerSelect");
  if (select.options.length) return;
  for (const [id, preset] of Object.entries(config.PROVIDERS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = preset.label;
    select.append(option);
  }
}

function fillFields() {
  const id = $("providerSelect").value || settings.providerId;
  const preset = config.PROVIDERS[id] || config.PROVIDERS[config.DEFAULT_PROVIDER_ID];
  const cfg = (settings.providers && settings.providers[id]) || {};
  $("providerKey").value = cfg.apiKey || "";
  $("providerModel").value = cfg.model || preset.defaultModel || "";
  $("providerModel").placeholder = preset.defaultModel || "model";
  $("providerBaseUrl").value = cfg.baseURL || preset.baseURL || "";
  $("baseUrlRow").style.display = preset.custom ? "grid" : "none";
}

function render() {
  populateProviders();
  $("providerSelect").value = settings.providerId || config.DEFAULT_PROVIDER_ID;
  $("languageSelect").value = settings.titleLanguage || "auto";
  fillFields();
}

async function ensureHostPermission(baseURL) {
  try {
    const origin = `${new URL(baseURL).origin}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

async function init() {
  settings = await config.loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  render();

  if (!isChatGptUrl(tab?.url)) {
    $("status").textContent = "Open chatgpt.com to rename sessions.";
    $("startWorkflow").disabled = true;
    $("stopRename").disabled = true;
    return;
  }
  $("status").textContent = "Ready.";
}

$("providerSelect").addEventListener("change", fillFields);

$("saveSettings").addEventListener("click", async () => {
  const id = $("providerSelect").value;
  const preset = config.PROVIDERS[id] || config.PROVIDERS[config.DEFAULT_PROVIDER_ID];
  const baseURL = $("providerBaseUrl").value.trim() || preset.baseURL || "";
  const next = {
    ...settings,
    providerId: id,
    titleLanguage: $("languageSelect").value || "auto",
    providers: {
      ...settings.providers,
      [id]: {
        apiKey: $("providerKey").value.trim(),
        model: $("providerModel").value.trim() || preset.defaultModel || "",
        baseURL
      }
    }
  };
  settings = await config.saveSettings(next);

  if (preset.custom && baseURL) {
    const granted = await ensureHostPermission(baseURL);
    $("status").textContent = granted
      ? "Settings saved."
      : "Saved, but host access was denied for the custom endpoint.";
  } else {
    $("status").textContent = "Settings saved locally.";
  }

  if (activeTab?.id) {
    chrome.tabs.sendMessage(activeTab.id, { type: "TS_SETTINGS_UPDATED" }).catch(() => {});
  }
});

$("startWorkflow").addEventListener("click", async () => {
  if (!activeTab?.id) return;
  $("status").textContent = "Opening title review...";
  const response = await chrome.tabs
    .sendMessage(activeTab.id, { type: "TS_START_WORKFLOW" })
    .catch((error) => ({ ok: false, error: error.message }));
  $("status").textContent = response?.ok ? "Title review opened in ChatGPT." : (response?.error || "Could not open title review.");
});

$("stopRename").addEventListener("click", async () => {
  if (!activeTab?.id) return;
  await chrome.tabs.sendMessage(activeTab.id, { type: "TS_STOP" }).catch(() => {});
  $("status").textContent = "Stop requested.";
});

init();
