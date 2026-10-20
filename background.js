// Snaproll — service worker
// Orchestrates a full-page capture: measure -> scroll tile-by-tile ->
// captureVisibleTab -> stash tiles in storage -> open the editor tab.

const CAPTURE_KEY = "snaproll_capture";
const RENDER_WAIT_MS = 150;      // let the page paint after each scroll
const OVERLAY_HIDE_AT_MS = 80;   // page hides the overlay itself this far into the wait
const MIN_CAPTURE_GAP_MS = 505;  // Chrome allows 2 captureVisibleTab calls/sec

let busy = false;

chrome.action.onClicked.addListener((tab) => {
  if (busy) return;
  if (!tab || tab.id == null) return;
  if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || "")) {
    badge("no", "#c0392b");
    setTimeout(clearBadge, 2000);
    return;
  }
  busy = true;
  run(tab)
    .catch((err) => {
      console.error("Snaproll capture failed:", err);
      badge("err", "#c0392b");
      setTimeout(clearBadge, 3000);
    })
    .finally(() => {
      busy = false;
    });
});

async function run(tab) {
  const info = await inject(tab.id, prepareCapture);
  const { totalWidth, totalHeight, stepW, stepH, clip, dpr } = info;

  const yStops = stops(totalHeight, stepH);
  const xStops = stops(totalWidth, stepW);
  const total = yStops.length * xStops.length;

  const tiles = [];
  let done = 0;
  let first = true;
  let lastCapture = 0;

  try {
    await inject(tab.id, createOverlay, [total]);
    await inject(tab.id, updateOverlay, [0, total]); // seed dots at 0

    for (const y of yStops) {
      for (const x of xStops) {
        // Overlay stays visible while the page settles; the page hides it
        // itself partway through, so no extra round-trip before the shot.
        const pos = await inject(tab.id, scrollTile, [x, y, !first, OVERLAY_HIDE_AT_MS]);
        await delay(RENDER_WAIT_MS);

        // Scroll + settle run inside Chrome's rate-limit window, not after it.
        const wait = lastCapture + MIN_CAPTURE_GAP_MS - Date.now();
        if (wait > 0) await delay(wait);
        lastCapture = Date.now();
        const dataUrl = await capture(tab.windowId);

        tiles.push({ x: pos.x, y: pos.y, dataUrl });
        first = false;
        done++;
        badge(`${Math.round((done / total) * 100)}`, "#6d5efc");
        await inject(tab.id, updateOverlay, [done, total]); // re-show + advance
      }
    }
  } finally {
    await inject(tab.id, restorePage); // always restore + remove overlay
  }

  await chrome.storage.local.set({
    [CAPTURE_KEY]: {
      tiles,
      totalWidth,
      totalHeight,
      clip, // viewport rect (CSS px) each tile is cut from
      dpr,
      url: tab.url,
      title: tab.title,
      ts: Date.now(),
    },
  });

  clearBadge();
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
}

// --- helpers ---------------------------------------------------------------

function stops(total, step) {
  const out = [];
  for (let v = 0; v < total; v += step) out.push(v);
  if (out.length === 0) out.push(0);
  return out;
}

async function capture(windowId) {
  for (let tries = 0; ; tries++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (e) {
      const quota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(e && e.message));
      if (tries >= (quota ? 40 : 1)) throw e;
      await delay(quota ? 50 : 300);
    }
  }
}

function inject(tabId, func, args = []) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func, args })
    .then((r) => (r && r[0] ? r[0].result : null));
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}
function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

// --- functions injected into the page (must be self-contained) -------------

function prepareCapture() {
  const doc = document.documentElement;
  const body = document.body;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const style = document.createElement("style");
  style.id = "__snaproll_style";
  style.textContent =
    "::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}" +
    "html{scrollbar-width:none!important}";
  (document.head || doc).appendChild(style);

  const s = (window.__snaproll = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrollBehavior: doc.style.scrollBehavior,
    scroller: null,
    hidden: [],
    styled: [],
  });
  doc.style.scrollBehavior = "auto";

  // Pin layout before measuring, so nothing reflows between tiles:
  // sticky -> relative (keeps its flow slot), fixed backgrounds -> scroll.
  const all = body ? body.querySelectorAll("*") : [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.position === "sticky") {
      setImportant(el, { position: "relative", top: "auto", bottom: "auto", left: "auto", right: "auto" });
    }
    if (cs.backgroundAttachment === "fixed") setImportant(el, { "background-attachment": "scroll" });
  }

  const pageW = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth);
  const pageH = Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight);

  // App-style pages (Gmail, Notion, ChatGPT…) don't scroll the window; an inner
  // element does. Find the biggest visible one and capture that instead.
  if (pageH <= vh + 15) {
    const el = findScroller(vw, vh);
    if (el) {
      const r = el.getBoundingClientRect();
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const clip = {
        left,
        top,
        width: Math.min(r.left + el.clientWidth, vw) - left,
        height: Math.min(r.top + el.clientHeight, vh) - top,
      };
      s.scroller = { el, top: el.scrollTop, left: el.scrollLeft, behavior: el.style.scrollBehavior };
      el.style.scrollBehavior = "auto";
      return {
        totalWidth: clip.width,
        totalHeight: Math.max(el.scrollHeight, clip.height),
        stepW: clip.width,
        stepH: clip.height,
        clip,
        dpr: window.devicePixelRatio || 1,
      };
    }
  }

  return {
    totalWidth: pageW,
    totalHeight: pageH,
    stepW: vw,
    stepH: vh,
    clip: { left: 0, top: 0, width: vw, height: vh },
    dpr: window.devicePixelRatio || 1,
  };

  function setImportant(el, props) {
    const prev = {};
    for (const k in props) {
      prev[k] = [el.style.getPropertyValue(k), el.style.getPropertyPriority(k)];
      el.style.setProperty(k, props[k], "important");
    }
    s.styled.push([el, prev]);
  }

  function findScroller(vw, vh) {
    let best = null;
    let bestH = 0;
    for (const el of all) {
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      if (sh <= ch + 5 || ch <= 50 || el.clientWidth <= 40 || sh <= bestH) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll" && cs.overflowY !== "overlay") continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const slack = 18;
      if (r.left + slack < 0 || r.top + slack < 0 || r.right > vw + slack || r.bottom > vh + slack) continue;
      best = el;
      bestH = sh;
    }
    return best;
  }
}

function scrollTile(x, y, hideFixed, hideOverlayAt) {
  const s = window.__snaproll;
  const ov = window.__snaproll_ov;
  if (ov) {
    clearTimeout(ov.hideTimer);
    ov.hideTimer = setTimeout(() => (ov.el.style.display = "none"), hideOverlayAt);
  }
  if (hideFixed && s && s.hidden.length === 0) {
    // After the first tile, hide fixed headers/widgets/banners so they don't
    // repeat on every tile. visibility (not display) = no reflow, no seams.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const all = document.body ? document.body.querySelectorAll("*") : [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue; // offscreen
      if (r.height >= vh - 2) continue; // full-height sidebar/backdrop: keep it on every tile
      s.hidden.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
  if (s && s.scroller) {
    const el = s.scroller.el;
    el.scrollTop = y;
    el.scrollLeft = x;
    return { x: el.scrollLeft, y: el.scrollTop };
  }
  window.scrollTo(x, y);
  return { x: window.scrollX, y: window.scrollY };
}

function createOverlay(total) {
  const CSS = `
    #__snaproll_ov{position:fixed;top:18px;left:50%;transform:translateX(-50%);
      width:336px;max-width:90vw;z-index:2147483647;pointer-events:none;
      background:rgba(24,22,38,0.68);
      -webkit-backdrop-filter:blur(24px) saturate(165%);
      backdrop-filter:blur(24px) saturate(165%);
      border:1px solid rgba(255,255,255,0.14);border-radius:18px;overflow:hidden;
      box-shadow:0 24px 70px rgba(0,0,0,.45),0 0 0 1px rgba(109,94,252,.12),
        inset 0 1px 0 rgba(255,255,255,.08);
      color:#eef0f7;animation:__sr_in .22s cubic-bezier(.2,.85,.25,1);
      font:400 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
    @keyframes __sr_in{from{opacity:0;transform:translateX(-50%) translateY(-10px) scale(.98)}
      to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
    #__snaproll_ov .sr-head{display:flex;align-items:center;gap:12px;padding:15px 18px 12px}
    #__snaproll_ov .sr-chip{width:32px;height:32px;flex:0 0 auto;border-radius:10px;
      display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#6d5efc,#8f7bff);
      box-shadow:0 6px 16px rgba(109,94,252,.5)}
    #__snaproll_ov .sr-chip svg{width:18px;height:18px;fill:#fff}
    #__snaproll_ov .sr-title{font-weight:700;font-size:16px;letter-spacing:.2px;line-height:1.1}
    #__snaproll_ov .sr-sub{font-size:11px;color:rgba(238,240,247,.5);margin-top:2px;letter-spacing:.2px}
    #__snaproll_ov .sr-body{padding:0 18px 18px}
    #__snaproll_ov .sr-label{color:rgba(238,240,247,.82);font-size:13px;margin:2px 0 14px}
    #__snaproll_ov .sr-dots{display:flex;align-items:center;gap:8px;height:20px}
    #__snaproll_ov .sr-dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto;
      background:rgba(255,255,255,.20);transition:background .2s}
    #__snaproll_ov .sr-dot.sr-pending{background:#8f7bff}
    #__snaproll_ov .sr-pac{width:18px;height:18px;flex:0 0 auto;border-radius:50%;
      background:#a996ff;box-shadow:0 0 12px rgba(143,123,255,.75);
      clip-path:polygon(100% 25%,50% 50%,100% 75%,100% 100%,0 100%,0 0,100% 0);
      animation:__sr_chomp .32s linear infinite}
    @keyframes __sr_chomp{0%,100%{clip-path:polygon(100% 25%,50% 50%,100% 75%,100% 100%,0 100%,0 0,100% 0)}
      50%{clip-path:polygon(100% 50%,50% 50%,100% 50%,100% 100%,0 100%,0 0,100% 0)}}`;
  const style = document.createElement("style");
  style.id = "__snaproll_ov_style";
  style.textContent = CSS;
  const el = document.createElement("div");
  el.id = "__snaproll_ov";
  el.innerHTML =
    '<div class="sr-head">' +
    '<span class="sr-chip"><svg viewBox="0 0 24 24"><path d="M9 3l-1.8 2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></span>' +
    '<span><span class="sr-title">Snaproll</span><span class="sr-sub" style="display:block">Snapping the whole scroll</span></span>' +
    "</div>" +
    '<div class="sr-body"><p class="sr-label">Screen capture in progress…</p>' +
    '<div class="sr-dots" id="__snaproll_dots"></div></div>';
  const root = document.documentElement;
  root.appendChild(style);
  root.appendChild(el);
  window.__snaproll_ov = { el, dots: el.querySelector("#__snaproll_dots"), style, total };
}

function updateOverlay(done, total) {
  const ov = window.__snaproll_ov;
  if (!ov) return;
  clearTimeout(ov.hideTimer);
  ov.el.style.display = "block";
  const N = Math.max(6, Math.min(16, total));
  const eaten = Math.min(N, Math.round((done / total) * N));
  let html = "";
  for (let i = 0; i < N; i++) {
    if (i < eaten) html += '<span class="sr-dot"></span>';
    else if (i === eaten) html += '<span class="sr-pac"></span>';
    else html += '<span class="sr-dot sr-pending"></span>';
  }
  ov.dots.innerHTML = html;
}

function restorePage() {
  const s = window.__snaproll;
  if (!s) return;
  for (const [el, val, prio] of s.hidden) {
    el.style.removeProperty("visibility");
    if (val) el.style.setProperty("visibility", val, prio || "");
  }
  for (const [el, prev] of s.styled) {
    for (const k in prev) {
      el.style.removeProperty(k);
      if (prev[k][0]) el.style.setProperty(k, prev[k][0], prev[k][1] || "");
    }
  }
  const st = document.getElementById("__snaproll_style");
  if (st) st.remove();
  const ov = window.__snaproll_ov;
  if (ov) {
    if (ov.el) ov.el.remove();
    if (ov.style) ov.style.remove();
    delete window.__snaproll_ov;
  }
  if (s.scroller) {
    const { el, top, left, behavior } = s.scroller;
    el.scrollTop = top;
    el.scrollLeft = left;
    el.style.scrollBehavior = behavior || "";
  }
  document.documentElement.style.scrollBehavior = s.scrollBehavior || "";
  window.scrollTo(s.scrollX, s.scrollY);
  delete window.__snaproll;
}
