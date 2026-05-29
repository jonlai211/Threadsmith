// Prompt template layer. Keeps the tuned title prompts per language so the
// transport layer and the orchestration layer stay free of prompt wording.
// The Simplified-Chinese template is the original, unchanged prompt; the
// English template is a structural slot (tuned in Phase 2).
(function () {
  const NS = (window.Threadsmith = window.Threadsmith || {});

  function normalize(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function limitText(text, maxChars) {
    const clean = normalize(text);
    return clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
  }

  function buildTranscript(messages, messageLimit, charLimit) {
    return messages
      .slice(-messageLimit)
      .map((message, index) => `${index + 1}. ${message.role || "message"}: ${limitText(message.text, charLimit)}`)
      .join("\n");
  }

  const ZH_SYSTEM = [
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

  const EN_SYSTEM = [
    "You rename ChatGPT conversations for retrieval.",
    "Return only valid JSON: {\"title\":\"...\"}.",
    "Write the title in concise English.",
    "Keep proper nouns, brands, code names, airports, tools, and technical names as written.",
    "Preferred style: specific noun/object prefix, hyphen, compact topic/task.",
    "Good examples: Watermark Removal - Method Roundup, Car Rental - Hertz Guide, Mastercard - Rental Insurance Denial.",
    "Do not use broad prefixes like General, Life, Research.",
    "Do not copy the user's full question. Do not write a sentence, question, or first-person title.",
    "Never use UI boilerplate as a title."
  ].join(" ");

  const PROMPTS = {
    zh: { system: ZH_SYSTEM },
    en: { system: EN_SYSTEM }
  };

  // Heuristic: treat text as Chinese when it carries a meaningful share of CJK
  // characters, otherwise English. Used when the setting is "auto".
  function detectLanguage(text) {
    const sample = String(text || "");
    const cjk = (sample.match(/[一-鿿]/g) || []).length;
    if (cjk === 0) return "en";
    const latin = (sample.match(/[A-Za-z]/g) || []).length;
    return cjk / (cjk + latin) >= 0.15 ? "zh" : "en";
  }

  // setting is "auto" | "zh" | "en"; sample is the text used for auto-detection.
  function resolveLanguage(setting, sample) {
    if (setting === "zh") return "zh";
    if (setting === "en") return "en";
    return detectLanguage(sample);
  }

  function buildTitleMessages({ language, originalTitle, messages, repair = null, options = {} }) {
    const lang = language === "en" ? "en" : "zh";
    const messageLimit = options.messageLimit || (repair ? 8 : 4);
    const charLimit = options.charLimit || (repair ? 700 : 500);
    const transcript = buildTranscript(messages, messageLimit, charLimit);
    const system = (PROMPTS[lang] || PROMPTS.zh).system;

    const user = repair
      ? `Old title: ${originalTitle}\nBad title: ${repair.badTitle}\nProblem: ${repair.reason}\n\nConversation excerpt:\n${transcript}\n\nReturn JSON only.`
      : `Old title: ${originalTitle}\n\nConversation excerpt:\n${transcript}\n\nReturn JSON only.`;

    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }

  NS.prompts = { PROMPTS, resolveLanguage, buildTitleMessages };
})();
