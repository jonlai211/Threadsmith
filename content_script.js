(function initChatGptSessionRenamer() {
  // Runs in the ChatGPT page. Owns the floating card UI, conversation
  // extraction, AI title generation, and native ChatGPT rename flow.
  const APP_ID = "threadsmith-root";
  const SESSION_RE = /\/c\/([a-zA-Z0-9-]+)/;

  // Shared modules are attached to window.Threadsmith by the lib/*.js content
  // scripts that load before this file (see manifest content_scripts order).
  const { config, prompts, validators } = window.Threadsmith;

  let settings = config.normalizeSettings(null);
  let stopRequested = false;
  let workflowBusy = false;
  let sidebarObserver = null;
  let sidebarSyncTimer = null;

  function languageFor(sample) {
    return prompts.resolveLanguage(settings.titleLanguage, sample);
  }

  function getSessionIdFromUrl(url) {
    return url?.match(SESSION_RE)?.[1] || "";
  }

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isBoilerplateText(text) {
    const clean = normalizeText(text);
    return !clean || validators.BAD_UI_TITLE_RE.test(clean) || /^(Skip to content|Chat history|Projects|Library|Apps|More|Share|Thinking|Ready when you are)$/i.test(clean);
  }

  function cleanMessageText(text) {
    return normalizeText(text)
      .split(/\n+/)
      .map((line) => normalizeText(line))
      .filter((line) => line && !isBoilerplateText(line))
      .join(" ");
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
    if (getSessionIdFromUrl(location.href) === id) return waitForConversationContent();

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
    return waitForConversationContent();
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

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url || "provider";
    }
  }

  function describeProviderError(where, status, raw) {
    if (status === 401 || status === 403) return `${where}: invalid or unauthorized API key (${status}).`;
    if (status === 402) return `${where}: insufficient balance (402). Top up the account.`;
    if (status === 429) return `${where}: quota or rate limit reached (429). Check the provider's billing/plan.`;
    if (status >= 500) return `${where}: provider error (${status}). Try again later.`;
    return raw || `${where} failed (${status}).`;
  }

  async function requestChatJson(payload, label) {
    const transport = config.resolveTransport(settings);
    if (!transport.apiKey) throw new Error("Add a provider API key in Settings first.");
    if (!transport.baseURL) throw new Error("Set the provider base URL in Settings first.");

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "TS_CHAT_JSON",
        transport: { baseURL: transport.baseURL, apiKey: transport.apiKey },
        payload: {
          model: payload.model || transport.model,
          messages: payload.messages,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          jsonMode: transport.jsonMode
        },
        label
      });
    } catch (error) {
      if (/Extension context invalidated|message port closed|Receiving end does not exist/i.test(error?.message || "")) {
        throw new Error("Extension was reloaded. Refresh the ChatGPT page, then open Threadsmith again.");
      }
      throw error;
    }

    if (!response) throw new Error(`${label}: no response from the background worker.`);
    if (!response.ok) {
      const where = `${label} @ ${hostOf(transport.baseURL)}`;
      const error = new Error(
        response.status ? describeProviderError(where, response.status, response.error) : (response.error || `${where} failed.`)
      );
      // A provider HTTP status (4xx/5xx) is a transport-level failure: don't
      // retry or run the repair pass on it.
      if (response.status) error.status = response.status;
      throw error;
    }
    return { parsed: response.parsed, content: response.content || "" };
  }

  async function requestTitleSuggestion(originalTitle, messages, language, options = {}) {
    const { parsed, content } = await requestChatJson({
      messages: prompts.buildTitleMessages({ language, originalTitle, messages, options }),
      temperature: 0.2,
      maxTokens: options.maxTokens || 450
    }, "Title");

    const title = validators.normalizeAiTitle(parsed?.title);
    if (!title) throw new Error(`Provider returned no title: ${content.slice(0, 120)}`);
    if (validators.isBadTitle(title, language)) throw new Error(`Provider returned an unusable title: ${title}`);
    return title;
  }

  async function suggestTitle(originalTitle, messages, language) {
    try {
      return await requestTitleSuggestion(originalTitle, messages, language, {
        messageLimit: 4,
        charLimit: 500,
        maxTokens: 450
      });
    } catch (error) {
      // Fail fast on provider HTTP errors and on already-rejected titles;
      // only retry when the first pass produced empty/invalid content.
      if (error.status || /unusable title/i.test(error.message || "")) throw error;
      return requestTitleSuggestion(originalTitle, messages, language, {
        messageLimit: 8,
        charLimit: 700,
        maxTokens: 700
      });
    }
  }

  async function repairTitle(originalTitle, messages, badTitle, reason, language) {
    const { parsed, content } = await requestChatJson({
      messages: prompts.buildTitleMessages({
        language,
        originalTitle,
        messages,
        repair: { badTitle, reason },
        options: { messageLimit: 8, charLimit: 700 }
      }),
      temperature: 0.1,
      maxTokens: 700
    }, "Title repair");

    const title = validators.normalizeAiTitle(parsed?.title);
    if (!title || validators.isBadTitle(title, language)) {
      throw new Error(`Title repair returned unusable title: ${title || content.slice(0, 120)}`);
    }
    return title;
  }

  async function generateTitleSuggestion(target) {
    const messages = await openConversation(target.id, target.url);
    if (!messages.length) throw new Error("No conversation text found.");
    if (getSessionIdFromUrl(location.href) !== target.id) {
      throw new Error("Could not open the target conversation before reading content.");
    }

    // Resolve language once per conversation: explicit setting wins, otherwise
    // auto-detect from the conversation text (plus the old title as a hint).
    const sample = `${target.title} ${messages.map((m) => m.text).join(" ")}`.slice(0, 600);
    const language = languageFor(sample);

    try {
      return {
        title: await suggestTitle(target.title, messages, language),
        repaired: false
      };
    } catch (error) {
      // Provider HTTP errors (quota, auth, rate limit) won't be fixed by a
      // second call — surface them directly instead of burning a repair pass.
      if (error.status) throw error;
      const repaired = await repairTitle(target.title, messages, "No usable title from first pass", error.message || String(error), language);
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

  // ChatGPT localizes its menu, so match the "Rename" item across the UI
  // languages it ships. Exact (case-insensitive) match only — never guess a
  // menu item, since the wrong one could be Delete or Archive.
  const RENAME_MENU_LABELS = [
    "rename",            // English
    "重命名",            // Simplified Chinese
    "重新命名",          // Traditional Chinese
    "名前を変更",        // Japanese
    "名称変更",          // Japanese (variant)
    "이름 바꾸기",        // Korean
    "이름 변경",          // Korean (variant)
    "renommer",          // French
    "umbenennen",        // German
    "cambiar nombre",    // Spanish
    "renombrar",         // Spanish (variant)
    "rinomina",          // Italian
    "renomear",          // Portuguese
    "переименовать",     // Russian
    "yeniden adlandır",  // Turkish
    "إعادة تسمية",       // Arabic
    "ganti nama",        // Indonesian
    "đổi tên",           // Vietnamese
    "เปลี่ยนชื่อ"          // Thai
  ];

  async function waitForMenuItem(labels, timeout = 1500) {
    const wanted = new Set(labels.map((label) => normalizeText(label).toLowerCase()));
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((candidate) => wanted.has(normalizeText(candidate.textContent).toLowerCase()));
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

  async function renameInChatGpt(id, title, { validate = true } = {}) {
    const newTitle = normalizeText(title);
    if (!id) throw new Error("Open a saved ChatGPT conversation first.");
    if (!newTitle) throw new Error("Enter a title before renaming.");
    // Skip the AI-quality guard when restoring a user's original title.
    if (validate && validators.isBadTitle(newTitle, languageFor(newTitle))) throw new Error(`Refused bad title: ${newTitle}`);

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
      const renameItem = await waitForMenuItem(RENAME_MENU_LABELS);
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

  // Rename via the sidebar options menu; fall back to opening the conversation.
  async function renameWithFallback(target, title, options) {
    try {
      await renameInChatGpt(target.id, title, options);
    } catch (firstError) {
      await openConversation(target.id, target.url);
      await renameInChatGpt(target.id, title, options);
    }
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

  function setRowStatus(row, text, cls = "", detail = "") {
    const badge = row.querySelector(".row-status");
    badge.className = `row-status ${cls}`.trim();
    badge.textContent = text;
    badge.title = detail || text;

    const detailEl = row.querySelector(".row-detail");
    if (detailEl) {
      detailEl.textContent = detail || "";
      detailEl.classList.toggle("error", cls === "error");
      row.classList.toggle("has-detail", Boolean(detail));
    }
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
          width: 44px; height: 44px;
          padding: 0; border: 0; border-radius: 11px;
          background: transparent;
          cursor: pointer; overflow: hidden;
          box-shadow: 0 4px 18px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.14);
          transition: transform .15s, box-shadow .15s;
        }
        .launcher img {
          display: block; width: 100%; height: 100%;
          pointer-events: none; user-select: none;
        }
        .launcher:hover {
          transform: translateY(-1px) scale(1.05);
          box-shadow: 0 6px 26px rgba(16,185,129,.32), 0 3px 10px rgba(0,0,0,.2);
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
          max-width: 130px; overflow: hidden; text-overflow: ellipsis;
        }
        .row-status.ok    { background: rgba(16,185,129,.12); color: #34d399; border-color: rgba(16,185,129,.22); }
        .row-status.error { background: rgba(239,68,68,.12);  color: #f87171; border-color: rgba(239,68,68,.22); }
        .row-detail {
          grid-column: 1 / 4; grid-row: 3;
          display: none; padding-top: 4px;
          font-size: 11px; line-height: 1.45; color: var(--text2);
          overflow-wrap: anywhere; word-break: break-word;
        }
        .row.has-detail .row-detail { display: block; }
        .row-detail.error { color: #f87171; }
        .row-detail .detail-text { color: var(--old-c); }
        .undo-btn {
          margin-left: 6px; padding: 1px 8px;
          border-radius: 999px; font: 600 10.5px/1.5 system-ui;
          vertical-align: baseline;
        }
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

      <button class="launcher" title="Threadsmith"><img alt=""></button>

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
              <label>Provider<select class="si provider-select"></select></label>
              <label>API key<input class="si provider-key" type="password" placeholder="sk-..."></label>
              <label>Model<input class="si provider-model" placeholder="deepseek-v4-flash"></label>
              <label class="baseurl-row">Base URL<input class="si provider-baseurl" type="text" placeholder="https://api.example.com"></label>
              <label>Title language<select class="si language-select">
                <option value="auto">Auto (match chat)</option>
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select></label>
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

    // Wire up launcher icon
    try {
      root.querySelector(".launcher img").src = chrome.runtime.getURL("icons/icon128.png");
    } catch {}

    // Launcher toggle
    root.querySelector(".launcher").addEventListener("click", () => {
      const card = root.querySelector(".card");
      const opening = card.dataset.open !== "true";
      card.dataset.open = String(opening);
      if (opening && card.dataset.phase === "idle") updateIdleCount(root);
      if (opening && card.dataset.phase === "workflow") startSidebarSync(root);
      if (!opening) stopSidebarSync();
    });

    root.querySelector(".close-btn").addEventListener("click", () => {
      root.querySelector(".card").dataset.open = "false";
      stopSidebarSync();
    });

    // Idle phase
    root.querySelector(".provider-select").addEventListener("change", () => fillProviderFields(root));

    root.querySelector(".save-settings").addEventListener("click", async () => {
      const id = root.querySelector(".provider-select").value;
      const preset = config.PROVIDERS[id] || config.PROVIDERS[config.DEFAULT_PROVIDER_ID];
      const next = {
        ...settings,
        providerId: id,
        titleLanguage: root.querySelector(".language-select").value || "auto",
        providers: {
          ...settings.providers,
          [id]: {
            apiKey: root.querySelector(".provider-key").value.trim(),
            model: root.querySelector(".provider-model").value.trim() || preset.defaultModel || "",
            baseURL: root.querySelector(".provider-baseurl").value.trim() || preset.baseURL || ""
          }
        }
      };
      try {
        settings = await config.saveSettings(next);
        root.querySelector(".feedback").textContent = preset.custom
          ? "Saved. For a custom endpoint, open the toolbar popup once to grant host access."
          : "Settings saved.";
      } catch (error) {
        root.querySelector(".feedback").textContent = error.message || "Could not save settings.";
      }
    });

    root.querySelector(".start-btn").addEventListener("click", () => startWorkflow(root));

    // Workflow phase
    root.querySelector(".back-btn").addEventListener("click", () => {
      stopRequested = true;
      stopSidebarSync();
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

  function populateProviderSelect(root) {
    const select = root.querySelector(".provider-select");
    if (select.options.length) return;
    for (const [id, preset] of Object.entries(config.PROVIDERS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = preset.label;
      select.append(option);
    }
  }

  function fillProviderFields(root) {
    const id = root.querySelector(".provider-select").value || settings.providerId;
    const preset = config.PROVIDERS[id] || config.PROVIDERS[config.DEFAULT_PROVIDER_ID];
    const cfg = (settings.providers && settings.providers[id]) || {};
    root.querySelector(".provider-key").value = cfg.apiKey || "";
    const modelInput = root.querySelector(".provider-model");
    modelInput.value = cfg.model || preset.defaultModel || "";
    modelInput.placeholder = preset.defaultModel || "model";
    root.querySelector(".provider-baseurl").value = cfg.baseURL || preset.baseURL || "";
    root.querySelector(".baseurl-row").style.display = preset.custom ? "grid" : "none";
  }

  function renderCard() {
    const root = cardRoot();
    if (!root) return;
    populateProviderSelect(root);
    root.querySelector(".provider-select").value = settings.providerId || config.DEFAULT_PROVIDER_ID;
    root.querySelector(".language-select").value = settings.titleLanguage || "auto";
    fillProviderFields(root);
  }

  function createSessionRow(target, { checked = false } = {}) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.id = target.id;
    row.innerHTML = `
      <input type="checkbox" ${checked ? "checked" : ""}>
      <div class="row-old"></div>
      <div class="row-status">Queued</div>
      <div class="row-title-wrap"><input class="title" type="text" placeholder="Generate to preview"></div>
      <div class="row-detail"></div>
    `;
    row.querySelector(".row-old").textContent = target.title;
    row._target = target;
    return row;
  }

  function renderSessionRows(root, targets) {
    const list = root.querySelector(".session-list");
    list.innerHTML = "";
    if (!targets.length) {
      list.innerHTML = `<div class="no-sessions">No sessions visible yet.<br>Scroll the ChatGPT sidebar to load your history.</div>`;
      return;
    }
    targets.forEach((target, index) => list.append(createSessionRow(target, { checked: index === 0 })));
  }

  function startWorkflow(root) {
    renderSessionRows(root, visibleSidebarSessions());
    updateWorkflowCount(root);
    switchPhase(root, "workflow");
    startSidebarSync(root);
  }

  // Append rows for any sidebar sessions we have not listed yet. Never removes
  // or reorders existing rows, so checkboxes, generated titles, and statuses
  // are preserved as the user scrolls the sidebar.
  function syncNewSessions(root) {
    if (workflowBusy) return;
    const list = root.querySelector(".session-list");
    const known = new Set(allRows(root).map((row) => row.dataset.id));
    let added = 0;
    for (const session of visibleSidebarSessions()) {
      if (known.has(session.id)) continue;
      list.querySelector(".no-sessions")?.remove();
      list.append(createSessionRow(session, { checked: false }));
      known.add(session.id);
      added += 1;
    }
    if (added) updateWorkflowCount(root);
  }

  function findSidebarScroller() {
    const anchor = document.querySelector('a[href*="/c/"]');
    let element = anchor?.parentElement;
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  function findSidebarContainer() {
    const anchor = document.querySelector('a[href*="/c/"]');
    return anchor?.closest("nav") || findSidebarScroller() || document.body;
  }

  // Watch the sidebar for lazily-loaded conversations and grow the list live.
  function startSidebarSync(root) {
    stopSidebarSync();
    const target = findSidebarContainer();
    if (!target) return;
    sidebarObserver = new MutationObserver(() => {
      clearTimeout(sidebarSyncTimer);
      sidebarSyncTimer = setTimeout(() => syncNewSessions(root), 250);
    });
    sidebarObserver.observe(target, { childList: true, subtree: true });
  }

  function stopSidebarSync() {
    if (sidebarObserver) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }
    clearTimeout(sidebarSyncTimer);
  }

  async function generatePreview(rows, root) {
    stopRequested = false;
    try {
      settings = await config.loadSettings();
    } catch (error) {
      setCardSummary(root, error.message || "Could not read settings.");
      return;
    }
    if (!config.resolveTransport(settings).apiKey) {
      setCardSummary(root, "Add a provider API key in Settings first.");
      return;
    }

    root.querySelector(".wf-stop").style.display = "";
    root.querySelector(".wf-generate").disabled = true;
    root.querySelector(".back-btn").disabled = true;
    workflowBusy = true;

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
        setRowStatus(row, "Skipped", "error", error.message || "generation failed");
      }
    }

    workflowBusy = false;
    const hasTitle = allRows(root).some((r) => normalizeText(r.querySelector(".title")?.value || ""));
    root.querySelector(".wf-apply").disabled = !hasTitle;
    root.querySelector(".wf-stop").style.display = "none";
    root.querySelector(".wf-generate").disabled = false;
    root.querySelector(".back-btn").disabled = false;
    setCardSummary(root, `Done — ${generated} ready${repaired ? `, ${repaired} repaired` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
  }

  // After a rename, show "Renamed" plus the old title and an Undo control that
  // restores the original (bypassing the AI-quality guard).
  function attachUndo(row, target, root) {
    setRowStatus(row, "Renamed", "ok");
    const detailEl = row.querySelector(".row-detail");
    detailEl.classList.remove("error");
    detailEl.innerHTML = "";

    const text = document.createElement("span");
    text.className = "detail-text";
    text.textContent = `was: ${target.title}`;

    const button = document.createElement("button");
    button.className = "undo-btn";
    button.textContent = "Undo";
    button.addEventListener("click", () => undoRename(row, target, button, root));

    detailEl.append(text, button);
    row.classList.add("has-detail");
  }

  async function undoRename(row, target, button, root) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Restoring…";
    try {
      await renameWithFallback(target, target.title, { validate: false });
      setRowStatus(row, "Restored", "ok");
    } catch (error) {
      button.textContent = original;
      button.disabled = false;
      setCardSummary(root, `Undo failed: ${error.message || "rename failed"}`);
    }
  }

  async function applyPreview(rows, root) {
    stopRequested = false;
    const readyRows = rows.filter((r) => normalizeText(r.querySelector(".title")?.value || ""));
    if (!readyRows.length) { setCardSummary(root, "No titles to apply."); return; }

    root.querySelector(".wf-stop").style.display = "";
    root.querySelector(".wf-apply").disabled = true;
    root.querySelector(".wf-generate").disabled = true;
    root.querySelector(".back-btn").disabled = true;
    workflowBusy = true;

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
        await renameWithFallback(target, title);
        renamed++;
        attachUndo(row, target, root);
      } catch (error) {
        failed++;
        setRowStatus(row, "Failed", "error", error.message || "rename failed");
      }
    }

    workflowBusy = false;
    root.querySelector(".wf-stop").style.display = "none";
    root.querySelector(".wf-apply").disabled = false;
    root.querySelector(".wf-generate").disabled = false;
    root.querySelector(".back-btn").disabled = false;
    setCardSummary(root, `Done — ${renamed} renamed${failed ? `, ${failed} failed` : ""}.`);
  }

  async function init() {
    settings = await config.loadSettings();
    createApp();
    renderCard();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "TS_START_WORKFLOW") {
      const root = cardRoot();
      if (root) {
        root.querySelector(".card").dataset.open = "true";
        startWorkflow(root);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "TS_STOP") {
      stopRequested = true;
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "TS_SETTINGS_UPDATED") {
      config.loadSettings().then((value) => {
        settings = value;
        renderCard();
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });

  init();
})();
