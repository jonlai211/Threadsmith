// Shared provider presets, settings schema, and transport resolution.
// Loaded in the content-script world and in the popup. No DOM dependencies
// beyond chrome.storage.local, so it is safe to reuse in both contexts.
(function () {
  const NS = (window.Threadsmith = window.Threadsmith || {});

  const SETTINGS_KEY = "threadsmith.settings";
  const LEGACY_SETTINGS_KEY = "cso.settings";
  const DEFAULT_PROVIDER_ID = "deepseek";

  // Every preset speaks the OpenAI-compatible /chat/completions shape, so the
  // transport layer in the service worker stays provider-agnostic.
  const PROVIDERS = {
    deepseek: {
      label: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      supportsJsonMode: true,
      custom: false
    },
    openai: {
      label: "OpenAI",
      baseURL: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-mini",
      supportsJsonMode: true,
      custom: false
    },
    openrouter: {
      label: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      defaultModel: "deepseek/deepseek-chat",
      supportsJsonMode: true,
      custom: false
    },
    custom: {
      label: "Custom (OpenAI-compatible)",
      baseURL: "",
      defaultModel: "",
      supportsJsonMode: true,
      custom: true
    }
  };

  function emptyProviderConfigs() {
    const out = {};
    for (const [id, preset] of Object.entries(PROVIDERS)) {
      out[id] = {
        apiKey: "",
        model: preset.defaultModel || "",
        baseURL: preset.baseURL || ""
      };
    }
    return out;
  }

  // Accepts either the current schema, the legacy { deepseekApiKey } schema, or
  // nothing, and always returns a fully-formed settings object.
  function normalizeSettings(raw) {
    const settings = {
      providerId: DEFAULT_PROVIDER_ID,
      providers: emptyProviderConfigs(),
      titleLanguage: "auto"
    };
    if (!raw || typeof raw !== "object") return settings;

    // Current schema.
    if (raw.providers && typeof raw.providers === "object") {
      if (raw.providerId && PROVIDERS[raw.providerId]) settings.providerId = raw.providerId;
      for (const id of Object.keys(settings.providers)) {
        const cfg = raw.providers[id] || {};
        settings.providers[id] = {
          apiKey: String(cfg.apiKey || "").trim(),
          model: String(cfg.model || PROVIDERS[id].defaultModel || "").trim(),
          baseURL: String(cfg.baseURL || PROVIDERS[id].baseURL || "").trim()
        };
      }
      if (raw.titleLanguage) settings.titleLanguage = raw.titleLanguage;
      return settings;
    }

    // Legacy schema { deepseekApiKey, deepseekModel }.
    if (raw.deepseekApiKey || raw.deepseekModel) {
      settings.providerId = "deepseek";
      settings.providers.deepseek.apiKey = String(raw.deepseekApiKey || "").trim();
      settings.providers.deepseek.model =
        String(raw.deepseekModel || PROVIDERS.deepseek.defaultModel).trim();
    }
    return settings;
  }

  // Collapses settings + preset into the concrete transport the worker needs.
  function resolveTransport(settings) {
    const id = (settings && settings.providerId) || DEFAULT_PROVIDER_ID;
    const preset = PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER_ID];
    const cfg = (settings && settings.providers && settings.providers[id]) || {};
    return {
      id,
      label: preset.label,
      baseURL: String(cfg.baseURL || preset.baseURL || "").trim().replace(/\/+$/, ""),
      apiKey: String(cfg.apiKey || "").trim(),
      model: String(cfg.model || preset.defaultModel || "").trim(),
      jsonMode: preset.supportsJsonMode !== false
    };
  }

  function friendlyStorageError(error) {
    if (/Extension context invalidated/i.test(error?.message || "")) {
      return new Error("Extension was reloaded. Refresh the ChatGPT page, then open Threadsmith again.");
    }
    return error;
  }

  async function loadSettings() {
    try {
      if (!chrome?.storage?.local) return normalizeSettings(null);
      const result = await chrome.storage.local.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY]);
      if (result[SETTINGS_KEY]) return normalizeSettings(result[SETTINGS_KEY]);

      // One-time migration from the legacy key, then clean it up.
      if (result[LEGACY_SETTINGS_KEY]) {
        const migrated = normalizeSettings(result[LEGACY_SETTINGS_KEY]);
        await chrome.storage.local.set({ [SETTINGS_KEY]: migrated });
        await chrome.storage.local.remove(LEGACY_SETTINGS_KEY);
        return migrated;
      }
      return normalizeSettings(null);
    } catch (error) {
      throw friendlyStorageError(error);
    }
  }

  async function saveSettings(settings) {
    try {
      const normalized = normalizeSettings(settings);
      if (chrome?.storage?.local) {
        await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
      }
      return normalized;
    } catch (error) {
      throw friendlyStorageError(error);
    }
  }

  NS.config = {
    PROVIDERS,
    DEFAULT_PROVIDER_ID,
    SETTINGS_KEY,
    LEGACY_SETTINGS_KEY,
    normalizeSettings,
    resolveTransport,
    loadSettings,
    saveSettings
  };
})();
