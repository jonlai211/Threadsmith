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

async function postChatCompletions(transport, body, label) {
  const baseURL = String(transport.baseURL || "").replace(/\/+$/, "");
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${transport.apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`${label} failed: ${response.status} ${text.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function requestChatJson({ transport, payload, label }) {
  if (!transport?.apiKey) throw new Error(`${label}: add a provider API key first.`);
  if (!transport?.baseURL) throw new Error(`${label}: set the provider base URL first.`);

  const baseBody = {
    model: payload.model,
    messages: payload.messages,
    temperature: payload.temperature ?? 0.2,
    max_tokens: payload.maxTokens || 450,
    stream: false
  };
  if (payload.jsonMode) baseBody.response_format = { type: "json_object" };

  let data = await postChatCompletions(transport, baseBody, label);
  let choice = data?.choices?.[0] || {};
  let content = choice.message?.content || "";
  let parsed = content ? safeJsonParse(content) : null;
  if (parsed) return { parsed, content };

  // Retry once: drop JSON mode, nudge for compact JSON, raise the token ceiling.
  const retryBody = {
    ...baseBody,
    messages: [
      ...payload.messages,
      { role: "user", content: "The previous response was empty or invalid. Return ONLY a compact JSON object now. No markdown. No explanation." }
    ],
    max_tokens: Math.max(baseBody.max_tokens, 700)
  };
  delete retryBody.response_format;

  data = await postChatCompletions(transport, retryBody, label);
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
