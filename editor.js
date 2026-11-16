// Snaproll — editor: stitch tiles, annotate, crop, export PNG / JPG / PDF.
// Everything runs in this tab. No network, no libraries.

const CAPTURE_KEY = "snaproll_capture";
const SETTINGS_KEY = "snaproll_settings";
const DEFAULTS = {
  frame: "none",        // none | browser | stamp
  padding: false,
  paper: "long",        // long | a4 | letter
  smartSplit: true,
  filename: "{title}-{date}-{time}",
  autoDownload: "off",  // off | png | jpg | pdf
};

const el = (id) => document.getElementById(id);
const view = el("view");
const vctx = view.getContext("2d");
const ink = el("ink");
const ictx = ink.getContext("2d");
const wrap = el("wrap");
const selection = el("selection");
const textInput = el("textInput");

let original = null;   // stitched capture, never modified
let base = null;       // current (possibly cropped) bitmap
let anns = [];         // vector annotations in base-pixel coords
let history = [];
let hIdx = -1;
let ds = 1;            // base px -> display px
let meta = null;
let settings = { ...DEFAULTS };

let tool = null;       // rect | arrow | hl | text | blur | crop | null
let color = "#ff3b5c";
let size = 1;
let drag = null;       // annotation being drawn, or the crop rect
let cropRect = null;
let inkBox = null;     // dirty rect on the ink layer (display px)
let textAt = null;

const STROKE = [2, 4, 7];   // × unit
const FONT = [14, 20, 30];  // × unit
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

init();

async function init() {
  try {
    const s = await chrome.storage.sync.get(SETTINGS_KEY);
    settings = { ...DEFAULTS, ...(s[SETTINGS_KEY] || {}) };
  } catch (e) { /* defaults */ }
  wireSettings();

  const store = await chrome.storage.local.get(CAPTURE_KEY);
  const data = store[CAPTURE_KEY];
  if (!data || !data.tiles || !data.tiles.length) {
    el("loading").classList.add("hidden");
    el("empty").classList.remove("hidden");
    return;
  }
  meta = data;
  original = await stitch(data);
  // The image now lives in this tab's canvas. Free the stored copy right away
  // so nothing lingers in chrome.storage; closing the tab discards everything.
  chrome.storage.local.remove(CAPTURE_KEY);

  base = original;
  commit();
  el("loading").classList.add("hidden");
  wrap.classList.remove("hidden");
  render();
  updateMeta();
  wireTools();

  const auto = new URLSearchParams(location.search).get("auto");
  if (auto) {
    await exportAs(auto);
    window.close();
  }
}

// --- stitching -------------------------------------------------------------

// Chrome refuses canvases past ~32767px a side or ~268M px total and silently
// returns a blank image, so very long pages are scaled down to fit.
const MAX_SIDE = 32000;
const MAX_AREA = 250e6;

function stitch(data) {
  return new Promise((resolve) => {
    const { tiles, totalWidth, totalHeight, dpr } = data;
    // v1.0 captures had no clip: each tile was the whole viewport.
    const clip = data.clip || { left: 0, top: 0, width: data.viewportW, height: data.viewportH };
    const w = totalWidth * dpr;
    const h = totalHeight * dpr;
    const fit = Math.min(1, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
    const k = dpr * fit; // CSS px -> output px
    const c = canvasOf(Math.round(totalWidth * k), Math.round(totalHeight * k));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    data.scaledDown = fit < 1;
    const draw = (t, img) => {
      const sx = clip.left * dpr;
      const sy = clip.top * dpr;
      const sw = Math.min(clip.width * dpr, img.width - sx);
      const sh = Math.min(clip.height * dpr, img.height - sy);
      ctx.drawImage(img, sx, sy, sw, sh,
        Math.round(t.x * k), Math.round(t.y * k), Math.round(sw * fit), Math.round(sh * fit));
    };
    Promise.all(tiles.map((t) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = t.dataUrl;
    }))).then((imgs) => {
      imgs.forEach((img, i) => img && draw(tiles[i], img));
      resolve(c);
    });
  });
}

// --- history ---------------------------------------------------------------

function snapshot() { return anns.map(({ _px, _pxKey, ...a }) => ({ ...a })); }

function commit() {
  history = history.slice(0, hIdx + 1);
  history.push({ base, anns: snapshot() });
  if (history.length > 60) history.shift();
  hIdx = history.length - 1;
  syncButtons();
  updateMeta();
}

function undo() { if (hIdx > 0) { hIdx--; restore(); } }
function redo() { if (hIdx < history.length - 1) { hIdx++; restore(); } }

function restore() {
  const h = history[hIdx];
  base = h.base;
  anns = h.anns.map((a) => ({ ...a }));
  cancelCrop();
  render();
  updateMeta();
  syncButtons();
}

function syncButtons() {
  el("undoBtn").disabled = hIdx <= 0;
  el("redoBtn").disabled = hIdx >= history.length - 1;
  el("resetBtn").disabled = base === original && anns.length === 0;
}

// --- drawing ---------------------------------------------------------------

const unit = () => Math.max(1, base.width / 1400);

function render() {
  const avail = Math.max(200, Math.min(window.innerWidth - 48, base.width));
  ds = avail / base.width;
  const dw = Math.round(base.width * ds);
  const dh = Math.round(base.height * ds);
  if (view.width !== dw || view.height !== dh) {
    view.width = ink.width = dw;
    view.height = ink.height = dh;
  }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.imageSmoothingQuality = "high";
  vctx.drawImage(base, 0, 0, dw, dh);
  vctx.setTransform(ds, 0, 0, ds, 0, 0);
  drawAnns(vctx, anns);
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.clearRect(0, 0, ink.width, ink.height);
  inkBox = null;
}

function drawAnns(ctx, list) {
  // Redactions go first so they never hide an arrow or label drawn on top.
  for (const a of list) if (a.type === "blur") drawAnn(ctx, a);
  for (const a of list) if (a.type !== "blur") drawAnn(ctx, a);
}

function norm(a) {
  return {
    x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2),
    w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1),
  };
}

function drawAnn(ctx, a) {
  ctx.save();
  const r = norm(a);
  switch (a.type) {
    case "rect":
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.w;
      ctx.lineJoin = "round";
      roundRectPath(ctx, r.x, r.y, r.w, r.h, a.w * 1.5);
      ctx.stroke();
      break;
    case "hl":
      ctx.globalAlpha = 0.34;
      ctx.fillStyle = a.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      break;
    case "arrow":
      drawArrow(ctx, a);
      break;
    case "blur":
      pixelate(ctx, a, r);
      break;
    case "text":
      drawText(ctx, a);
      break;
  }
  ctx.restore();
}

function drawArrow(ctx, a) {
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const head = Math.min(len * 0.6, a.w * 4.5);
  const ang = Math.atan2(dy, dx);
  const bx = a.x2 - Math.cos(ang) * head * 0.8;
  const by = a.y2 - Math.sin(ang) * head * 0.8;
  ctx.strokeStyle = ctx.fillStyle = a.color;
  ctx.lineWidth = a.w;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(a.x2 - Math.cos(ang - 0.45) * head, a.y2 - Math.sin(ang - 0.45) * head);
  ctx.lineTo(a.x2 - Math.cos(ang + 0.45) * head, a.y2 - Math.sin(ang + 0.45) * head);
  ctx.closePath();
  ctx.fill();
}

function pixelate(ctx, a, r) {
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.min(base.width, Math.round(r.x + r.w)) - x;
  const h = Math.min(base.height, Math.round(r.y + r.h)) - y;
  if (w < 2 || h < 2) return;
  const key = `${x},${y},${w},${h}`;
  if (!a._px || a._pxKey !== key || a._pxBase !== base) {
    const blk = Math.max(6, Math.round(unit() * 7));
    const c = canvasOf(Math.max(1, Math.ceil(w / blk)), Math.max(1, Math.ceil(h / blk)));
    const cx = c.getContext("2d");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(base, x, y, w, h, 0, 0, c.width, c.height);
    a._px = c;
    a._pxKey = key;
    a._pxBase = base;
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(a._px, x, y, w, h);
}

function drawText(ctx, a) {
  ctx.font = `700 ${a.fs}px ${FONT_STACK}`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, a.fs / 5);
  ctx.strokeStyle = isLight(a.color) ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.95)";
  ctx.fillStyle = a.color;
  a.text.split("\n").forEach((line, i) => {
    const ly = a.y1 + i * a.fs * 1.25;
    ctx.strokeText(line, a.x1, ly);
    ctx.fillText(line, a.x1, ly);
  });
}

function annBox(a) {
  const r = norm(a);
  const m = (a.w || 0) * 6 + 4;
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

function paintInk() {
  if (inkBox) ictx.clearRect(inkBox.x - 2, inkBox.y - 2, inkBox.w + 4, inkBox.h + 4);
  if (!drag) { inkBox = null; return; }
  const b = annBox(drag);
  inkBox = { x: b.x * ds, y: b.y * ds, w: b.w * ds, h: b.h * ds };
  ictx.setTransform(ds, 0, 0, ds, 0, 0);
  drawAnn(ictx, drag);
  ictx.setTransform(1, 0, 0, 1, 0, 0);
}

// --- tools -----------------------------------------------------------------

const HINTS = {
  rect: "Drag to draw a box. Hold Shift for a square.",
  arrow: "Drag from the tail to the point. Hold Shift to snap to 45°.",
  hl: "Drag over anything you want to highlight.",
  text: "Click where the label should start, type, then press Enter.",
  blur: "Drag over emails, names or numbers to pixelate them.",
  crop: "Drag to select the area to keep, then press Enter or Apply crop.",
};

function setTool(t) {
  if (textAt) commitText();
  if (tool === "crop" && t !== "crop") cancelCrop();
  tool = tool === t ? null : t;
  document.querySelectorAll("[data-tool]").forEach((b) =>
    b.classList.toggle("on", b.dataset.tool === tool));
  wrap.dataset.tool = tool || "";
  const hint = el("hint");
  hint.textContent = tool ? HINTS[tool] + "  Esc to stop." : "";
  hint.classList.toggle("hidden", !tool);
}

function setColor(c) {
  color = c;
  document.querySelectorAll(".sw").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
  if (textAt) textInput.style.color = c;
}

function setSize(n) {
  size = n;
  document.querySelectorAll("#sizes button").forEach((b) => b.classList.toggle("on", +b.dataset.size === n));
}

function wireTools() {
  document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  document.querySelectorAll(".sw").forEach((b) => (b.onclick = () => setColor(b.dataset.color)));
  document.querySelectorAll("#sizes button").forEach((b) => (b.onclick = () => setSize(+b.dataset.size)));
  setColor(color);
  setSize(size);

  el("undoBtn").onclick = undo;
  el("redoBtn").onclick = redo;
  el("resetBtn").onclick = () => {
    base = original;
    anns = [];
    commit();
    cancelCrop();
    render();
    updateMeta();
  };
  el("applyBtn").onclick = applyCrop;
  el("cancelBtn").onclick = cancelCrop;
  el("pngBtn").onclick = () => exportAs("png", el("pngBtn"));
  el("jpgBtn").onclick = () => exportAs("jpg", el("jpgBtn"));
  el("pdfBtn").onclick = () => exportAs("pdf", el("pdfBtn"));
  el("copyBtn").onclick = copyToClipboard;
  el("discardBtn").onclick = async () => {
    await chrome.storage.local.remove(CAPTURE_KEY);
    base = original = null;
    history = [];
    window.close(); // if the browser blocks close(), fall back to the empty state
    el("stage").innerHTML = '<div class="empty"><h2>Discarded</h2><p>You can close this tab.</p></div>';
  };

  wrap.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("resize", () => { if (!drag) { render(); if (cropRect) drawSelection(); } });
  document.addEventListener("keydown", onKey);

  textInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitText(); }
    else if (e.key === "Escape") { textAt = null; textInput.classList.add("hidden"); }
  });
  textInput.addEventListener("input", sizeTextInput);
  textInput.addEventListener("blur", () => { if (textAt) commitText(); });
}

function pt(e) {
  const r = view.getBoundingClientRect();
  const k = base.width / r.width;
  return {
    x: clamp((e.clientX - r.left) * k, 0, base.width),
    y: clamp((e.clientY - r.top) * k, 0, base.height),
  };
}

function onDown(e) {
  if (!tool || !base || e.button !== 0 || e.target === textInput) return;
  e.preventDefault();
  const p = pt(e);
  if (tool === "text") { openText(p); return; }
  if (tool === "crop") {
    cropRect = null;
    drag = { type: "crop", x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    el("applyBtn").classList.add("hidden");
    el("cancelBtn").classList.add("hidden");
    return;
  }
  drag = { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, w: STROKE[size] * unit() };
}

function onMove(e) {
  if (!drag) return;
  const p = pt(e);
  let { x, y } = p;
  if (e.shiftKey) {
    const dx = x - drag.x1;
    const dy = y - drag.y1;
    if (drag.type === "arrow") {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x = drag.x1 + Math.cos(ang) * len;
      y = drag.y1 + Math.sin(ang) * len;
    } else {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      x = drag.x1 + Math.sign(dx || 1) * s;
      y = drag.y1 + Math.sign(dy || 1) * s;
    }
  }
  drag.x2 = x;
  drag.y2 = y;
  if (drag.type === "crop") { cropRect = norm(drag); drawSelection(); }
  else paintInk();
}

function onUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  const r = norm(d);
  const tiny = Math.max(r.w, r.h) * ds < 4;
  if (d.type === "crop") {
    if (tiny) { cancelCrop(); return; }
    cropRect = r;
    drawSelection();
    el("applyBtn").classList.remove("hidden");
    el("cancelBtn").classList.remove("hidden");
    return;
  }
  if (tiny) { paintInk(); return; }
  anns.push(d);
  commit();
  render();
}

function onKey(e) {
  if (!base) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === "y") { e.preventDefault(); redo(); return; }
  if (mod && k === "s") { e.preventDefault(); exportAs("png", el("pngBtn")); return; }
  if (mod && k === "c") {
    if (!String(window.getSelection())) { e.preventDefault(); copyToClipboard(); }
    return;
  }
  if (mod || e.altKey) return;
  if (k === "escape") {
    if (cropRect || drag) cancelCrop();
    else setTool(null);
    el("settings").classList.add("hidden");
    return;
  }
  if (k === "enter" && cropRect) { applyCrop(); return; }
  const map = { r: "rect", a: "arrow", h: "hl", t: "text", b: "blur", c: "crop" };
  if (map[k]) { setTool(map[k]); return; }
  if (k === "v") { setTool(null); return; }
  if (k === "1" || k === "2" || k === "3") setSize(+k - 1);
}

// --- text ------------------------------------------------------------------

function openText(p) {
  if (textAt) commitText();
  const fs = FONT[size] * unit();
  textAt = { x: p.x, y: p.y, fs, color };
  textInput.value = "";
  textInput.style.left = p.x * ds + "px";
  textInput.style.top = p.y * ds + "px";
  textInput.style.fontSize = fs * ds + "px";
  textInput.style.color = color;
  textInput.classList.remove("hidden");
  sizeTextInput();
  textInput.focus({ preventScroll: true });
  setTimeout(() => textInput.focus({ preventScroll: true }), 0);
}

function sizeTextInput() {
  const lines = textInput.value.split("\n");
  textInput.rows = lines.length;
  textInput.style.width = Math.max(6, ...lines.map((l) => l.length + 2)) + "ch";
}

function commitText() {
  const t = textAt;
  textAt = null;
  textInput.classList.add("hidden");
  const text = textInput.value.replace(/\s+$/, "");
  if (!t || !text.trim()) return;
  anns.push({ type: "text", x1: t.x, y1: t.y, x2: t.x, y2: t.y, text, color: t.color, fs: t.fs });
  commit();
  render();
}

// --- crop ------------------------------------------------------------------

function drawSelection() {
  if (!cropRect || cropRect.w * ds < 2 || cropRect.h * ds < 2) {
    selection.classList.add("hidden");
    return;
  }
  selection.style.left = cropRect.x * ds + "px";
  selection.style.top = cropRect.y * ds + "px";
  selection.style.width = cropRect.w * ds + "px";
  selection.style.height = cropRect.h * ds + "px";
  selection.classList.remove("hidden");
}

function cancelCrop() {
  if (drag && drag.type === "crop") drag = null;
  cropRect = null;
  selection.classList.add("hidden");
  el("applyBtn").classList.add("hidden");
  el("cancelBtn").classList.add("hidden");
}

function applyCrop() {
  const r = cropRect;
  if (!r || r.w < 4 || r.h < 4) { cancelCrop(); return; }
  const sx = Math.round(r.x);
  const sy = Math.round(r.y);
  const sw = Math.round(r.w);
  const sh = Math.round(r.h);
  const out = canvasOf(sw, sh);
  out.getContext("2d").drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh);
  base = out;
  anns = anns.map(({ _px, _pxKey, _pxBase, ...a }) =>
    ({ ...a, x1: a.x1 - sx, x2: a.x2 - sx, y1: a.y1 - sy, y2: a.y2 - sy }));
  commit();
  cancelCrop();
  setTool(null);
  render();
  updateMeta();
  window.scrollTo({ top: 0 });
}

// --- compose (annotations + frame) -----------------------------------------

function flatten() {
  if (!anns.length) return base;
  const c = canvasOf(base.width, base.height);
  const x = c.getContext("2d");
  x.drawImage(base, 0, 0);
  drawAnns(x, anns);
  return c;
}

function composeOutput() {
  const img = flatten();
  const frame = settings.frame;
  const pad = settings.padding ? Math.round(Math.max(24, img.width * 0.045)) : 0;
  if (frame === "none" && !pad) return img;

  const u = Math.max(1, img.width / 1400);
  const barH = frame === "browser" ? Math.round(42 * u) : 0;
  const footH = frame === "stamp" ? Math.round(34 * u) : 0;
  const W = img.width + pad * 2;
  const H = img.height + barH + footH + pad * 2;
  const k = Math.min(1, MAX_SIDE / W, MAX_SIDE / H, Math.sqrt(MAX_AREA / (W * H)));
  const c = canvasOf(Math.round(W * k), Math.round(H * k));
  const x = c.getContext("2d");
  x.scale(k, k);

  const winH = barH + img.height + footH;
  const radius = pad ? Math.round(12 * u) : 0;
  if (pad) {
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#a99bff");
    g.addColorStop(1, "#6d5efc");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    x.save();
    x.shadowColor = "rgba(20, 10, 60, 0.38)";
    x.shadowBlur = pad * 0.7;
    x.shadowOffsetY = pad * 0.18;
    x.fillStyle = "#fff";
    roundRectPath(x, pad, pad, img.width, winH, radius);
    x.fill();
    x.restore();
  } else {
    x.fillStyle = "#fff";
    x.fillRect(0, 0, W, H);
  }
  x.save();
  roundRectPath(x, pad, pad, img.width, winH, radius);
  x.clip();
  if (barH) drawBrowserBar(x, pad, pad, img.width, barH, u);
  x.drawImage(img, pad, pad + barH);
  if (footH) drawStamp(x, pad, pad + barH + img.height, img.width, footH, u);
  x.restore();
  return c;
}

function drawBrowserBar(x, ox, oy, w, h, u) {
  x.fillStyle = "#efeef4";
  x.fillRect(ox, oy, w, h);
  x.fillStyle = "#d9d7e2";
  x.fillRect(ox, oy + h - Math.max(1, u), w, Math.max(1, u));
  const cy = oy + h / 2;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    x.fillStyle = c;
    x.beginPath();
    x.arc(ox + 20 * u + i * 20 * u, cy, 6 * u, 0, Math.PI * 2);
    x.fill();
  });
  const left = ox + 90 * u;
  const right = ox + w - 24 * u;
  if (right - left < 80 * u) return;
  const ph = h * 0.62;
  x.fillStyle = "#ffffff";
  roundRectPath(x, left, cy - ph / 2, right - left, ph, ph / 2);
  x.fill();
  x.font = `500 ${Math.round(14 * u)}px ${FONT_STACK}`;
  x.fillStyle = "#5b5870";
  x.textBaseline = "middle";
  x.fillText(fitText(x, prettyUrl(meta && meta.url), right - left - 28 * u), left + 14 * u, cy);
}

function drawStamp(x, ox, oy, w, h, u) {
  x.fillStyle = "#f7f6fb";
  x.fillRect(ox, oy, w, h);
  x.fillStyle = "#dedce6";
  x.fillRect(ox, oy, w, Math.max(1, u));
  x.font = `500 ${Math.round(13 * u)}px ${FONT_STACK}`;
  x.fillStyle = "#5f5c74";
  x.textBaseline = "middle";
  const when = new Date(meta ? meta.ts : Date.now()).toLocaleString();
  const ww = x.measureText(when).width;
  const cy = oy + h / 2;
  x.fillText(when, ox + w - 14 * u - ww, cy);
  x.fillText(fitText(x, (meta && meta.url) || "", w - ww - 48 * u), ox + 14 * u, cy);
}

// --- export ----------------------------------------------------------------

async function exportAs(kind, btn) {
  if (!base) return;
  try {
    if (btn) btn.disabled = true;
    if (kind === "pdf") await downloadPdf();
    else {
      const out = composeOutput();
      const mime = kind === "jpg" ? "image/jpeg" : "image/png";
      const blob = await toBlob(out, mime, kind === "jpg" ? 0.92 : undefined);
      await saveBlob(blob, fileName(kind));
    }
    if (btn) flash(btn, "Saved ✓");
  } catch (e) {
    console.error("[Snaproll] export failed", e);
    toast("Export failed: " + (e && e.message ? e.message : e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copyToClipboard() {
  try {
    let out = composeOutput();
    // Google Docs (and a few other apps) truncate pasted images past 25M px.
    const LIMIT = 25e6;
    if (out.width * out.height > LIMIT) {
      const f = Math.sqrt(LIMIT / (out.width * out.height));
      const s = canvasOf(Math.floor(out.width * f), Math.floor(out.height * f));
      const sx = s.getContext("2d");
      sx.imageSmoothingQuality = "high";
      sx.drawImage(out, 0, 0, s.width, s.height);
      out = s;
    }
    const blob = await toBlob(out, "image/png");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    flash(el("copyBtn"), "Copied ✓");
  } catch (e) {
    flash(el("copyBtn"), "Copy failed");
  }
}

function fileName(ext) {
  const d = new Date(meta ? meta.ts : Date.now());
  const tokens = {
    title: (meta && meta.title) || "",
    host: shortUrl(meta && meta.url),
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}${pad2(d.getMinutes())}`,
  };
  if (!tokens.title) tokens.title = tokens.host;
  // Only the template may create subfolders; a "/" inside a page title may not.
  const raw = (settings.filename || DEFAULTS.filename).replace(/\{(\w+)\}/g, (m, t) =>
    t in tokens ? String(tokens[t]).replace(/[\/\\]+/g, "-") : m);
  const parts = raw.split("/").map((seg) =>
    seg.replace(/[\\:*?"<>|\x00-\x1f~]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80))
    .filter((seg) => seg && seg !== "..");
  if (!parts.length) parts.push(`snaproll-${tokens.date}-${tokens.time}`);
  return parts.join("/") + "." + ext;
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    if (!chrome.downloads) throw new Error("no downloads api");
    const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
    await waitForDownload(id);
  } catch (e) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    await delay(1500);
  }
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function waitForDownload(id) {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChange);
      resolve();
    };
    const onChange = (d) => {
      if (d.id === id && d.state && d.state.current !== "in_progress") done();
    };
    const timer = setTimeout(done, 120000);
    chrome.downloads.onChanged.addListener(onChange);
    // It may already have finished before the listener was attached.
    chrome.downloads.search({ id }).then((r) => {
      if (r[0] && r[0].state !== "in_progress") done();
    });
  });
}

// --- PDF -------------------------------------------------------------------

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };

async function downloadPdf() {
  const img = composeOutput();
  const pages = [];
  if (settings.paper === "long" || !PAPER[settings.paper]) {
    // 1 image px = 1 pt, capped to PDF's 14400pt page limit.
    let pw = img.width;
    let ph = img.height;
    if (Math.max(pw, ph) > 14400) {
      const f = 14400 / Math.max(pw, ph);
      pw *= f;
      ph *= f;
    }
    pages.push({ canvas: img, PW: pw, PH: ph, x: 0, y: 0, w: pw, h: ph });
  } else {
    const [PW, PH] = PAPER[settings.paper];
    const M = 28;
    const FOOT = 16;
    // Never blow a small crop up past ~96 dpi-equivalent.
    const s = Math.min((PW - M * 2) / img.width, 0.75);
    const sliceH = Math.max(50, Math.floor((PH - M * 2 - FOOT) / s));
    const cuts = splitRows(img, sliceH, settings.smartSplit);
    const host = shortUrl(meta && meta.url);
    cuts.forEach(([y0, y1], i) => {
      const hpx = y1 - y0;
      const c = canvasOf(img.width, hpx);
      const cx = c.getContext("2d");
      cx.fillStyle = "#fff";
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(img, 0, y0, img.width, hpx, 0, 0, img.width, hpx);
      const w = img.width * s;
      const h = hpx * s;
      pages.push({
        canvas: c, PW, PH,
        x: (PW - w) / 2, y: PH - M - h, w, h,
        footer: { text: `${host}   ${i + 1} / ${cuts.length}`, x: M, y: M / 2 },
      });
    });
  }
  for (const p of pages) {
    p.jpeg = new Uint8Array(await (await toBlob(p.canvas, "image/jpeg", 0.92)).arrayBuffer());
    p.iw = p.canvas.width;
    p.ih = p.canvas.height;
    p.canvas = null;
  }
  const pdf = buildPdf(pages);
  await saveBlob(new Blob([pdf], { type: "application/pdf" }), fileName("pdf"));
}

// Cut long screenshots into page-height slices. With smart split on, look in
// the bottom quarter of each slice for the row with the fewest colour changes
// (the whitespace between lines or blocks), so text isn't cut in half.
function splitRows(img, sliceH, smart) {
  const H = img.height;
  const out = [];
  const ctx = smart ? img.getContext("2d") : null;
  let y = 0;
  while (y < H) {
    let end = Math.min(H, y + sliceH);
    if (smart && end < H) {
      const from = end - Math.floor(sliceH * 0.25);
      const cut = findCut(ctx, img.width, Math.max(y + 1, from), end);
      if (cut > y) end = cut;
    }
    out.push([y, end]);
    y = end;
  }
  return out;
}

function findCut(ctx, W, from, to) {
  const rows = to - from;
  if (rows <= 1) return to;
  const data = ctx.getImageData(0, from, W, rows).data;
  const stride = Math.max(1, Math.floor(W / 800)) * 4;
  let best = to;
  let bestScore = Infinity;
  for (let r = rows - 1; r >= 0; r--) {
    const o = r * W * 4;
    let score = 0;
    for (let i = o + stride; i < o + W * 4; i += stride) {
      const d = Math.abs(data[i] - data[i - stride]) + Math.abs(data[i + 1] - data[i + 1 - stride]) +
        Math.abs(data[i + 2] - data[i + 2 - stride]);
      if (d > 30) score++;
    }
    if (score < bestScore) { bestScore = score; best = from + r; }
    if (score === 0) break; // clean row nearest the page bottom; take it
  }
  return best;
}

// Minimal multi-page PDF: one JPEG (DCTDecode) per page + optional Helvetica footer.
function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offsets = [];
  const raw = (b) => { parts.push(b); len += b.length; };
  const str = (s) => raw(enc.encode(s));
  const obj = (n, body) => { offsets[n] = len; str(`${n} 0 obj\n${body}\nendobj\n`); };
  const f = (v) => (Math.round(v * 100) / 100).toString();

  const n = pages.length;
  const pageObj = (i) => 4 + i * 3;
  str("%PDF-1.4\n");
  raw(new Uint8Array([0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]));
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] /Count ${n} >>`);
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  pages.forEach((p, i) => {
    const po = pageObj(i);
    obj(po,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.PW)} ${f(p.PH)}] ` +
      `/Resources << /XObject << /Im${i} ${po + 1} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${po + 2} 0 R >>`);
    offsets[po + 1] = len;
    str(`${po + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.iw} /Height ${p.ih} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
    raw(p.jpeg);
    str("\nendstream\nendobj\n");
    let content = `q ${f(p.w)} 0 0 ${f(p.h)} ${f(p.x)} ${f(p.y)} cm /Im${i} Do Q`;
    if (p.footer) {
      content += `\nBT /F1 8 Tf 0.45 0.43 0.52 rg ${f(p.footer.x)} ${f(p.footer.y)} Td (${pdfText(p.footer.text)}) Tj ET`;
    }
    offsets[po + 2] = len;
    str(`${po + 2} 0 obj\n<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const count = 4 + n * 3;
  const xrefStart = len;
  str(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let k = 1; k < count; k++) str(`${String(offsets[k]).padStart(10, "0")} 00000 n \n`);
  str(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function pdfText(s) {
  return String(s).replace(/[^\x20-\x7e]/g, "").replace(/([\\()])/g, "\\$1");
}

// --- settings --------------------------------------------------------------

function wireSettings() {
  const panel = el("settings");
  const fields = panel.querySelectorAll("[name]");
  fields.forEach((f) => {
    const v = settings[f.name];
    if (f.type === "checkbox") f.checked = !!v;
    else f.value = v;
    f.addEventListener("change", saveSettings);
    if (f.type === "text") f.addEventListener("input", saveSettings);
  });
  el("settingsBtn").onclick = (e) => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
    el("settingsBtn").classList.toggle("on", !panel.classList.contains("hidden"));
  };
  document.addEventListener("pointerdown", (e) => {
    if (!panel.contains(e.target) && e.target !== el("settingsBtn") && !el("settingsBtn").contains(e.target)) {
      panel.classList.add("hidden");
      el("settingsBtn").classList.remove("on");
    }
  });
}

function saveSettings() {
  el("settings").querySelectorAll("[name]").forEach((f) => {
    settings[f.name] = f.type === "checkbox" ? f.checked : f.value;
  });
  try { chrome.storage.sync.set({ [SETTINGS_KEY]: settings }); } catch (e) { /* ignore */ }
}

// --- small utils -----------------------------------------------------------

function updateMeta() {
  if (!base || !meta) return;
  const n = anns.length;
  el("meta").textContent =
    `${base.width} × ${base.height}px${meta.scaledDown ? " (scaled to fit browser limits)" : ""}` +
    `${n ? `  ·  ${n} annotation${n > 1 ? "s" : ""}` : ""}` +
    `  ·  ${shortUrl(meta.url)}  ·  captured ${new Date(meta.ts).toLocaleString()}` +
    `  ·  R A H T B C tools · ⌘Z undo · ⌘S save`;
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function toBlob(canvas, mime, q) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("image too large to encode"))), mime, q));
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, s, max) {
  s = s || "";
  if (ctx.measureText(s).width <= max) return s;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pad2(n) { return String(n).padStart(2, "0"); }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function shortUrl(u) {
  try { return new URL(u).hostname; } catch (e) { return u || "page"; }
}

function prettyUrl(u) {
  try {
    const p = new URL(u);
    return p.hostname.replace(/^www\./, "") + (p.pathname === "/" ? "" : p.pathname);
  } catch (e) { return u || ""; }
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}

function toast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}
