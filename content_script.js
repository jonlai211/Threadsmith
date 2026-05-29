(function initChatGptSessionRenamer() {
  // Runs in the ChatGPT page. Owns the floating card UI, conversation
  // extraction, AI title generation, and native ChatGPT rename flow.
  const SETTINGS_KEY = "cso.settings";
  const APP_ID = "threadsmith-root";
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
      /[\uFFFD]|(\?\?)/.test(clean) ||
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

  // ─── Card UI helpers ──────────────────────────────────────────────────────

  function cardRoot() {
    return document.getElementById(APP_ID)?.shadowRoot ?? null;
  }

  function allRows(root) {
    return [...root.querySelectorAll(".session-list .row")];
  }

  function selectedRows(root) {
    return allRows(root).filter((r) => r.querySelector('input[type="checkbox"]').checked);
  }

  function switchPhase(root, phase) {
    root.querySelector(".card").dataset.phase = phase;
  }

  function setCardSummary(root, text) {
    root.querySelector(".wf-summary").textContent = text;
  }

  function setRowStatus(row, text, cls = "") {
    const badge = row.querySelector(".row-status");
    badge.className = `row-status ${cls}`.trim();
    badge.textContent = text;
    badge.title = text;
  }

  function updateWorkflowCount(root) {
    const total = allRows(root).length;
    const sel = selectedRows(root).length;
    setCardSummary(root, `${sel} / ${total} selected`);
  }

  function updateIdleCount(root) {
    const n = visibleSidebarSessions().length;
    root.querySelector(".session-count").textContent = n
      ? `${n} sessions visible in sidebar`
      : "No sessions visible — scroll the ChatGPT sidebar";
  }

  // ─── Card creation ────────────────────────────────────────────────────────

  function createApp() {
    if (document.getElementById(APP_ID)) return;

    const host = document.createElement("div");
    host.id = APP_ID;
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        :host {
          --bg:      rgba(13,15,23,.95);
          --bg-h:    rgba(255,255,255,.04);
          --bg-s:    rgba(255,255,255,.02);
          --bg-i:    rgba(255,255,255,.05);
          --bd:      rgba(255,255,255,.08);
          --bd-s:    rgba(255,255,255,.06);
          --text:    #e2e8f0;
          --text2:   #94a3b8;
          --text3:   #475569;
          --old-c:   #64748b;
          --bb:      rgba(255,255,255,.09);
          --bbg:     rgba(255,255,255,.05);
          --bc:      #94a3b8;
          --bbgh:    rgba(255,255,255,.09);
          --bch:     #cbd5e1;
          --row-bg:  rgba(255,255,255,.025);
          --row-bh:  rgba(255,255,255,.042);
          --row-bd:  rgba(255,255,255,.06);
          --row-bdh: rgba(255,255,255,.1);
          --shadow:  0 24px 64px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.04);
          --ph:      #2d3748;
        }
        @media (prefers-color-scheme: light) {
          :host {
            --bg:      rgba(248,250,252,.97);
            --bg-h:    rgba(0,0,0,.02);
            --bg-s:    rgba(0,0,0,.02);
            --bg-i:    #ffffff;
            --bd:      rgba(0,0,0,.1);
            --bd-s:    rgba(0,0,0,.07);
            --text:    #0f172a;
            --text2:   #475569;
            --text3:   #94a3b8;
            --old-c:   #64748b;
            --bb:      rgba(0,0,0,.12);
            --bbg:     rgba(0,0,0,.04);
            --bc:      #475569;
            --bbgh:    rgba(0,0,0,.07);
            --bch:     #1e293b;
            --row-bg:  rgba(0,0,0,.018);
            --row-bh:  rgba(0,0,0,.035);
            --row-bd:  rgba(0,0,0,.08);
            --row-bdh: rgba(0,0,0,.15);
            --shadow:  0 24px 64px rgba(0,0,0,.12),inset 0 0 0 1px rgba(0,0,0,.06);
            --ph:      #94a3b8;
          }
        }

        * { box-sizing: border-box; }

        /* ── Launcher ── */
        .launcher {
          position: fixed; right: 18px; bottom: 20px;
          z-index: 2147483647;
          width: 44px; height: 44px; border: 0; border-radius: 11px;
          background: linear-gradient(135deg, #10b981 0%, #6366f1 100%);
          color: #fff; font: 700 15px/1 system-ui;
          box-shadow: 0 4px 20px rgba(16,185,129,.45), 0 2px 8px rgba(0,0,0,.3);
          cursor: pointer;
          transition: transform .15s, box-shadow .15s;
        }
        .launcher:hover {
          transform: translateY(-1px) scale(1.05);
          box-shadow: 0 6px 28px rgba(16,185,129,.55), 0 3px 12px rgba(0,0,0,.35);
        }

        /* ── Card ── */
        .card {
          position: fixed; right: 18px; bottom: 74px;
          z-index: 2147483647;
          width: 360px;
          display: none; flex-direction: column;
          max-height: min(560px, calc(100vh - 100px));
          border: 1px solid var(--bd); border-radius: 14px;
          background: var(--bg);
          backdrop-filter: blur(24px) saturate(180%);
          -webkit-backdrop-filter: blur(24px) saturate(180%);
          color: var(--text);
          box-shadow: var(--shadow);
          font: 13px/1.5 system-ui, -apple-system, sans-serif;
          overflow: hidden;
        }
        .card[data-open="true"] { display: flex; }

        /* Phase visibility */
        .card[data-phase="idle"] .tools-bar,
        .card[data-phase="idle"] .session-list,
        .card[data-phase="idle"] .wf-footer { display: none; }
        .card[data-phase="workflow"] .idle-body { display: none; }

        /* ── Card header ── */
        .card-head {
          display: flex; align-items: center; gap: 8px;
          padding: 12px 12px 10px;
          background: var(--bg-h);
          border-bottom: 1px solid var(--bd-s);
          flex-shrink: 0;
        }
        .logo {
          width: 24px; height: 24px; border-radius: 6px;
          background: linear-gradient(135deg, #10b981, #6366f1);
          display: flex; align-items: center; justify-content: center;
          color: #fff; font: 700 11px/1 system-ui; flex-shrink: 0;
        }
        .head-info { flex: 1; min-width: 0; }
        .brand { font-size: 13px; font-weight: 600; color: var(--text); }
        .tagline { font-size: 10.5px; color: var(--text3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .close-btn {
          border: none; border-radius: 5px; padding: 0;
          width: 22px; height: 22px; flex-shrink: 0;
          background: transparent; color: var(--text3);
          cursor: pointer; font: 15px/1 system-ui;
          display: flex; align-items: center; justify-content: center;
          transition: background .12s, color .12s;
        }
        .close-btn:hover { background: var(--bg-s); color: var(--text); }

        /* ── Idle body ── */
        .idle-body { padding: 12px; display: grid; gap: 8px; flex-shrink: 0; }
        .session-count { font-size: 12px; color: var(--text3); }
        .feedback { font-size: 12px; color: var(--text3); }

        /* ── Tools bar ── */
        .tools-bar {
          display: flex; gap: 5px; flex-wrap: wrap;
          padding: 7px 10px;
          background: var(--bg-s);
          border-bottom: 1px solid var(--bd-s);
          flex-shrink: 0;
        }
        .tools-bar .spacer { flex: 1; }

        /* ── Session list ── */
        .session-list {
          flex: 1; overflow-y: auto; min-height: 0;
          padding: 8px 10px;
          display: flex; flex-direction: column; gap: 4px;
        }
        .session-list::-webkit-scrollbar { width: 3px; }
        .session-list::-webkit-scrollbar-track { background: transparent; }
        .session-list::-webkit-scrollbar-thumb { background: var(--bd); border-radius: 3px; }

        /* ── Row ── */
        .row {
          display: grid;
          grid-template-columns: 15px 1fr auto;
          gap: 4px 7px;
          align-items: start;
          padding: 7px 9px;
          border: 1px solid var(--row-bd); border-radius: 8px;
          background: var(--row-bg);
          transition: background .1s, border-color .1s;
        }
        .row:hover { background: var(--row-bh); border-color: var(--row-bdh); }
        .row input[type="checkbox"] {
          grid-column: 1; grid-row: 1;
          width: 14px; height: 14px; margin: 0; margin-top: 1px;
          accent-color: #10b981;
        }
        .row-old {
          grid-column: 2; grid-row: 1;
          font-size: 12px; color: var(--old-c);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .row-status {
          grid-column: 3; grid-row: 1;
          border-radius: 999px; padding: 2px 7px;
          background: var(--bbg); color: var(--bc);
          font: 600 10.5px/1.5 system-ui;
          white-space: nowrap; border: 1px solid var(--bb);
          align-self: center;
        }
        .row-status.ok    { background: rgba(16,185,129,.12); color: #34d399; border-color: rgba(16,185,129,.22); }
        .row-status.error { background: rgba(239,68,68,.12);  color: #f87171; border-color: rgba(239,68,68,.22); }
        .row-title-wrap {
          grid-column: 1 / 4; grid-row: 2;
          display: none; padding-top: 4px;
        }
        .row.has-title .row-title-wrap { display: block; }
        .row-title-wrap input {
          width: 100%; border: 1px solid var(--bd); border-radius: 5px;
          padding: 5px 7px; background: var(--bg-i); color: var(--text);
          font: inherit; outline: none;
          transition: border-color .15s, box-shadow .15s;
        }
        .row-title-wrap input:focus {
          border-color: rgba(99,102,241,.5);
          box-shadow: 0 0 0 2px rgba(99,102,241,.1);
        }
        .row-title-wrap input::placeholder { color: var(--ph); }

        .no-sessions { padding: 20px 12px; text-align: center; color: var(--text3); font-size: 12px; }

        /* ── Workflow footer ── */
        .wf-footer {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 10px;
          border-top: 1px solid var(--bd-s);
          background: var(--bg-s);
          flex-shrink: 0;
        }
        .wf-summary { font-size: 12px; color: var(--text3); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .wf-actions { display: flex; gap: 5px; flex-shrink: 0; }
        .wf-stop { display: none; }

        /* ── All buttons ── */
        button {
          border: 1px solid var(--bb); border-radius: 6px;
          padding: 6px 10px; background: var(--bbg); color: var(--bc);
          cursor: pointer; font: 600 12px/1.2 system-ui;
          transition: background .15s, color .15s; white-space: nowrap;
        }
        button:hover { background: var(--bbgh); color: var(--bch); }
        button:disabled { opacity: .4; cursor: not-allowed; }
        .primary {
          background: linear-gradient(135deg, #059669 0%, #6366f1 140%);
          border-color: transparent; color: #fff;
          box-shadow: 0 0 12px rgba(16,185,129,.3);
        }
        .primary:hover {
          background: linear-gradient(135deg, #047857 0%, #4f46e5 140%);
          box-shadow: 0 0 18px rgba(16,185,129,.42); color: #fff;
        }

        /* ── Settings ── */
        details { border: 1px solid var(--bd-s); border-radius: 7px; overflow: hidden; background: var(--bg-s); }
        summary { padding: 7px 10px; cursor: pointer; color: var(--text3); font-weight: 600; font-size: 12px; list-style-position: inside; }
        .settings-body { display: grid; gap: 7px; padding: 0 10px 10px; }
        label { display: grid; gap: 3px; color: var(--text2); font-weight: 600; font-size: 12px; }
        .si {
          width: 100%; border: 1px solid var(--bd); border-radius: 5px;
          padding: 6px 8px; background: var(--bg-i); color: var(--text);
          font: inherit; outline: none;
        }
        .si:focus { border-color: rgba(99,102,241,.5); box-shadow: 0 0 0 2px rgba(99,102,241,.1); }
        .si::placeholder { color: var(--ph); }
      </style>

      <button class="launcher" title="Threadsmith">T</button>

      <div class="card" data-open="false" data-phase="idle" aria-label="Threadsmith">

        <div class="card-head">
          <div class="logo">T</div>
          <div class="head-info">
            <div class="brand">Threadsmith</div>
            <div class="tagline">Shape messy ChatGPT history into clear, searchable titles.</div>
          </div>
          <button class="close-btn" aria-label="Close">✕</button>
        </div>

        <div class="idle-body">
          <div class="session-count"></div>
          <button class="primary start-btn">Generate Titles</button>
          <details>
            <summary>Settings</summary>
            <div class="settings-body">
              <label>Provider key<input class="si deepseek-key" type="password" placeholder="sk-..."></label>
              <label>Model<input class="si deepseek-model" placeholder="deepseek-v4-flash"></label>
              <button class="save-settings">Save</button>
            </div>
          </details>
          <div class="feedback"></div>
        </div>

        <div class="tools-bar">
          <button class="sel-all">All</button>
          <button class="sel-none">None</button>
          <div class="spacer"></div>
          <button class="back-btn">← Back</button>
        </div>

        <div class="session-list"></div>

        <div class="wf-footer">
          <div class="wf-summary"></div>
          <div class="wf-actions">
            <button class="wf-stop">Stop</button>
            <button class="wf-generate primary">Generate</button>
            <button class="wf-apply" disabled>Apply</button>
          </div>
        </div>

      </div>
    `;

    // Launcher toggle
    root.querySelector(".launcher").addEventListener("click", () => {
      const card = root.querySelector(".card");
      const opening = card.dataset.open !== "true";
      card.dataset.open = String(opening);
      if (opening && card.dataset.phase === "idle") updateIdleCount(root);
    });

    root.querySelector(".close-btn").addEventListener("click", () => {
      root.querySelector(".card").dataset.open = "false";
    });

    // Idle phase
    root.querySelector(".save-settings").addEventListener("click", async () => {
      settings = {
        ...settings,
        deepseekApiKey: root.querySelector(".deepseek-key").value.trim(),
        deepseekModel: root.querySelector(".deepseek-model").value.trim() || "deepseek-v4-flash"
      };
      await storage.setSettings(settings);
      root.querySelector(".feedback").textContent = "Settings saved.";
    });

    root.querySelector(".start-btn").addEventListener("click", () => startWorkflow(root));

    // Workflow phase
    root.querySelector(".back-btn").addEventListener("click", () => {
      stopRequested = true;
      switchPhase(root, "idle");
      updateIdleCount(root);
    });

    root.querySelector(".wf-stop").addEventListener("click", () => {
      stopRequested = true;
    });

    root.querySelector(".sel-all").addEventListener("click", () => {
      allRows(root).forEach((r) => (r.querySelector('input[type="checkbox"]').checked = true));
      updateWorkflowCount(root);
    });
    root.querySelector(".sel-none").addEventListener("click", () => {
      allRows(root).forEach((r) => (r.querySelector('input[type="checkbox"]').checked = false));
      updateWorkflowCount(root);
    });
    root.querySelector(".session-list").addEventListener("change", () => updateWorkflowCount(root));
    root.querySelector(".session-list").addEventListener("input", () => {
      const hasTitle = allRows(root).some((r) => normalizeText(r.querySelector(".title")?.value || ""));
      root.querySelector(".wf-apply").disabled = !hasTitle;
    });

    root.querySelector(".wf-generate").addEventListener("click", async () => {
      const rows = selectedRows(root);
      if (!rows.length) { setCardSummary(root, "Select at least one session first."); return; }
      await generatePreview(rows, root);
    });

    root.querySelector(".wf-apply").addEventListener("click", async () => {
      await applyPreview(selectedRows(root), root);
    });
  }

  function renderCard() {
    const root = cardRoot();
    if (!root) return;
    root.querySelector(".deepseek-key").value = settings.deepseekApiKey || "";
    root.querySelector(".deepseek-model").value = settings.deepseekModel || "deepseek-v4-flash";
  }

  function startWorkflow(root) {
    const targets = visibleSidebarSessions();
    const list = root.querySelector(".session-list");
    list.innerHTML = "";

    if (!targets.length) {
      list.innerHTML = `<div class="no-sessions">No visible sessions found.<br>Scroll the ChatGPT sidebar to load more.</div>`;
      switchPhase(root, "workflow");
      setCardSummary(root, "0 / 0 selected");
      return;
    }

    for (const [index, target] of targets.entries()) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.id = target.id;
      row.innerHTML = `
        <input type="checkbox" ${index === 0 ? "checked" : ""}>
        <div class="row-old"></div>
        <div class="row-status">Queued</div>
        <div class="row-title-wrap"><input class="title" type="text" placeholder="Generate to preview"></div>
      `;
      row.querySelector(".row-old").textContent = target.title;
      row._target = target;
      list.append(row);
    }

    updateWorkflowCount(root);
    switchPhase(root, "workflow");
  }

  async function generatePreview(rows, root) {
    stopRequested = false;
    try {
      settings = await storage.getSettings();
    } catch (error) {
      setCardSummary(root, error.message || "Could not read settings.");
      return;
    }
    if (!settings.deepseekApiKey) {
      setCardSummary(root, "Add a DeepSeek API key in Settings first.");
      return;
    }

    root.querySelector(".wf-stop").style.display = "";
    root.querySelector(".wf-generate").disabled = true;
    root.querySelector(".back-btn").disabled = true;

    let generated = 0, repaired = 0, skipped = 0;

    for (const [index, row] of rows.entries()) {
      if (stopRequested) {
        setCardSummary(root, `Stopped — ${generated} / ${rows.length} generated.`);
        break;
      }
      const target = row._target;
      setRowStatus(row, "Reading");
      setCardSummary(root, `${index + 1} / ${rows.length} — ${target.title}`);
      try {
        const suggestion = await generateTitleSuggestion(target);
        row.querySelector(".title").value = suggestion.title;
        row.dataset.ready = "true";
        row.classList.add("has-title");
        generated++;
        if (suggestion.repaired) repaired++;
        setRowStatus(row, suggestion.repaired ? "Repaired" : "Ready", "ok");
      } catch (error) {
        skipped++;
        setRowStatus(row, `Skipped: ${error.message || "generation failed"}`, "error");
      }
    }

    const hasTitle = allRows(root).some((r) => normalizeText(r.querySelector(".title")?.value || ""));
    root.querySelector(".wf-apply").disabled = !hasTitle;
    root.querySelector(".wf-stop").style.display = "none";
    root.querySelector(".wf-generate").disabled = false;
    root.querySelector(".back-btn").disabled = false;
    setCardSummary(root, `Done — ${generated} ready${repaired ? `, ${repaired} repaired` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
  }

  async function applyPreview(rows, root) {
    stopRequested = false;
    const readyRows = rows.filter((r) => normalizeText(r.querySelector(".title")?.value || ""));
    if (!readyRows.length) { setCardSummary(root, "No titles to apply."); return; }

    root.querySelector(".wf-stop").style.display = "";
    root.querySelector(".wf-apply").disabled = true;
    root.querySelector(".wf-generate").disabled = true;
    root.querySelector(".back-btn").disabled = true;

    let renamed = 0, failed = 0;

    for (const [index, row] of readyRows.entries()) {
      if (stopRequested) {
        setCardSummary(root, `Stopped — ${renamed} / ${readyRows.length} renamed.`);
        break;
      }
      const target = row._target;
      const title = normalizeText(row.querySelector(".title").value);
      setRowStatus(row, "Renaming");
      setCardSummary(root, `${index + 1} / ${readyRows.length} — ${title}`);
      try {
        await openConversation(target.id, target.url);
        await renameInChatGpt(target.id, title);
        renamed++;
        setRowStatus(row, "Renamed", "ok");
      } catch (error) {
        failed++;
        setRowStatus(row, "Failed", "error");
      }
    }

    root.querySelector(".wf-stop").style.display = "none";
    root.querySelector(".wf-apply").disabled = false;
    root.querySelector(".wf-generate").disabled = false;
    root.querySelector(".back-btn").disabled = false;
    setCardSummary(root, `Done — ${renamed} renamed${failed ? `, ${failed} failed` : ""}.`);
  }

  async function init() {
    settings = await storage.getSettings();
    createApp();
    renderCard();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CSR_START_WORKFLOW") {
      const root = cardRoot();
      if (root) {
        root.querySelector(".card").dataset.open = "true";
        startWorkflow(root);
      }
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
        renderCard();
        sendResponse({ ok: true });
      });
      return true;
    }
    return false;
  });

  init();
})();
