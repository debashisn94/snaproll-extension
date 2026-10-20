// Snaproll — editor: stitch tiles, crop, download PNG / JPG / PDF.

const CAPTURE_KEY = "snaproll_capture";

const el = (id) => document.getElementById(id);
const view = el("view");
const vctx = view.getContext("2d");
const wrap = el("wrap");
const selection = el("selection");

let full = null;        // full-resolution canvas (the working image)
let displayScale = 1;   // full px -> displayed px
let meta = null;

// crop drag state (in display/view pixel coords)
let cropMode = false;
let dragging = false;
let start = null;
let rect = null;

init();

async function init() {
  const store = await chrome.storage.local.get(CAPTURE_KEY);
  const data = store[CAPTURE_KEY];
  if (!data || !data.tiles || !data.tiles.length) {
    el("loading").classList.add("hidden");
    el("empty").classList.remove("hidden");
    return;
  }
  meta = data;
  full = await stitch(data);
  // Image now lives in this tab's canvas — free the on-disk copy immediately so
  // nothing lingers in chrome.storage. Closing the tab then discards everything.
  chrome.storage.local.remove(CAPTURE_KEY);
  el("loading").classList.add("hidden");
  render();
  el("resetBtn").disabled = false;
  el("meta").textContent =
    `${full.width} × ${full.height}px${data.scaledDown ? " (scaled to fit browser limits)" : ""}  ·  ${shortUrl(data.url)}  ·  captured ${new Date(data.ts).toLocaleString()}`;
  wireTools();
}

// Chrome refuses canvases past ~32767px a side or ~268M px total and silently
// returns a blank image, so very long pages are scaled down to fit.
const MAX_SIDE = 32000;
const MAX_AREA = 250e6;

function stitch(data) {
  return new Promise((resolve) => {
    const { tiles, totalWidth, totalHeight, dpr } = data;
    // v1.0 captures had no clip: each tile was the whole viewport.
    const clip = data.clip || { left: 0, top: 0, width: data.viewportW, height: data.viewportH };
    let w = totalWidth * dpr;
    let h = totalHeight * dpr;
    const fit = Math.min(1, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)));
    const k = dpr * fit; // CSS px -> output px
    const c = document.createElement("canvas");
    c.width = Math.round(totalWidth * k);
    c.height = Math.round(totalHeight * k);
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
    // Decode every tile at once instead of one after another.
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

function render() {
  const avail = Math.min(window.innerWidth - 48, full.width);
  displayScale = avail / full.width;
  const dw = Math.round(full.width * displayScale);
  const dh = Math.round(full.height * displayScale);
  view.width = dw;
  view.height = dh;
  vctx.imageSmoothingQuality = "high";
  vctx.clearRect(0, 0, dw, dh);
  vctx.drawImage(full, 0, 0, dw, dh);
}

// --- crop ------------------------------------------------------------------

function wireTools() {
  el("cropBtn").onclick = enterCrop;
  el("cancelBtn").onclick = exitCrop;
  el("applyBtn").onclick = applyCrop;
  el("resetBtn").onclick = async () => {
    full = await stitch(meta);
    exitCrop();
    render();
  };
  el("pngBtn").onclick = () => downloadImage("png");
  el("jpgBtn").onclick = () => downloadImage("jpg");
  el("pdfBtn").onclick = downloadPdf;
  el("copyBtn").onclick = copyToClipboard;
  el("discardBtn").onclick = async () => {
    await chrome.storage.local.remove(CAPTURE_KEY); // already cleared, but be sure
    full = null;
    window.close(); // if the browser blocks close(), fall back to the empty state
    el("stage").innerHTML = '<div class="empty"><h2>Discarded</h2><p>You can close this tab.</p></div>';
  };

  view.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("resize", () => { if (!cropMode) render(); });
}

function enterCrop() {
  cropMode = true;
  rect = null;
  wrap.classList.add("cropping");
  selection.classList.add("hidden");
  el("cropBtn").classList.add("hidden");
  el("applyBtn").classList.remove("hidden");
  el("cancelBtn").classList.remove("hidden");
  el("hint").classList.remove("hidden");
}

function exitCrop() {
  cropMode = false;
  dragging = false;
  rect = null;
  wrap.classList.remove("cropping");
  selection.classList.add("hidden");
  el("cropBtn").classList.remove("hidden");
  el("applyBtn").classList.add("hidden");
  el("cancelBtn").classList.add("hidden");
  el("hint").classList.add("hidden");
}

function localPoint(e) {
  const r = view.getBoundingClientRect();
  return {
    x: clamp(e.clientX - r.left, 0, view.width),
    y: clamp(e.clientY - r.top, 0, view.height),
  };
}

function onDown(e) {
  if (!cropMode) return;
  e.preventDefault();
  dragging = true;
  start = localPoint(e);
  rect = { x: start.x, y: start.y, w: 0, h: 0 };
  drawSelection();
}

function onMove(e) {
  if (!cropMode || !dragging) return;
  const p = localPoint(e);
  rect = {
    x: Math.min(start.x, p.x),
    y: Math.min(start.y, p.y),
    w: Math.abs(p.x - start.x),
    h: Math.abs(p.y - start.y),
  };
  drawSelection();
}

function onUp() {
  if (!cropMode) return;
  dragging = false;
}

function drawSelection() {
  if (!rect || rect.w < 2 || rect.h < 2) {
    selection.classList.add("hidden");
    return;
  }
  const base = view.getBoundingClientRect();
  const host = wrap.getBoundingClientRect();
  selection.style.left = base.left - host.left + rect.x + "px";
  selection.style.top = base.top - host.top + rect.y + "px";
  selection.style.width = rect.w + "px";
  selection.style.height = rect.h + "px";
  selection.classList.remove("hidden");
}

function applyCrop() {
  if (!rect || rect.w < 4 || rect.h < 4) {
    exitCrop();
    return;
  }
  const sx = Math.round(rect.x / displayScale);
  const sy = Math.round(rect.y / displayScale);
  const sw = Math.round(rect.w / displayScale);
  const sh = Math.round(rect.h / displayScale);
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
  full = out;
  exitCrop();
  render();
}

// --- export ----------------------------------------------------------------

function baseName() {
  let name = (meta && (meta.title || shortUrl(meta.url))) || "snaproll";
  name = name.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").slice(0, 60);
  const d = new Date(meta ? meta.ts : Date.now());
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `${name || "snaproll"}-${stamp}`;
}

function downloadImage(kind) {
  const mime = kind === "jpg" ? "image/jpeg" : "image/png";
  const q = kind === "jpg" ? 0.92 : undefined;
  full.toBlob((blob) => saveBlob(blob, `${baseName()}.${kind}`), mime, q);
}

function downloadPdf() {
  const dataUrl = full.toDataURL("image/jpeg", 0.92);
  const jpeg = dataUrlToBytes(dataUrl);
  const pdf = buildPdf(jpeg, full.width, full.height);
  saveBlob(new Blob([pdf], { type: "application/pdf" }), `${baseName()}.pdf`);
}

async function copyToClipboard() {
  try {
    const blob = await new Promise((r) => full.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    flash(el("copyBtn"), "Copied ✓");
  } catch (e) {
    flash(el("copyBtn"), "Copy failed");
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// --- minimal single-image PDF (JPEG via DCTDecode) -------------------------

function buildPdf(jpeg, imgW, imgH) {
  // 1 image px = 1 PDF point, capped to PDF's 14400pt max page dimension.
  let pw = imgW;
  let ph = imgH;
  const MAX = 14400;
  if (Math.max(pw, ph) > MAX) {
    const f = MAX / Math.max(pw, ph);
    pw = Math.round(pw * f);
    ph = Math.round(ph * f);
  }

  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offsets = [];

  const raw = (bytes) => { parts.push(bytes); len += bytes.length; };
  const str = (s) => raw(enc.encode(s));
  const obj = (n, body) => { offsets[n] = len; str(`${n} 0 obj\n${body}\nendobj\n`); };

  str("%PDF-1.4\n");
  raw(new Uint8Array([0x25, 0xff, 0xff, 0xff, 0xff, 0x0a])); // binary marker

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  );

  // object 4: the JPEG image stream
  offsets[4] = len;
  str(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
  );
  raw(jpeg);
  str("\nendstream\nendobj\n");

  // object 5: content stream that paints the image across the page
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  offsets[5] = len;
  str(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefStart = len;
  str("xref\n0 6\n0000000000 65535 f \n");
  for (let n = 1; n <= 5; n++) str(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  str(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const outBuf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { outBuf.set(p, o); o += p.length; }
  return outBuf;
}

// --- small utils -----------------------------------------------------------

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(",")[1];
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pad2(n) { return String(n).padStart(2, "0"); }

function shortUrl(u) {
  try { return new URL(u).hostname; } catch (e) { return u || "page"; }
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1400);
}
