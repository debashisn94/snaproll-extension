# Snaproll — Full Page Screenshot (Chrome, MV3)

> Snap the whole scroll.

Capture an entire scrollable web page, then **crop** and download it as **PNG, JPG, or PDF** — a lightweight GoFullPage alternative. Zero external dependencies.

## How it works
1. Click the toolbar icon (or press **Alt+Shift+S**) on any normal web page.
2. Snaproll pins the layout first (sticky → relative, fixed backgrounds → scroll), hides the scrollbar and, after the first tile, repeating fixed bars (via `visibility`, so nothing reflows). On app-style pages where the window doesn't scroll (Gmail, Notion, ChatGPT…) it finds the inner scrolling panel and captures that instead. It scrolls tile-by-tile at Chrome's 2 captures/sec ceiling.
3. Tiles are stitched at full device-pixel resolution and the **editor tab** opens.

## Editor (all free, all local)
| Tool | Key | Notes |
|---|---|---|
| Rectangle | R | Shift = square |
| Arrow | A | Shift = snap to 45° |
| Highlighter | H | translucent marker |
| Text | T | click, type, Enter (Shift+Enter = new line) |
| Blur / redact | B | pixelates emails, names, numbers |
| Crop | C | drag, then Enter |
| Undo / Redo | ⌘Z / ⇧⌘Z | 60 steps, crop included |
| Size | 1 2 3 | S / M / L |
| Save PNG / Copy | ⌘S / ⌘C | copy auto-shrinks past 25 MP so Google Docs pastes it whole |

**Export options (⚙):**
- **Frame**: none, a macOS-style browser window with the page URL, or a URL + capture date footer.
- **Padded background + shadow** for slides and social posts.
- **PDF pages**: one long page, or A4 / US Letter split into pages with page numbers. **Smart split** cuts in the whitespace between lines, not through text.
- **File name template**: `{title} {host} {date} {time}`; a `/` makes a subfolder in Downloads (`Snaproll/{host}-{date}`).
- **After capture**: open the editor, or download PNG/JPG/PDF straight away (the editor runs in a background tab and closes itself).

The PDF is written by hand (one JPEG `DCTDecode` image per page + Helvetica footer). No libraries are bundled, and nothing leaves the machine.

### vs GoFullPage 8.11
GoFullPage puts annotation, blur, text, shapes, URL/date stamp, padding and browser frames behind its Premium plan and needs an account to export edits. Snaproll does all of that free, offline, with no sign-in, using the same capture engine (reverse-engineered from GoFullPage 8.9 in v1.1).

## Files
```
manifest.json    MV3 config
background.js    service worker — capture orchestration (scroll + stitch plan)
editor.html/.css/.js   editor tab — stitch, annotate, crop, frame, export (PNG/JPG/PDF/copy)
icons/           16/32/48/128 px
```

## Load it (unpacked, for dev/personal use)
1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. **Load unpacked** → select this `snaproll/` folder
4. Pin the icon, open any page, click it.

Works on Chrome, Edge, Brave, Arc. It cannot capture `chrome://`, the Web Store, or other extension pages (browser restriction) — the badge flashes `no` there.

## Ship it to the Chrome Web Store
1. Zip the folder contents (not the parent):
   ```
   cd snaproll && zip -r ../snaproll.zip . -x ".*"
   ```
2. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) — one-time **$5** registration.
3. **New item** → upload `snaproll.zip`.
4. Fill the listing: description, at least one 1280×800 screenshot, a 128px icon (included), category *Productivity*, and a privacy policy.
   - Privacy note you can reuse: *Snaproll processes screenshots entirely on your device. It does not collect, transmit, or store any data on external servers.*
5. Justify permissions: `activeTab`/`<all_urls>` (capture the page you invoke it on), `scripting` (measure + scroll), `storage`/`unlimitedStorage` (hand the large stitched image to the editor tab, remember export options), `downloads` (subfolders + auto-download).
6. Submit for review (usually a few days).

## Known limits
- Pages past Chrome's canvas limits (~32K px a side / ~250M px) are scaled down to fit; the editor footer says so.
- Very long pages take a while (Chrome caps capture at 2 tiles/sec).
- Annotations can't be moved after drawing yet; undo and redraw.
- Lazy-loaded / canvas / video content may need a scroll-through first.
- Cross-origin iframes render as the browser paints them (no special handling).
