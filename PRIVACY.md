# Threadsmith Privacy Policy

_Last updated: 2026-05-29_

Threadsmith is a Chrome extension that renames your ChatGPT conversations into
clearer, searchable titles. This policy explains exactly what the extension
does with your data.

## The short version

- Threadsmith has **no backend server**. The developer never receives your data.
- Your conversation text is sent **only** to the AI provider **you choose and
  configure** (e.g. DeepSeek, OpenAI, OpenRouter, or a custom endpoint), using
  **your own API key**, for the sole purpose of generating a title.
- Your settings (provider, API key, model, language) are stored **locally** in
  your browser via `chrome.storage.local`. They never leave your machine except
  as part of the request you trigger to your chosen provider.
- There is **no analytics, no tracking, and no telemetry**.

## What data is accessed

When you start a title review on `chatgpt.com` / `chat.openai.com`, Threadsmith:

1. Reads the conversation titles and links visible in the ChatGPT sidebar.
2. Opens the conversations you select and extracts a short excerpt of recent
   message text.
3. Sends that excerpt and the old title to the AI provider you configured, to
   generate a suggested new title.
4. After you preview and confirm, writes the new title back using ChatGPT's own
   rename feature.

The extension only acts on the conversations you explicitly select, and only
writes titles after you confirm.

## Where data goes

- **AI provider (your choice):** the conversation excerpt and old title are sent
  to the provider base URL you configured, authenticated with your API key.
  That provider's own privacy policy and terms govern how they handle the
  request. Threadsmith does not add, proxy, or intercept this traffic — the
  request goes directly from your browser to the provider.
- **Nowhere else.** No data is sent to the extension developer or any third
  party.

## What is stored

Stored locally in your browser (`chrome.storage.local`), never transmitted to
the developer:

- Selected provider and (optional) custom base URL
- Your API key
- Model name
- Title language preference

You can clear this at any time by removing the extension or clearing the
extension's storage.

## Permissions

- **Host access** to `chatgpt.com` / `chat.openai.com` — to read and rename
  conversations on the page.
- **Host access** to your chosen AI provider's API host — to send the title
  generation request. Custom endpoints are requested at runtime and only when
  you add one.
- **`storage`** — to save your settings locally.
- **`tabs` / `activeTab`** — to open the workflow in your active ChatGPT tab.

## Contact

For questions about this policy, open an issue on the project's repository.
