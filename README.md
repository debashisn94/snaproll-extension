# Snaproll — Full Page Screenshot (Chrome, MV3)

> Snap the whole scroll.

Capture an entire scrollable web page, then **crop** and download it as **PNG, JPG, or PDF** — a lightweight GoFullPage alternative. Zero external dependencies.

## How it works
1. Click the toolbar icon (or press **Alt+Shift+S**) on any normal web page.
2. Snaproll pins the layout first (sticky → relative, fixed backgrounds → scroll), hides the scrollbar and, after the first tile, repeating fixed bars (via `visibility`, so nothing reflows). On app-style pages where the window doesn't scroll (Gmail, Notion, ChatGPT…) it finds the inner scrolling panel and captures that instead. It scrolls tile-by-tile, and captures each viewport with `chrome.tabs.captureVisibleTab` (badge shows % progress).
3. Tiles are stitched at full device-pixel resolution and an **editor tab** opens.
4. In the editor: drag to select a region → **Apply** to crop, then **Download PNG / JPG / PDF** or **Copy** to clipboard. **Reset** restores the original.

The PDF is written by hand as a single long page with the screenshot embedded as a JPEG (`DCTDecode`) — no libraries bundled.

## Files
```
manifest.json    MV3 config
background.js    service worker — capture orchestration (scroll + stitch plan)
editor.html/.css/.js   editor tab — stitch, crop, export (PNG/JPG/PDF/copy)
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
5. Justify permissions: `activeTab`/`<all_urls>` (capture the page you invoke it on), `scripting` (measure + scroll), `storage`/`unlimitedStorage` (hand the large stitched image to the editor tab).
6. Submit for review (usually a few days).

## Known limits
- Pages past Chrome's canvas limits (~32K px a side / ~250M px) are scaled down to fit; the editor footer says so.
- Very long pages take a while (capture is rate-limited to ~1 tile / 0.6s by Chrome).
- Lazy-loaded / canvas / video content may need a scroll-through first.
- Cross-origin iframes render as the browser paints them (no special handling).
