// Transport layer. Runs in the background so LLM requests use the extension's
// host permissions and are not blocked by the ChatGPT page's CORS policy
// (content-script fetches would fail for providers like OpenAI). Stateless:
// the content script resolves and passes the transport config per request.

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const REQUEST_TIMEOUT_MS = 60000;

function isOllamaTransport(transport) {
  try {
    const url = new URL(String(transport?.baseURL || ""));
    return url.port === "11434" || /ollama/i.test(url.hostname);
  } catch {
    return false;
  }
}

function prepareMessagesForOllama(messages) {
  return [
    {
      role: "system",
      content: "For this request, do not output reasoning. Answer immediately with only compact valid JSON."
    },
    ...(messages || [])
  ];
}

function choiceReasoning(choice) {
  return choice?.message?.reasoning || choice?.message?.reasoning_content || "";
}

async function postChatCompletions(transport, body, label) {
  const baseURL = String(transport.baseURL || "").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (transport.apiKey) headers.Authorization = `Bearer ${transport.apiKey}`;
  // Without a timeout a hung provider leaves the request pending forever, so the
  // UI stays stuck on "Reading…" and Stop (a between-iterations flag) can't
  // cancel the in-flight call. Abort after REQUEST_TIMEOUT_MS instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s — the provider did not respond.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`${label} failed: ${response.status} ${text.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function requestChatJson({ transport, payload, label }) {
  if (!transport?.baseURL) throw new Error(`${label}: set the provider base URL first.`);

  const isOllama = isOllamaTransport(transport);
  if (!isOllama && !transport?.apiKey) throw new Error(`${label}: add a provider API key first.`);
  const messages = isOllama ? prepareMessagesForOllama(payload.messages) : payload.messages;
  const maxTokens = payload.maxTokens || 450;
  const baseBody = {
    model: payload.model,
    messages,
    temperature: payload.temperature ?? 0.2,
    max_tokens: isOllama ? Math.max(maxTokens, 1200) : maxTokens,
    stream: false
  };
  if (isOllama) {
    baseBody.keep_alive = "1m";
    baseBody.think = false;
  }
  if (payload.jsonMode) baseBody.response_format = { type: "json_object" };

  let content = "";
  try {
    const data = await postChatCompletions(transport, baseBody, label);
    const choice = data?.choices?.[0] || {};
    content = choice.message?.content || "";
    const parsed = content ? safeJsonParse(content) : null;
    if (parsed) return { parsed, content };
  } catch (error) {
    // Strict JSON mode (response_format) makes some providers return a 400
    // "failed to validate JSON" instead of the raw output. That is recoverable
    // by retrying without strict mode. Any other HTTP error is fatal.
    const recoverable = payload.jsonMode && error.status === 400 && /json|validate/i.test(error.message || "");
    if (!recoverable) throw error;
  }

  // Retry once: drop JSON mode, nudge for compact JSON, raise the token ceiling.
  const retryBody = {
    ...baseBody,
    messages: [
      ...messages,
      { role: "user", content: "Return ONLY a compact JSON object now, exactly like {\"title\":\"...\"}. No markdown. No explanation." }
    ],
    max_tokens: Math.max(baseBody.max_tokens, isOllama ? 1800 : 700)
  };
  delete retryBody.response_format;

  const data = await postChatCompletions(transport, retryBody, label);
  const choice = data?.choices?.[0] || {};
  content = choice.message?.content || "";
  const parsed = content ? safeJsonParse(content) : null;
  if (!parsed) {
    const finish = choice.finish_reason ? ` finish_reason=${choice.finish_reason}` : "";
    const reasoning = choiceReasoning(choice);
    const reason = reasoning ? ` reasoning=${String(reasoning).slice(0, 120)}` : "";
    throw new Error(`${label} returned empty or invalid JSON:${finish}${reason} content=${content.slice(0, 120)}`);
  }
  return { parsed, content };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "TS_CHAT_JSON") {
    requestChatJson(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error), status: error.status }));
    return true; // Keep the message channel open for the async response.
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  // No setup needed; settings live in chrome.storage.local.
});
