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
        :host {
          --bg:      rgba(13,15,23,.94);
          --bg-h:    rgba(255,255,255,.04);
          --bg-s:    rgba(255,255,255,.025);
          --bg-i:    rgba(255,255,255,.04);
          --bd:      rgba(255,255,255,.08);
          --bd-s:    rgba(255,255,255,.06);
          --text:    #e2e8f0;
          --text2:   #94a3b8;
          --text3:   #475569;
          --bb:      rgba(255,255,255,.09);
          --bbg:     rgba(255,255,255,.05);
          --bc:      #94a3b8;
          --bbgh:    rgba(255,255,255,.09);
          --bch:     #cbd5e1;
          --shadow:  0 24px 64px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.04);
          --ph:      #2d3748;
        }
        @media (prefers-color-scheme: light) {
          :host {
            --bg:    rgba(248,250,252,.96);
            --bg-h:  rgba(0,0,0,.02);
            --bg-s:  rgba(0,0,0,.025);
            --bg-i:  rgba(255,255,255,.8);
            --bd:    rgba(0,0,0,.1);
            --bd-s:  rgba(0,0,0,.07);
            --text:  #0f172a;
            --text2: #475569;
            --text3: #94a3b8;
            --bb:    rgba(0,0,0,.12);
            --bbg:   rgba(0,0,0,.04);
            --bc:    #475569;
            --bbgh:  rgba(0,0,0,.07);
            --bch:   #1e293b;
            --shadow:0 24px 64px rgba(0,0,0,.12),inset 0 0 0 1px rgba(0,0,0,.06);
            --ph:    #94a3b8;
          }
        }
        * { box-sizing: border-box; }
        .launcher {
          position: fixed;
          right: 18px;
          bottom: 20px;
          z-index: 2147483647;
          width: 44px;
          height: 44px;
          border: 0;
          border-radius: 11px;
          color: #fff;
          background: linear-gradient(135deg, #10b981 0%, #6366f1 100%);
          box-shadow: 0 4px 20px rgba(16,185,129,.45), 0 2px 8px rgba(0,0,0,.35);
          cursor: pointer;
          font: 700 15px/1 system-ui, sans-serif;
          transition: transform .15s, box-shadow .15s;
        }
        .launcher:hover {
          transform: translateY(-1px) scale(1.05);
          box-shadow: 0 6px 28px rgba(16,185,129,.55), 0 3px 12px rgba(0,0,0,.4);
        }
        .panel {
          position: fixed;
          right: 18px;
          bottom: 74px;
          z-index: 2147483647;
          width: min(320px, calc(100vw - 36px));
          display: none;
          border: 1px solid var(--bd);
          border-radius: 14px;
          background: var(--bg);
          backdrop-filter: blur(24px) saturate(180%);
          -webkit-backdrop-filter: blur(24px) saturate(180%);
          color: var(--text);
          box-shadow: var(--shadow);
          font: 13px/1.5 system-ui, -apple-system, sans-serif;
          overflow: hidden;
        }
        .panel[data-open="true"] { display: block; }
        header {
          padding: 14px 14px 10px;
          background: var(--bg-h);
          border-bottom: 1px solid var(--bd-s);
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .logo {
          width: 24px; height: 24px;
          border-radius: 6px;
          background: linear-gradient(135deg, #10b981, #6366f1);
          display: flex; align-items: center; justify-content: center;
          color: #fff; font: 700 11px/1 system-ui; flex-shrink: 0;
        }
        .header-text { flex: 1; min-width: 0; }
        h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text); }
        .subtitle { margin-top: 1px; font-size: 11px; color: var(--text3); }
        main { padding: 12px 14px 14px; display: grid; gap: 8px; }
        details {
          border: 1px solid var(--bd-s);
          border-radius: 8px;
          background: var(--bg-s);
          overflow: hidden;
        }
        summary {
          padding: 8px 10px;
          cursor: pointer;
          color: var(--text3);
          font-weight: 600;
          font-size: 12px;
          list-style-position: inside;
        }
        .settings-body { display: grid; gap: 8px; padding: 0 10px 10px; }
        label { display: grid; gap: 4px; color: var(--text2); font-weight: 600; font-size: 12px; }
        input {
          width: 100%;
          border: 1px solid var(--bd);
          border-radius: 6px;
          padding: 7px 9px;
          background: var(--bg-i);
          color: var(--text);
          font: inherit;
          outline: none;
        }
        input::placeholder { color: var(--ph); }
        input:focus { border-color: rgba(99,102,241,.5); box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
        button {
          border: 1px solid var(--bb);
          border-radius: 7px;
          padding: 8px 12px;
          background: var(--bbg);
          color: var(--bc);
          cursor: pointer;
          font: 600 13px/1.2 system-ui, sans-serif;
          transition: background .15s, color .15s;
        }
        button:hover { background: var(--bbgh); color: var(--bch); }
        .primary {
          background: linear-gradient(135deg, #059669 0%, #6366f1 140%);
          border-color: transparent; color: #fff;
          box-shadow: 0 0 16px rgba(16,185,129,.3);
        }
        .primary:hover {
          background: linear-gradient(135deg, #047857 0%, #4f46e5 140%);
          box-shadow: 0 0 22px rgba(16,185,129,.42);
          color: #fff;
        }
        .stop { display: none; color: var(--text3); }
        .muted { color: var(--text3); font-size: 12px; }
      </style>
      <button class="launcher" title="ChatGPT Session Renamer">R</button>
      <section class="panel" aria-label="ChatGPT Session Renamer">
        <header>
          <div class="logo">R</div>
          <div class="header-text">
            <h2>Title Review</h2>
            <div class="subtitle">Preview AI titles before applying.</div>
          </div>
        </header>
        <main>
          <button class="primary start">Review Titles</button>
          <button class="stop">Stop</button>
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

  function setPanelRunning(running) {
    const panelRoot = document.getElementById(APP_ID)?.shadowRoot;
    if (!panelRoot) return;
    panelRoot.querySelector(".stop").style.display = running ? "" : "none";
  }

  function launchRenameWorkflow() {
    const existing = document.getElementById("cso-rename-workflow");
    existing?.remove();

    const targets = visibleSidebarSessions();
    const overlay = document.createElement("div");
    overlay.id = "cso-rename-workflow";
    overlay.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        #cso-rename-workflow {
          --bg:     rgba(13,15,23,.97);
          --bg-h:   rgba(255,255,255,.04);
          --bg-s:   rgba(255,255,255,.018);
          --bg-i:   rgba(255,255,255,.04);
          --bd:     rgba(255,255,255,.08);
          --bd-s:   rgba(255,255,255,.06);
          --text:   #e2e8f0;
          --text2:  #94a3b8;
          --text3:  #475569;
          --old-c:  #94a3b8;
          --bb:     rgba(255,255,255,.09);
          --bbg:    rgba(255,255,255,.05);
          --bc:     #94a3b8;
          --bbgh:   rgba(255,255,255,.09);
          --bch:    #cbd5e1;
          --row-bg: rgba(255,255,255,.025);
          --row-bh: rgba(255,255,255,.042);
          --row-bd: rgba(255,255,255,.06);
          --row-bdh:rgba(255,255,255,.09);
          --shadow: 0 32px 100px rgba(0,0,0,.65),inset 0 0 0 1px rgba(255,255,255,.04);
          --ovl:    rgba(5,8,15,.72);
          --ph:     #2d3748;
        }
        @media (prefers-color-scheme: light) {
          #cso-rename-workflow {
            --bg:     rgba(248,250,252,.97);
            --bg-h:   rgba(0,0,0,.02);
            --bg-s:   rgba(0,0,0,.018);
            --bg-i:   #ffffff;
            --bd:     rgba(0,0,0,.1);
            --bd-s:   rgba(0,0,0,.07);
            --text:   #0f172a;
            --text2:  #475569;
            --text3:  #94a3b8;
            --old-c:  #64748b;
            --bb:     rgba(0,0,0,.12);
            --bbg:    rgba(0,0,0,.04);
            --bc:     #475569;
            --bbgh:   rgba(0,0,0,.07);
            --bch:    #1e293b;
            --row-bg: rgba(0,0,0,.018);
            --row-bh: rgba(0,0,0,.035);
            --row-bd: rgba(0,0,0,.08);
            --row-bdh:rgba(0,0,0,.14);
            --shadow: 0 24px 80px rgba(0,0,0,.12),0 4px 16px rgba(0,0,0,.06),inset 0 0 0 1px rgba(0,0,0,.07);
            --ovl:    rgba(15,23,42,.4);
            --ph:     #94a3b8;
          }
        }
        #cso-rename-workflow {
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          display: grid;
          place-items: center;
          background: var(--ovl);
          backdrop-filter: blur(6px);
          -webkit-backdrop-filter: blur(6px);
          font: 13px/1.5 system-ui, -apple-system, sans-serif;
          color: var(--text);
        }
        #cso-rename-workflow .box {
          width: min(960px, calc(100vw - 32px));
          max-height: min(800px, calc(100vh - 32px));
          display: grid;
          grid-template-rows: auto auto 1fr auto;
          border-radius: 16px;
          border: 1px solid var(--bd);
          background: var(--bg);
          backdrop-filter: blur(24px) saturate(180%);
          overflow: hidden;
          box-shadow: var(--shadow);
          animation: boxIn .18s cubic-bezier(.16,1,.3,1) both;
        }
        @keyframes boxIn {
          from { opacity: 0; transform: scale(.97) translateY(8px); }
          to   { opacity: 1; transform: scale(1)   translateY(0); }
        }
        #cso-rename-workflow header {
          padding: 18px 20px 14px;
          background: var(--bg-h);
          border-bottom: 1px solid var(--bd-s);
          display: flex; align-items: center; gap: 12px;
        }
        #cso-rename-workflow .header-icon {
          width: 32px; height: 32px; border-radius: 8px;
          background: linear-gradient(135deg, #10b981, #6366f1);
          display: flex; align-items: center; justify-content: center;
          color: #fff; font: 700 14px/1 system-ui; flex-shrink: 0;
          box-shadow: 0 0 16px rgba(16,185,129,.4);
        }
        #cso-rename-workflow .header-text { flex: 1; min-width: 0; }
        #cso-rename-workflow h2 { margin: 0; font-size: 18px; font-weight: 700; color: var(--text); line-height: 1.2; }
        #cso-rename-workflow .summary { margin-top: 3px; font-size: 12px; color: var(--text3); }
        #cso-rename-workflow .tools {
          display: flex; flex-wrap: wrap; gap: 6px;
          padding: 10px 20px;
          background: var(--bg-s);
          border-bottom: 1px solid var(--bd-s);
        }
        #cso-rename-workflow .list {
          overflow: auto; padding: 12px 20px 16px;
          display: grid; gap: 6px; align-content: start;
        }
        #cso-rename-workflow .list::-webkit-scrollbar { width: 4px; }
        #cso-rename-workflow .list::-webkit-scrollbar-track { background: transparent; }
        #cso-rename-workflow .list::-webkit-scrollbar-thumb { background: var(--bd); border-radius: 4px; }
        #cso-rename-workflow .row {
          display: grid;
          grid-template-columns: 18px minmax(180px,.9fr) minmax(240px,1.2fr) minmax(90px,auto);
          gap: 10px; align-items: center;
          padding: 10px 12px;
          border: 1px solid var(--row-bd);
          border-radius: 9px;
          background: var(--row-bg);
          transition: background .12s, border-color .12s;
        }
        #cso-rename-workflow .row:hover { background: var(--row-bh); border-color: var(--row-bdh); }
        #cso-rename-workflow .row input[type="checkbox"] { width: 15px; height: 15px; margin: 0; accent-color: #10b981; }
        #cso-rename-workflow .old {
          min-width: 0; font-weight: 600; font-size: 12.5px; color: var(--old-c);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        #cso-rename-workflow input[type="text"] {
          width: 100%; border: 1px solid var(--bd); border-radius: 6px;
          padding: 7px 9px; background: var(--bg-i); color: var(--text);
          font: inherit; outline: none; transition: border-color .15s, box-shadow .15s;
        }
        #cso-rename-workflow input[type="text"]:focus {
          border-color: rgba(99,102,241,.5);
          box-shadow: 0 0 0 3px rgba(99,102,241,.1);
        }
        #cso-rename-workflow input[type="text"]::placeholder { color: var(--ph); }
        #cso-rename-workflow button {
          border: 1px solid var(--bb); border-radius: 7px;
          padding: 7px 12px; background: var(--bbg); color: var(--bc);
          cursor: pointer; font: 600 12px/1.2 system-ui;
          transition: background .15s, color .15s; white-space: nowrap;
        }
        #cso-rename-workflow button:hover:not(:disabled) { background: var(--bbgh); color: var(--bch); }
        #cso-rename-workflow button:disabled { opacity: .4; cursor: not-allowed; }
        #cso-rename-workflow footer {
          padding: 12px 20px; border-top: 1px solid var(--bd-s);
          display: flex; justify-content: space-between; align-items: center; gap: 8px;
          background: var(--bg-s);
        }
        #cso-rename-workflow footer > div { display: flex; gap: 8px; }
        #cso-rename-workflow .primary {
          background: linear-gradient(135deg, #059669 0%, #6366f1 140%);
          border-color: transparent; color: #fff;
          padding: 8px 16px; font-size: 13px;
          box-shadow: 0 0 18px rgba(16,185,129,.32);
        }
        #cso-rename-workflow .primary:hover:not(:disabled) {
          background: linear-gradient(135deg, #047857 0%, #4f46e5 140%);
          box-shadow: 0 0 26px rgba(16,185,129,.44);
          color: #fff;
        }
        #cso-rename-workflow .stop-workflow { display: none; }
        #cso-rename-workflow .status {
          justify-self: end; max-width: 160px; border-radius: 999px;
          padding: 3px 9px; background: var(--bbg); color: var(--bc);
          font: 600 11px/1.5 system-ui; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis; border: 1px solid var(--bb);
        }
        #cso-rename-workflow .error { background: rgba(239,68,68,.12); color: #f87171; border-color: rgba(239,68,68,.22); }
        #cso-rename-workflow .ok    { background: rgba(16,185,129,.12); color: #34d399; border-color: rgba(16,185,129,.22); }
      </style>
      <section class="box" role="dialog" aria-modal="true" aria-label="Rename visible sessions">
        <header>
          <div class="header-icon">R</div>
          <div class="header-text">
            <h2>Review Titles</h2>
            <div class="summary"></div>
          </div>
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
            <button class="stop-workflow">Stop</button>
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
    const closeOverlay = () => {
      overlay.remove();
      document.removeEventListener("keydown", onEscKey);
      setPanelRunning(false);
    };
    const onEscKey = (e) => { if (e.key === "Escape") closeOverlay(); };
    document.addEventListener("keydown", onEscKey);

    overlay.querySelector(".cancel").addEventListener("click", closeOverlay);
    overlay.querySelector(".stop-workflow").addEventListener("click", () => { stopRequested = true; });
    overlay.querySelector(".generate").addEventListener("click", async () => {
      await generatePreview(selectedRows(), setSummary, setStatus, overlay);
    });
    overlay.querySelector(".apply").addEventListener("click", async () => {
      await applyPreview(selectedRows(), setSummary, setStatus, overlay);
    });
    overlay.querySelector(".list").addEventListener("input", () => {
      const hasTitle = rows().some((row) => normalizeText(row.querySelector(".title").value));
      overlay.querySelector(".apply").disabled = !hasTitle;
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

    setPanelRunning(true);
    overlay.querySelector(".stop-workflow").style.display = "";
    overlay.querySelector(".generate").disabled = true;

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

    const hasTitle = rows.some((row) => normalizeText(row.querySelector(".title").value));
    overlay.querySelector(".apply").disabled = !hasTitle;
    overlay.querySelector(".stop-workflow").style.display = "none";
    overlay.querySelector(".generate").disabled = false;
    setPanelRunning(false);
    setSummary(`Preview complete: ${generated}/${rows.length} ready${repaired ? `, ${repaired} repaired` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
  }

  async function applyPreview(rows, setSummary, setStatus, overlay) {
    stopRequested = false;
    const readyRows = rows.filter((row) => normalizeText(row.querySelector(".title").value));
    let renamed = 0;
    let failed = 0;

    setPanelRunning(true);
    overlay.querySelector(".stop-workflow").style.display = "";
    overlay.querySelector(".apply").disabled = true;

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

    overlay.querySelector(".stop-workflow").style.display = "none";
    overlay.querySelector(".apply").disabled = false;
    setPanelRunning(false);
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
