(function initChatGptSessionRenamer() {
  // Runs in the ChatGPT page. Owns the floating UI, title review modal,
  // conversation extraction, AI title generation, and native ChatGPT rename flow.
  const SETTINGS_KEY = "cso.settings";
  const APP_ID = "chatgpt-session-renamer-root";
  const SESSION_RE = /\/c\/([a-zA-Z0-9-]+)/;
  const BAD_UI_TITLE_RE = /(Extended can make|ChatGPT can make|can make mistakes|Ask anything|Check important info|Create an image|Write or edit|Look something up|Search chats|New chat|Recents)/i;
  const BAD_AI_TITLE_RE = /(AI\s*免责声明|AI\s*免责申明|免责声明|免责申明|作为AI|作为一个AI|无法提供|不能提供|不能替代|consult|disclaimer)/i;

  let settings = {};
  let stopRequested = false;

  const storage = {
    async getSettings() {
      try {
        if (!chrome?.storage?.local) return {};
        const result = await chrome.storage.local.get(SETTINGS_KEY);
        return result[SETTINGS_KEY] || {};
      } catch (error) {
        if (/Extension context invalidated/i.test(error.message || "")) {
          throw new Error("Extension was reloaded. Refresh the ChatGPT page, then open the renamer again.");
        }
        throw error;
      }
    },
    async setSettings(value) {
      try {
        if (!chrome?.storage?.local) return;
        await chrome.storage.local.set({ [SETTINGS_KEY]: value });
      } catch (error) {
        if (/Extension context invalidated/i.test(error.message || "")) {
          throw new Error("Extension was reloaded. Refresh the ChatGPT page, then open the renamer again.");
        }
        throw error;
      }
    }
  };

  function getSessionIdFromUrl(url) {
    return url?.match(SESSION_RE)?.[1] || "";
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function limitText(text, maxChars) {
    const clean = normalizeText(text);
    return clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
  }

  function isBoilerplateText(text) {
    const clean = normalizeText(text);
    return !clean || BAD_UI_TITLE_RE.test(clean) || /^(Skip to content|Chat history|Projects|Library|Apps|More|Share|Thinking|Ready when you are)$/i.test(clean);
  }

  function cleanMessageText(text) {
    return normalizeText(text)
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter((line) => line && !isBoilerplateText(line))
      .join(" ");
  }

  function stripQuestionSentence(text) {
    return normalizeText(text)
      .replace(/^(我想知道|我想问|我应该怎么|我该怎么|怎么|如何|请问|帮我|能不能|可以不可以|是不是|为什么)\s*/i, "")
      .replace(/[？?。.!！]+$/g, "")
      .replace(/^(我|我们|今天|下午|上午|刚才|现在)\s*/i, "");
  }

  function looksLikeSentenceTitle(title) {
    const clean = normalizeText(title);
    return /[？?。.!！]$/.test(clean) ||
      /^(我|我们|今天|下午|上午|刚才|现在|这我|有学习到|我看|我用|不不不|请问|怎么|如何|为什么|能讲解|讲解下|可以讲解|能解释|可以解释)/.test(clean) ||
      /(算什么|是什么|这些内容|知识体系|有些混|有点混|不太懂|看不懂|什么意思)$/.test(clean) ||
      (clean.length > 24 && /[，,。；;？?]/.test(clean));
  }

  function normalizeAiTitle(title) {
    return normalizeText(title)
      .replace(/^(General|Life|Research|Writing|Code|School|生活|研究|写作|代码|学习)\s*[-:：]\s*/i, "")
      .replace(/\s*[-:：]\s*$/, "")
      .slice(0, 60);
  }

  function isBadAiTitle(title) {
    const clean = normalizeText(title);
    return !clean ||
      clean.length < 4 ||
      /[�]{1,}|(\?\?)/.test(clean) ||
      BAD_AI_TITLE_RE.test(clean) ||
      BAD_UI_TITLE_RE.test(clean) ||
      looksLikeSentenceTitle(clean);
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      const match = String(text || "").match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    }
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.click();
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
  }

  function closeOpenMenus() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  }

  function setNativeInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function visibleSidebarSessions() {
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="/c/"]')]
      .map((anchor) => {
        const id = getSessionIdFromUrl(anchor.href || "");
        const title = normalizeText(anchor.getAttribute("aria-label") || anchor.innerText || anchor.textContent);
        return { id, title, url: anchor.href };
      })
      .filter((item) => item.id && item.title && item.title.length < 160 && !seen.has(item.id) && seen.add(item.id));
  }

  function extractConversationText() {
    const roleNodes = [...document.querySelectorAll("[data-message-author-role]")];
    const messageNodes = roleNodes.length ? roleNodes : [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
    const seen = new Set();
    const messages = messageNodes
      .map((node) => ({
        role: node.getAttribute("data-message-author-role") || "",
        text: cleanMessageText(node.innerText || node.textContent || "")
      }))
      .filter((item) => item.text && item.text.length > 8 && !isBoilerplateText(item.text) && !seen.has(item.text) && seen.add(item.text))
      .slice(-14);

    if (messages.length) return messages;

    const fallbackText = (document.querySelector("main")?.innerText || "")
      .split(/\n+/)
      .map((line) => cleanMessageText(line))
      .filter((line) => line && line.length > 8 && !isBoilerplateText(line))
      .slice(-10)
      .join(" ");
    return fallbackText ? [{ role: "", text: fallbackText.slice(0, 1600) }] : [];
  }

  async function openConversation(id, url) {
    if (getSessionIdFromUrl(location.href) === id) return;

    const anchor = [...document.querySelectorAll('a[href*="/c/"]')].find((item) => getSessionIdFromUrl(item.href || "") === id);
    if (anchor) {
      clickElement(anchor);
    } else {
      history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    const started = Date.now();
    while (Date.now() - started < 12000) {
      if (getSessionIdFromUrl(location.href) === id) break;
      await sleep(250);
    }
    await waitForConversationContent();
  }

  async function waitForConversationContent() {
    const started = Date.now();
    while (Date.now() - started < 12000) {
      const messages = extractConversationText();
      const thinking = /thinking|正在|生成中/i.test(document.body.innerText || "");
      if (messages.length && !thinking) return messages;
      await sleep(350);
    }
    return extractConversationText();
  }

  async function requestDeepSeekJson(payload, label) {
    const apiKey = settings.deepseekApiKey;
    if (!apiKey) throw new Error("Add a DeepSeek API key first.");

    const request = async (body) => {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${label} failed: ${response.status} ${text.slice(0, 120)}`);
      }
      return response.json();
    };

    let data = await request(payload);
    let choice = data?.choices?.[0] || {};
    let content = choice.message?.content || "";
    let parsed = content ? safeJsonParse(content) : null;
    if (parsed) return { parsed, content };

    const retryPayload = {
      ...payload,
      messages: [
        ...payload.messages,
        { role: "user", content: "The previous response was empty or invalid. Return ONLY a compact JSON object now. No markdown. No explanation." }
      ],
      max_tokens: Math.max(payload.max_tokens || 120, 700)
    };
    delete retryPayload.response_format;

    data = await request(retryPayload);
    choice = data?.choices?.[0] || {};
    content = choice.message?.content || "";
    parsed = content ? safeJsonParse(content) : null;
    if (!parsed) {
      const finish = choice.finish_reason ? ` finish_reason=${choice.finish_reason}` : "";
      const reason = choice.message?.reasoning_content ? ` reasoning=${String(choice.message.reasoning_content).slice(0, 120)}` : "";
      throw new Error(`${label} returned empty or invalid JSON:${finish}${reason} content=${content.slice(0, 120)}`);
    }
    return { parsed, content };
  }

  function titlePromptMessages(originalTitle, messages, repair = null, options = {}) {
    const messageLimit = options.messageLimit || (repair ? 8 : 4);
    const charLimit = options.charLimit || (repair ? 700 : 500);
    const transcript = messages
      .slice(-messageLimit)
      .map((message, index) => `${index + 1}. ${message.role || "message"}: ${limitText(message.text, charLimit)}`)
      .join("\n");

    const system = [
      "You rename ChatGPT conversations for retrieval.",
      "Return only valid JSON: {\"title\":\"...\"}.",
      "Use Simplified Chinese for common words.",
      "Keep proper nouns, brands, code names, airports, tools, and technical names in English.",
      "Preferred style: specific noun/object prefix, hyphen, compact topic/task.",
      "Good examples: 去水印技巧 - 方法汇总, 加密货币 - 事件提醒, 租车 - Hertz租车指南, Mastercard - 租车保险拒赔, PR - 竖屏剪辑缩放.",
      "Do not use broad prefixes like General, Life, Research, 生活, 研究, 学习.",
      "Do not copy the user's full question. Do not write a sentence, question, or first-person title.",
      "Never use UI boilerplate as a title."
    ].join(" ");

    const user = repair
      ? `Old title: ${originalTitle}\nBad title: ${repair.badTitle}\nProblem: ${repair.reason}\n\nConversation excerpt:\n${transcript}\n\nReturn JSON only.`
      : `Old title: ${originalTitle}\n\nConversation excerpt:\n${transcript}\n\nReturn JSON only.`;

    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }

  async function requestTitleSuggestion(originalTitle, messages, options = {}) {
    const { parsed, content } = await requestDeepSeekJson({
      model: settings.deepseekModel || "deepseek-v4-flash",
      messages: titlePromptMessages(originalTitle, messages, null, options),
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: options.maxTokens || 450,
      stream: false
    }, "DeepSeek title");

    const title = normalizeAiTitle(parsed?.title);
    if (!title) throw new Error(`DeepSeek returned no title: ${content.slice(0, 120)}`);
    if (isBadAiTitle(title)) throw new Error(`DeepSeek returned an unusable title: ${title}`);
    return title;
  }

  async function suggestTitleWithDeepSeek(originalTitle, messages) {
    try {
      return await requestTitleSuggestion(originalTitle, messages, {
        messageLimit: 4,
        charLimit: 500,
        maxTokens: 450
      });
    } catch (error) {
      if (/unusable title/i.test(error.message || "")) throw error;
      return requestTitleSuggestion(originalTitle, messages, {
        messageLimit: 8,
        charLimit: 700,
        maxTokens: 700
      });
    }
  }

  async function repairTitleWithDeepSeek(originalTitle, messages, badTitle, reason) {
    const { parsed, content } = await requestDeepSeekJson({
      model: settings.deepseekModel || "deepseek-v4-flash",
      messages: titlePromptMessages(originalTitle, messages, { badTitle, reason }, {
        messageLimit: 8,
        charLimit: 700
      }),
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 700,
      stream: false
    }, "DeepSeek title repair");

    const title = normalizeAiTitle(parsed?.title);
    if (!title || isBadAiTitle(title)) {
      throw new Error(`DeepSeek title repair returned unusable title: ${title || content.slice(0, 120)}`);
    }
    return title;
  }

  async function generateTitleSuggestion(target) {
    await openConversation(target.id, target.url);
    const messages = await waitForConversationContent();
    if (!messages.length) throw new Error("No conversation text found.");
    if (getSessionIdFromUrl(location.href) !== target.id) {
      throw new Error("Could not open the target conversation before reading content.");
    }

    try {
      return {
        title: await suggestTitleWithDeepSeek(target.title, messages),
        repaired: false
      };
    } catch (error) {
      const repaired = await repairTitleWithDeepSeek(target.title, messages, "No usable title from first pass", error.message || String(error));
      return {
        title: repaired,
        repaired: true,
        repairReason: error.message || String(error)
      };
    }
  }

  async function findConversationOptionsButton(id, timeout = 2500) {
    const started = Date.now();
    const selector = `[data-conversation-options-trigger="${CSS.escape(id)}"]`;

    while (Date.now() - started < timeout) {
      const anchor = [...document.querySelectorAll('a[href*="/c/"]')].find((item) => getSessionIdFromUrl(item.href || "") === id);
      anchor?.scrollIntoView({ block: "center", inline: "nearest" });

      const button = document.querySelector(selector);
      if (button) {
        button.scrollIntoView({ block: "center", inline: "nearest" });
        return button;
      }
      await sleep(150);
    }
    return null;
  }

  async function waitForMenuItemText(text, timeout = 1500) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((candidate) => normalizeText(candidate.textContent) === text);
      if (item) return item;
      await sleep(100);
    }
    return null;
  }

  async function waitForTitleEditor(timeout = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const editor = document.querySelector('input[name="title-editor"], input[aria-label="Chat title"]');
      if (editor) return editor;
      await sleep(100);
    }
    return null;
  }

  async function renameInChatGpt(id, title) {
    const newTitle = normalizeText(title);
    if (!id) throw new Error("Open a saved ChatGPT conversation first.");
    if (!newTitle) throw new Error("Enter a title before renaming.");
    if (isBadAiTitle(newTitle)) throw new Error(`Refused bad title: ${newTitle}`);

    let editor = await waitForTitleEditor(250);
    let lastError = "Could not find ChatGPT's title editor.";

    for (let attempt = 0; attempt < 3 && !editor; attempt += 1) {
      closeOpenMenus();
      await sleep(150);

      const optionsButton = await findConversationOptionsButton(id);
      if (!optionsButton) {
        lastError = "Could not find ChatGPT's conversation options button.";
        continue;
      }

      clickElement(optionsButton);
      const renameItem = await waitForMenuItemText("Rename");
      if (!renameItem) {
        lastError = "Could not find ChatGPT's Rename menu item.";
        continue;
      }

      clickElement(renameItem);
      editor = await waitForTitleEditor(2200);
      if (!editor) lastError = "Could not find ChatGPT's title editor.";
    }

    if (!editor) throw new Error(lastError);

    editor.focus();
    setNativeInputValue(editor, newTitle);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await sleep(900);
    return { id, title: newTitle };
  }

  function createApp() {
    if (document.getElementById(APP_ID)) return;

    const host = document.createElement("div");
    host.id = APP_ID;
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host { color-scheme: light dark; }
        .launcher {
          position: fixed;
          right: 16px;
          bottom: 18px;
          z-index: 2147483647;
          width: 42px;
          height: 42px;
          border: 0;
          border-radius: 8px;
          color: #fff;
          background: #176f5a;
          box-shadow: 0 10px 28px rgba(0,0,0,.2);
          cursor: pointer;
          font: 700 16px/1 system-ui, sans-serif;
        }
        .panel {
          position: fixed;
          right: 16px;
          bottom: 68px;
          z-index: 2147483647;
          width: min(340px, calc(100vw - 32px));
          display: none;
          border: 1px solid rgba(127,127,127,.28);
          border-radius: 8px;
          background: Canvas;
          color: CanvasText;
          box-shadow: 0 22px 60px rgba(0,0,0,.24);
          font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
          overflow: hidden;
        }
        .panel[data-open="true"] { display: block; }
        header {
          padding: 14px 14px 10px;
          background: Canvas;
          border-bottom: 1px solid rgba(127,127,127,.18);
        }
        h2 { margin: 0; font-size: 15px; font-weight: 750; }
        .subtitle { margin-top: 3px; font-size: 12px; }
        main { padding: 12px 14px 14px; display: grid; gap: 10px; }
        details {
          border: 1px solid rgba(127,127,127,.22);
          border-radius: 8px;
          padding: 0;
          overflow: hidden;
        }
        summary {
          padding: 9px 10px;
          cursor: pointer;
          color: color-mix(in srgb, CanvasText 70%, Canvas);
          font-weight: 650;
          list-style-position: inside;
        }
        .settings-body { display: grid; gap: 9px; padding: 0 10px 10px; }
        label { display: grid; gap: 5px; color: color-mix(in srgb, CanvasText 78%, Canvas); font-weight: 650; }
        input {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid rgba(127,127,127,.35);
          border-radius: 6px;
          padding: 8px;
          background: Canvas;
          color: CanvasText;
          font: inherit;
        }
        button {
          border: 1px solid rgba(127,127,127,.32);
          border-radius: 6px;
          padding: 9px 10px;
          background: Canvas;
          color: CanvasText;
          cursor: pointer;
          font: 650 13px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
        }
        .primary { background: #176f5a; border-color: #176f5a; color: white; }
        .secondary { color: color-mix(in srgb, CanvasText 78%, Canvas); }
        .muted { color: color-mix(in srgb, CanvasText 58%, Canvas); }
      </style>
      <button class="launcher" title="ChatGPT Session Renamer">R</button>
      <section class="panel" aria-label="ChatGPT Session Renamer">
        <header>
          <h2>Title Review</h2>
          <div class="muted subtitle">Preview AI titles before applying them.</div>
        </header>
        <main>
          <button class="primary start">Review Titles</button>
          <button class="secondary stop">Stop Current Run</button>
          <details>
            <summary>Settings</summary>
            <div class="settings-body">
              <label>Provider key<input class="deepseek-key" type="password" placeholder="sk-..."></label>
              <label>Model<input class="deepseek-model" placeholder="deepseek-v4-flash"></label>
              <button class="save-settings">Save</button>
            </div>
          </details>
          <div class="muted feedback" role="status"></div>
        </main>
      </section>
    `;

    root.querySelector(".launcher").addEventListener("click", () => {
      const panel = root.querySelector(".panel");
      panel.dataset.open = panel.dataset.open !== "true";
      renderPanel();
    });
    root.querySelector(".save-settings").addEventListener("click", async () => {
      settings = {
        ...settings,
        deepseekApiKey: root.querySelector(".deepseek-key").value.trim(),
        deepseekModel: root.querySelector(".deepseek-model").value.trim() || "deepseek-v4-flash"
      };
      await storage.setSettings(settings);
      root.querySelector(".feedback").textContent = "Settings saved locally.";
    });
    root.querySelector(".start").addEventListener("click", () => launchRenameWorkflow());
    root.querySelector(".stop").addEventListener("click", () => {
      stopRequested = true;
      root.querySelector(".feedback").textContent = "Stop requested. Current step will finish first.";
    });
  }

  function renderPanel() {
    const root = document.getElementById(APP_ID)?.shadowRoot;
    if (!root) return;
    root.querySelector(".deepseek-key").value = settings.deepseekApiKey || "";
    root.querySelector(".deepseek-model").value = settings.deepseekModel || "deepseek-v4-flash";
  }

  function launchRenameWorkflow() {
    const existing = document.getElementById("cso-rename-workflow");
    existing?.remove();

    const targets = visibleSidebarSessions();
    const overlay = document.createElement("div");
    overlay.id = "cso-rename-workflow";
    overlay.innerHTML = `
      <style>
        #cso-rename-workflow {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          background: rgba(15, 18, 20, .42);
          color: CanvasText;
          font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
        }
        #cso-rename-workflow .box {
          width: min(920px, calc(100vw - 32px));
          max-height: min(780px, calc(100vh - 32px));
          display: grid;
          grid-template-rows: auto auto 1fr auto;
          border-radius: 8px;
          border: 1px solid rgba(127,127,127,.3);
          background: Canvas;
          overflow: hidden;
          box-shadow: 0 24px 80px rgba(0,0,0,.28);
        }
        #cso-rename-workflow header, #cso-rename-workflow footer {
          padding: 14px 18px;
          border-bottom: 1px solid rgba(127,127,127,.2);
        }
        #cso-rename-workflow footer {
          border-top: 1px solid rgba(127,127,127,.2);
          border-bottom: 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          background: color-mix(in srgb, CanvasText 3%, Canvas);
        }
        #cso-rename-workflow h2 { margin: 0; font-size: 18px; line-height: 1.2; }
        #cso-rename-workflow .summary { margin-top: 3px; }
        #cso-rename-workflow .tools {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 10px 18px;
          background: color-mix(in srgb, CanvasText 2%, Canvas);
        }
        #cso-rename-workflow .list {
          overflow: auto;
          padding: 10px 18px 14px;
          display: grid;
          gap: 8px;
          align-content: start;
        }
        #cso-rename-workflow .row {
          display: grid;
          grid-template-columns: auto minmax(190px, .95fr) minmax(260px, 1.25fr) minmax(96px, auto);
          gap: 10px;
          align-items: center;
          padding: 10px 12px;
          border: 1px solid rgba(127,127,127,.2);
          border-radius: 8px;
          background: Canvas;
        }
        #cso-rename-workflow .row input[type="checkbox"] {
          width: 18px;
          height: 18px;
          margin: 0;
        }
        #cso-rename-workflow .old {
          min-width: 0;
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #cso-rename-workflow input[type="text"] {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid rgba(127,127,127,.35);
          border-radius: 6px;
          padding: 9px 10px;
          background: color-mix(in srgb, CanvasText 2%, Canvas);
          color: CanvasText;
          font: inherit;
        }
        #cso-rename-workflow input[type="text"]:placeholder-shown {
          color: color-mix(in srgb, CanvasText 45%, Canvas);
        }
        #cso-rename-workflow button {
          border: 1px solid rgba(127,127,127,.35);
          border-radius: 6px;
          padding: 8px 11px;
          background: Canvas;
          color: CanvasText;
          cursor: pointer;
          font: 650 13px/1.2 system-ui, -apple-system, Segoe UI, sans-serif;
        }
        #cso-rename-workflow button:disabled {
          opacity: .55;
          cursor: not-allowed;
        }
        #cso-rename-workflow footer > div { display: flex; gap: 8px; }
        #cso-rename-workflow .primary { background: #176f5a; color: white; border-color: #176f5a; }
        #cso-rename-workflow .status {
          justify-self: end;
          max-width: 160px;
          border-radius: 999px;
          padding: 3px 8px;
          background: color-mix(in srgb, CanvasText 7%, Canvas);
          color: color-mix(in srgb, CanvasText 62%, Canvas);
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #cso-rename-workflow .summary {
          max-width: none;
          padding: 0;
          border-radius: 0;
          background: transparent;
          color: color-mix(in srgb, CanvasText 58%, Canvas);
        }
        #cso-rename-workflow .error { background: #fdecea; color: #a83b32; }
        #cso-rename-workflow .ok { background: #e7f5ef; color: #176f5a; }
      </style>
      <section class="box" role="dialog" aria-modal="true" aria-label="Rename visible sessions">
        <header>
          <h2>Review Titles</h2>
          <div class="status summary"></div>
        </header>
        <div class="tools">
          <button class="select-all">Select all</button>
          <button class="select-none">Clear</button>
          <button class="select-five">First 5</button>
        </div>
        <div class="list"></div>
        <footer>
          <button class="cancel">Close</button>
          <div>
            <button class="generate primary">Generate Preview</button>
            <button class="apply" disabled>Apply Selected</button>
          </div>
        </footer>
      </section>
    `;

    const list = overlay.querySelector(".list");
    if (!targets.length) {
      list.innerHTML = `<p class="status">No visible ChatGPT sessions found. Scroll the sidebar to load more sessions, then try again.</p>`;
    }

    for (const [index, target] of targets.entries()) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.id = target.id;
      row.innerHTML = `
        <input type="checkbox" ${index < 5 ? "checked" : ""}>
        <div class="old"></div>
        <input class="title" type="text" placeholder="Generate preview first">
        <div class="status">Queued</div>
      `;
      row.querySelector(".old").textContent = target.title;
      row._target = target;
      list.append(row);
    }

    const rows = () => [...overlay.querySelectorAll(".row")];
    const selectedRows = () => rows().filter((row) => row.querySelector('input[type="checkbox"]').checked);
    const setSummary = (text) => {
      overlay.querySelector(".summary").textContent = text;
    };
    const setStatus = (row, text, className = "") => {
      const status = row.querySelector(".status");
      status.className = `status ${className}`.trim();
      status.textContent = text;
    };
    const updateCount = () => {
      setSummary(`${selectedRows().length}/${targets.length} selected`);
    };

    overlay.addEventListener("change", updateCount);
    overlay.querySelector(".select-all").addEventListener("click", () => {
      rows().forEach((row) => (row.querySelector('input[type="checkbox"]').checked = true));
      updateCount();
    });
    overlay.querySelector(".select-none").addEventListener("click", () => {
      rows().forEach((row) => (row.querySelector('input[type="checkbox"]').checked = false));
      updateCount();
    });
    overlay.querySelector(".select-five").addEventListener("click", () => {
      rows().forEach((row, index) => (row.querySelector('input[type="checkbox"]').checked = index < 5));
      updateCount();
    });
    overlay.querySelector(".cancel").addEventListener("click", () => overlay.remove());
    overlay.querySelector(".generate").addEventListener("click", async () => {
      await generatePreview(selectedRows(), setSummary, setStatus, overlay);
    });
    overlay.querySelector(".apply").addEventListener("click", async () => {
      await applyPreview(selectedRows(), setSummary, setStatus);
    });

    document.documentElement.append(overlay);
    updateCount();
  }

  async function generatePreview(rows, setSummary, setStatus, overlay) {
    stopRequested = false;
    try {
      settings = await storage.getSettings();
    } catch (error) {
      setSummary(error.message || "Could not read extension settings.");
      return;
    }
    if (!settings.deepseekApiKey) {
      setSummary("Add a DeepSeek API key in the floating panel or extension popup first.");
      return;
    }

    let generated = 0;
    let repaired = 0;
    let skipped = 0;

    for (const [index, row] of rows.entries()) {
      if (stopRequested) {
        setSummary(`Stopped: ${generated}/${rows.length} previews generated.`);
        break;
      }
      const target = row._target;
      setStatus(row, "Reading");
      setSummary(`Reading ${index + 1}/${rows.length}: ${target.title}`);
      try {
        const suggestion = await generateTitleSuggestion(target);
        row.querySelector(".title").value = suggestion.title;
        row.dataset.ready = "true";
        generated += 1;
        if (suggestion.repaired) repaired += 1;
        setStatus(row, suggestion.repaired ? "Repaired" : "Ready", "ok");
      } catch (error) {
        skipped += 1;
        row.dataset.ready = "";
        setStatus(row, error.message || "Skipped", "error");
      }
    }

    overlay.querySelector(".apply").disabled = !rows.some((row) => row.dataset.ready === "true");
    setSummary(`Preview complete: ${generated}/${rows.length} ready${repaired ? `, ${repaired} repaired` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
  }

  async function applyPreview(rows, setSummary, setStatus) {
    stopRequested = false;
    const readyRows = rows.filter((row) => row.dataset.ready === "true" && normalizeText(row.querySelector(".title").value));
    let renamed = 0;
    let failed = 0;

    for (const [index, row] of readyRows.entries()) {
      if (stopRequested) {
        setSummary(`Stopped: ${renamed}/${readyRows.length} renamed.`);
        break;
      }

      const target = row._target;
      const title = normalizeText(row.querySelector(".title").value);
      setStatus(row, "Renaming");
      setSummary(`Renaming ${index + 1}/${readyRows.length}: ${title}`);
      try {
        await openConversation(target.id, target.url);
        await renameInChatGpt(target.id, title);
        renamed += 1;
        setStatus(row, "Renamed", "ok");
      } catch (error) {
        failed += 1;
        setStatus(row, error.message || "Failed", "error");
      }
    }

    setSummary(`Apply complete: ${renamed}/${readyRows.length} renamed${failed ? `, ${failed} failed` : ""}.`);
  }

  async function init() {
    settings = await storage.getSettings();
    createApp();
    renderPanel();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CSR_START_WORKFLOW") {
      launchRenameWorkflow();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "CSR_STOP_RENAME") {
      stopRequested = true;
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "CSR_GET_SETTINGS") {
      storage.getSettings().then((value) => sendResponse({ ok: true, settings: value }));
      return true;
    }
    if (message?.type === "CSR_SAVE_SETTINGS") {
      settings = {
        ...settings,
        deepseekApiKey: normalizeText(message.settings?.deepseekApiKey),
        deepseekModel: normalizeText(message.settings?.deepseekModel) || "deepseek-v4-flash"
      };
      storage.setSettings(settings).then(() => {
        renderPanel();
        sendResponse({ ok: true });
      });
      return true;
    }
    return false;
  });

  init();
})();
