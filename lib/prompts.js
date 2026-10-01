// Prompt template layer. Keeps the tuned title prompts per language so the
// transport layer and the orchestration layer stay free of prompt wording.
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
    "Use the format: specific noun/object - compact topic or task. Use exactly one spaced hyphen ( - ) unless the title is clearer without a separator.",
    "Optimize for the shortest title that remains specific and searchable. If two titles mean the same thing, always choose the shorter one.",
    "For mostly Chinese titles, target 12-22 characters. For mixed Chinese and English, stay within 28 characters when possible. Never exceed 34 characters.",
    "Keep only one primary object and one core task. Remove redundant category layers, filler, and words such as 完整, 详细, 最新, 方法汇总 when they add no distinguishing meaning.",
    "Good examples: NUC9 - 内存更换拆解指南, Jev - 模型介绍与定位, Git分支 - 开发与测试流程, Emby TV - 旧版APK安装, NUC - Proxmox重装与HA验证.",
    "Avoid verbose titles such as 三星电视 - 遥控器故障 - 3D模式关闭指南 or NUC - Proxmox Reinstall and HA API Verification.",
    "Do not use broad prefixes like General, Life, Research, 生活, 研究, 学习.",
    "Do not copy the user's full question. Do not write a sentence, question, or first-person title.",
    "Never use UI boilerplate as a title."
  ].join(" ");

  const EN_SYSTEM = [
    "You rename ChatGPT conversations for retrieval.",
    "Return only valid JSON: {\"title\":\"...\"}.",
    "Write the title in concise English.",
    "Keep proper nouns, brands, code names, airports, tools, and technical names as written.",
    "Preferred style: specific noun/object prefix, one spaced hyphen, compact topic/task.",
    "Choose the shortest title that remains specific and searchable; never exceed 56 characters.",
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

    const repairConstraint = lang === "zh"
      ? "Rewrite it as a different, shorter title. It must be 34 characters or fewer, use at most one spaced hyphen ( - ), and preserve only the primary object and core task."
      : "Rewrite it as a different, shorter title. It must be 56 characters or fewer and use at most one spaced hyphen ( - ).";

    const user = repair
      ? `Old title: ${originalTitle}\nBad title: ${repair.badTitle}\nProblem: ${repair.reason}\nRequired correction: ${repairConstraint}\n\nConversation excerpt:\n${transcript}\n\nReturn JSON only.`
      : `Old title: ${originalTitle}\n\nConversation excerpt:\n${transcript}\n\nReturn JSON only.`;

    return [
      { role: "system", content: system },
      { role: "user", content: user }
    ];
  }

  NS.prompts = { PROMPTS, resolveLanguage, buildTitleMessages };
})();
