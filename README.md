# Threadsmith

Shape messy ChatGPT history into clear, searchable titles.

## Files

- `manifest.json` defines the Chrome extension permissions, popup, background worker, and ChatGPT content script.
- `content_script.js` runs inside ChatGPT. It owns the floating card UI, scans visible sessions, extracts recent conversation text, orchestrates title generation, shows the review table, and applies confirmed renames through ChatGPT's native title editor.
- `service_worker.js` is the transport layer. It runs the OpenAI-compatible `/chat/completions` request in the background so calls use the extension's host permissions and are not blocked by the ChatGPT page's CORS policy.
- `lib/providers.js` holds provider presets (DeepSeek, OpenAI, OpenRouter, Custom), the settings schema + migration, and transport resolution. Shared by the content script and the popup.
- `lib/prompts.js` holds the per-language title prompt templates.
- `lib/validators.js` holds the shared and per-language title validation rules.
- `popup.html`, `popup.css`, and `popup.js` provide the small extension popup for opening the review workflow and saving provider settings.
- `icons/` contains extension icons.

## Workflow

1. Open `https://chatgpt.com`.
2. Scroll the ChatGPT sidebar until the sessions you want are visible.
3. Click the floating `R` button or the extension popup.
4. Click `Review Titles`.
5. Select sessions.
6. Generate title previews.
7. Edit or uncheck anything you do not like.
8. Apply selected renames.

## Current Scope

- Reads visible ChatGPT sidebar sessions only.
- Opens each selected session and extracts recent conversation text.
- Generates titles through any OpenAI-compatible provider (DeepSeek, OpenAI, OpenRouter, or a custom endpoint).
- Generates Simplified Chinese titles by default and keeps proper nouns in English. (English output is a wired-in language slot, tuned later.)
- Requires preview and confirmation before writing titles back to ChatGPT.
- Skips bad or failed suggestions instead of using generic fallback titles.

## Settings

- `Provider` — DeepSeek, OpenAI, OpenRouter, or Custom (OpenAI-compatible)
- `API key`
- `Model` — defaults to the selected provider's default (e.g. `deepseek-v4-flash`)
- `Base URL` — shown for the Custom provider only

Settings are stored in `chrome.storage.local` under `threadsmith.settings`. The
old `cso.settings` key is migrated automatically on first load. A custom
endpoint requires granting host access from the toolbar popup (`optional_host_permissions`).

## Install Locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select:

   `C:\Users\Jonathan Lai\Downloads\Threadsmith`

5. Open `https://chatgpt.com`.
6. Reload the extension after code changes.
