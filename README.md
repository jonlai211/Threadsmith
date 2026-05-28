# ChatGPT Session Renamer

Chrome extension MVP for renaming visible ChatGPT sessions with AI-generated Chinese titles.

## Files

- `manifest.json` defines the Chrome extension permissions, popup, background worker, and ChatGPT content script.
- `content_script.js` runs inside ChatGPT. It scans visible sessions, extracts recent conversation text, calls the title provider, shows the review table, and applies confirmed renames through ChatGPT's native title editor.
- `popup.html`, `popup.css`, and `popup.js` provide the small extension popup for opening the review workflow and saving provider settings.
- `service_worker.js` is intentionally minimal; most behavior lives in the ChatGPT tab.
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
- Uses DeepSeek to generate Chinese titles.
- Keeps proper nouns in English.
- Requires preview and confirmation before writing titles back to ChatGPT.
- Skips bad or failed suggestions instead of using generic fallback titles.

## Settings

- `Provider key`
- `Model`, defaulting to `deepseek-v4-flash`

Settings are stored in `chrome.storage.local`.

## Install Locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select:

   `C:\Users\Jonathan Lai\Downloads\chatgpt-session-organizer`

5. Open `https://chatgpt.com`.
6. Reload the extension after code changes.
