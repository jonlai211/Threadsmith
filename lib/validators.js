// Output validation layer. Shared checks (UI boilerplate, disclaimers, broken
// encoding and structure) plus language-specific sentence heuristics.
(function () {
  const NS = (window.Threadsmith = window.Threadsmith || {});

  const BAD_UI_TITLE_RE = /(Extended can make|ChatGPT can make|can make mistakes|Ask anything|Check important info|Create an image|Write or edit|Look something up|Search chats|New chat|Recents)/i;
  const BAD_AI_TITLE_RE = /(AI\s*免责声明|AI\s*免责申明|免责声明|免责申明|作为AI|作为一个AI|无法提供|不能提供|不能替代|consult|disclaimer)/i;

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeAiTitle(title) {
    return normalize(title)
      .replace(/^(General|Life|Research|Writing|Code|School|生活|研究|写作|代码|学习)\s*[-:：]\s*/i, "")
      .replace(/\s*[-:：]\s*$/, "");
  }

  function cleanRecoveredTitle(title) {
    return normalizeAiTitle(String(title || "")
      .replace(/^[\s"'{}\[\]]+/, "")
      .replace(/[\s"'{}\[\]]+$/, ""));
  }

  function recoverFromObject(value, depth = 0) {
    if (depth > 2 || value == null) return "";

    if (typeof value === "string") {
      const clean = normalize(value);
      if (!clean) return "";

      // Small local models sometimes serialize a second JSON object into the
      // title value. Parse it first; if it is slightly malformed, recover the
      // first quoted key without accepting its explanatory value as a title.
      if (clean.startsWith("{")) {
        try {
          return recoverFromObject(JSON.parse(clean), depth + 1);
        } catch {
          const keyMatch = clean.match(/^\{\s*["']([^"'\n]{4,100})["']\s*:/) ||
            clean.match(/^\{\s*"([^"\n]{4,100})"\s*:/);
          if (keyMatch) return cleanRecoveredTitle(keyMatch[1]);
        }
      }
      return cleanRecoveredTitle(clean);
    }

    if (typeof value !== "object" || Array.isArray(value)) return "";
    if (typeof value.title === "string") return recoverFromObject(value.title, depth + 1);

    // Another common Ollama error is {"Generated title":"explanation"}.
    // A sole non-generic key is a safe candidate; validation still decides
    // whether its length and single-level structure are acceptable.
    const keys = Object.keys(value);
    if (keys.length === 1 && !/^(title|result|response|output|explanation|reason|message|details)$/i.test(keys[0])) {
      return cleanRecoveredTitle(keys[0]);
    }
    return "";
  }

  function extractTitleCandidate(parsed, content = "") {
    const recovered = recoverFromObject(parsed);
    if (recovered) return recovered;

    const cleanContent = normalize(content);
    if (!cleanContent) return "";
    try {
      return recoverFromObject(JSON.parse(cleanContent));
    } catch {
      return "";
    }
  }

  function hasTooManySections(title) {
    return (normalize(title).match(/\s+-\s+/g) || []).length > 1;
  }

  function looksLikeSentenceTitleZh(title) {
    const clean = normalize(title);
    return /[？?。.!！]$/.test(clean) ||
      /^(我|我们|今天|下午|上午|刚才|现在|这我|有学习到|我看|我用|不不不|请问|怎么|如何|为什么|能讲解|讲解下|可以讲解|能解释|可以解释)/.test(clean) ||
      /(算什么|是什么|这些内容|知识体系|有些混|有点混|不太懂|看不懂|什么意思)$/.test(clean) ||
      (clean.length > 24 && /[，,。；;？?]/.test(clean));
  }

  function looksLikeSentenceTitleEn(title) {
    const clean = normalize(title);
    return /[?.!]$/.test(clean) ||
      /^(i |we |how |why |what |when |should |can |could |please |let's )/i.test(clean) ||
      (clean.length > 48 && /,/.test(clean));
  }

  // Shared structural checks plus language-specific sentence heuristics.
  function isBadTitle(title, language) {
    const clean = normalize(title);
    if (!clean || clean.length < 4) return true;
    // Do not silently truncate generated titles. Rejecting an overlong or
    // multi-level result lets the repair pass ask the model to compress it.
    if (clean.length > (language === "en" ? 56 : 34)) return true;
    if (hasTooManySections(clean)) return true;
    if (/[�]|(\?\?)/.test(clean)) return true;
    if (BAD_AI_TITLE_RE.test(clean)) return true;
    if (BAD_UI_TITLE_RE.test(clean)) return true;
    return language === "en" ? looksLikeSentenceTitleEn(clean) : looksLikeSentenceTitleZh(clean);
  }

  NS.validators = {
    BAD_UI_TITLE_RE,
    BAD_AI_TITLE_RE,
    normalize,
    normalizeAiTitle,
    extractTitleCandidate,
    hasTooManySections,
    isBadTitle
  };
})();
