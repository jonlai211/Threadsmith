// Output validation layer. Shared checks (UI boilerplate, disclaimers, broken
// encoding) plus language-specific "this reads like a sentence" heuristics.
// The Simplified-Chinese rules are the original, unchanged regexes.
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
      .replace(/\s*[-:：]\s*$/, "")
      .slice(0, 60);
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

  // Generalized replacement for the original isBadAiTitle. zh keeps the exact
  // original behavior; en uses its own sentence heuristic.
  function isBadTitle(title, language) {
    const clean = normalize(title);
    if (!clean || clean.length < 4) return true;
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
    isBadTitle
  };
})();
