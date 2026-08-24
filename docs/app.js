/* ============================================================
   Swing — golf swing analysis
   Zero dependencies. Everything is normalised to the video's
   content box so drawings stay glued to the frame at any size.
   ============================================================ */
'use strict';

/* ---------- tiny helpers ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const fmt = t => {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
};

const COLORS = [
  { name: 'green',  hex: '#39ff14' },
  { name: 'pink',   hex: '#ff2d95' },
  { name: 'red',    hex: '#ff2323' },
  { name: 'yellow', hex: '#fff01f' },
  { name: 'cyan',   hex: '#00f0ff' },
  { name: 'orange', hex: '#ff7a00' },
  { name: 'white',  hex: '#ffffff' },
];

const FPS_STEPS = [24, 25, 30, 50, 60, 120, 240];
const ZOOM_MIN = 1, ZOOM_MAX = 6;

/* ---------- persisted prefs ---------- */
const prefs = Object.assign(
  { fps: 30, mic: true, color: '#39ff14', tool: 'pen', speed: 1, layout: 'single', weight: 1, webcamShape: 'circle' },
  JSON.parse(localStorage.getItem('swing.prefs') || '{}')
);
const savePrefs = () => localStorage.setItem('swing.prefs', JSON.stringify(prefs));

/* ============================================================
   Deck — one video + its drawing layer
   ============================================================ */
class Deck {
  constructor(id) {
    this.id     = id;
    this.el     = $(`#deck${id}`);
    this.view   = $('.deck__view', this.el);
    this.video  = $('.deck__video', this.el);
    this.canvas = $('.deck__canvas', this.el);
    this.ctx    = this.canvas.getContext('2d');
    this.file   = $('.deck__file', this.el);
    this.nameEl = $('.deck__name', this.el);
    this.empty  = $('.deck__empty', this.el);
    this.empty.addEventListener('click', () => this.file.click());
    this.buildScrub();

    this.strokes = [];
    this.draft   = null;     // stroke in progress
    this.anglePts = null;    // angle tool buffer
    this.loaded  = false;
    this.url     = null;

    this.zoom = 1; this.panX = 0; this.panY = 0; this.flipped = false;

    this.video.muted = true;
    this.video.playsInline = true;

    this.file.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) this.load(f);
      e.target.value = '';
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.loaded = true;
      this.el.classList.add('has-video');
      this.resize();
      if (this === focused) refreshTimeline();
      updatePipAspect();
      updateScrubVisibility();
    });

    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindDrawing();
  }

  load(file) {
    this.setSource(URL.createObjectURL(file), file.name.replace(/\.[^.]+$/, ''), true);
  }

  /* a clip already sitting on the server (the incoming-swings library) */
  loadUrl(url, label) { this.setSource(url, label, false); }

  setSource(src, label, isBlob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = isBlob ? src : null;
    this.video.src = src;
    this.video.load();
    this.nameEl.textContent = label;
    this.strokes = []; this.draft = null; this.anglePts = null;
    this.zoom = 1; this.panX = 0; this.panY = 0; this.flipped = false;
    applyZoom(this);
    this.redraw();
    toast(`Swing ${this.id}: ${label}`);
  }

  unload() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null; this.loaded = false;
    this.video.removeAttribute('src'); this.video.load();
    this.el.classList.remove('has-video');
    this.nameEl.textContent = '—';
    this.strokes = []; this.redraw();
    updateScrubVisibility();
  }

  /* content box of the video inside the deck element (object-fit: contain) */
  contentRect(cw = this.el.clientWidth, ch = this.el.clientHeight) {
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9;
    const s  = Math.min(cw / vw, ch / vh);
    const w  = vw * s, h = vh * s;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
  }

  resize() {
    clampPan(this);
    applyTransform(this);
    /* Zoom is a CSS scale on top of this bitmap, so render extra pixels
       up front (capped) — otherwise a zoomed-in line looks stretched/blurry. */
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5) * clamp(this.zoom || 1, 1, 3);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.canvas.width  = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.redraw();
  }

  redraw() {
    const c = this.ctx, dpr = this.canvas.width / (this.el.clientWidth || 1);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.scale(dpr, dpr);
    const r = this.contentRect();
    for (const s of this.strokes) paintStroke(c, s, r);
    if (this.draft) paintStroke(c, this.draft, r);
    if (this.anglePts) paintStroke(c, { tool: 'angle', color: state.color, weight: state.weight, pts: this.anglePts }, r);
  }

  /* ---------- pointer → drawing / panning ---------- */
  bindDrawing() {
    const cv = this.canvas;
    let drawing = false, id = null;
    let panId = null, panStart = null;

    /* Strokes are always stored in canonical (unflipped) frame coordinates.
       When the deck is flipped, mirror the click position going in so it
       still lands under the cursor — the shared CSS transform mirrors the
       stored point back out on render, keeping drawing and display in sync. */
    const norm = e => {
      const b = cv.getBoundingClientRect(), r = this.contentRect(b.width, b.height);
      let x = (e.clientX - b.left - r.x) / r.w;
      const y = (e.clientY - b.top - r.y) / r.h;
      if (this.flipped) x = 1 - x;
      return { x, y };
    };

    cv.addEventListener('pointerdown', e => {
      focus(this);
      if (!this.loaded) { this.file.click(); return; }

      if (state.tool === 'hand') {
        e.preventDefault();
        panId = e.pointerId;
        panStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
        cv.setPointerCapture(panId);
        cv.classList.add('is-panning');
        return;
      }

      const p = norm(e);

      if (state.tool === 'angle') {
        e.preventDefault();
        if (!this.anglePts) this.anglePts = [p, p];
        else if (this.anglePts.length === 2) this.anglePts = [this.anglePts[0], p, p];
        else {
          this.strokes.push({ tool: 'angle', color: state.color, weight: state.weight, pts: [...this.anglePts.slice(0, 2), p] });
          this.anglePts = null;
        }
        this.redraw();
        return;
      }

      drawing = true; id = e.pointerId;
      cv.setPointerCapture(id);
      this.draft = { tool: state.tool, color: state.color, weight: state.weight, pts: [p, p] };
      e.preventDefault();
    });

    cv.addEventListener('pointermove', e => {
      if (panId !== null && e.pointerId === panId) {
        /* pan only shifts the transform — no need to touch the canvas
           bitmap, so skip the heavier applyZoom()/resize() path here */
        const dir = this.flipped ? -1 : 1;   // flip mirrors drag direction too
        this.panX = panStart.panX + (e.clientX - panStart.x) * dir;
        this.panY = panStart.panY + (e.clientY - panStart.y);
        clampPan(this);
        applyTransform(this);
        return;
      }
      if (state.tool === 'angle' && this.anglePts) {
        const p = norm(e);
        this.anglePts[this.anglePts.length - 1] = p;
        this.redraw();
        return;
      }
      if (!drawing || e.pointerId !== id) return;
      const p = norm(e);
      if (this.draft.tool === 'pen') this.draft.pts.push(p);
      else this.draft.pts[1] = p;
      this.redraw();
    });

    const end = e => {
      if (panId !== null && e.pointerId === panId) {
        panId = null; panStart = null;
        cv.classList.remove('is-panning');
        return;
      }
      if (!drawing || e.pointerId !== id) return;
      drawing = false;
      const d = this.draft; this.draft = null;
      if (d) {
        const a = d.pts[0], b = d.pts[d.pts.length - 1];
        const moved = Math.hypot(b.x - a.x, b.y - a.y) > 0.008 || d.pts.length > 4;
        if (moved) this.strokes.push(d);
      }
      this.redraw();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  /* per-deck mini scrubber — shown instead of the single global one when
     split view has two videos, so either can be dragged directly without
     having to focus it first */
  buildScrub() {
    const el = document.createElement('div');
    el.className = 'deck__scrub';
    el.innerHTML =
      '<span class="deck__scrub-time">0:00.00</span>' +
      '<div class="deck__scrub-track"><div class="deck__scrub-fill"></div><div class="deck__scrub-knob"></div></div>' +
      '<span class="deck__scrub-time deck__scrub-time--end">0:00.00</span>';
    this.el.appendChild(el);

    this.scrubEl    = el;
    this.scrubNow   = el.children[0];
    this.scrubTrack = el.children[1];
    this.scrubFill  = this.scrubTrack.children[0];
    this.scrubKnob  = this.scrubTrack.children[1];
    this.scrubEnd   = el.children[2];

    let dragging = false;
    const at = e => {
      const b = this.scrubTrack.getBoundingClientRect();
      return clamp((e.clientX - b.left) / b.width, 0, 1) * (this.video.duration || 0);
    };
    this.scrubTrack.addEventListener('pointerdown', e => {
      dragging = true;
      this.scrubTrack.setPointerCapture(e.pointerId);
      focus(this);
      seekDeck(this, at(e));
    });
    this.scrubTrack.addEventListener('pointermove', e => { if (dragging) seekDeck(this, at(e)); });
    const endDrag = () => { dragging = false; };
    this.scrubTrack.addEventListener('pointerup', endDrag);
    this.scrubTrack.addEventListener('pointercancel', endDrag);
  }

  /* keep this deck's own mini scrubber in sync with its video */
  refreshScrub() {
    if (!this.scrubEl) return;
    const dur = this.video.duration || 0, cur = this.video.currentTime || 0;
    this.scrubNow.textContent = fmt(cur);
    this.scrubEnd.textContent = fmt(dur);
    const pct = dur ? (cur / dur) * 100 : 0;
    this.scrubFill.style.width = pct + '%';
    this.scrubKnob.style.left  = pct + '%';
  }
}

/* ============================================================
   Stroke painting — works for both the live canvas and the
   recording composite, so what you record is what you see.
   ============================================================ */
function paintStroke(c, s, r) {
  const P = p => [r.x + p.x * r.w, r.y + p.y * r.h];
  const lw = Math.max(3, r.h / 170) * (s.weight || 1);

  c.save();
  c.strokeStyle = s.color;
  c.fillStyle   = s.color;
  c.lineWidth   = lw;
  c.lineCap     = 'round';
  c.lineJoin    = 'round';
  c.shadowBlur  = 0;
  c.beginPath();

  const pts = s.pts;
  if (s.tool === 'pen') {
    const [x0, y0] = P(pts[0]); c.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) { const [x, y] = P(pts[i]); c.lineTo(x, y); }
    c.stroke();

  } else if (s.tool === 'line') {
    const [x0, y0] = P(pts[0]), [x1, y1] = P(pts[1]);
    c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();

  } else if (s.tool === 'arrow') {
    const [x0, y0] = P(pts[0]), [x1, y1] = P(pts[1]);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    /* scaled off lw (which already folds in weight) so thin/medium/thick
       actually produce different-sized heads — a flat r.h-relative floor
       here previously swamped the weight term for anything but thick */
    const headLen = Math.max(lw * 6.5, 10);
    const spread = Math.PI / 7;
    const wingL = [x1 - headLen * Math.cos(ang - spread), y1 - headLen * Math.sin(ang - spread)];
    const wingR = [x1 - headLen * Math.cos(ang + spread), y1 - headLen * Math.sin(ang + spread)];
    const baseMid = [(wingL[0] + wingR[0]) / 2, (wingL[1] + wingR[1]) / 2];

    /* stop the shaft at the head's base, not the tip — otherwise the
       round line-cap sits centred on the point and blunts it */
    c.moveTo(x0, y0); c.lineTo(baseMid[0], baseMid[1]); c.stroke();

    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(wingL[0], wingL[1]);
    c.lineTo(wingR[0], wingR[1]);
    c.closePath();
    c.fill();

  } else if (s.tool === 'circle') {
    const [x0, y0] = P(pts[0]), [x1, y1] = P(pts[1]);
    c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    c.stroke();

  } else if (s.tool === 'rect') {
    const [x0, y0] = P(pts[0]), [x1, y1] = P(pts[1]);
    c.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    c.stroke();

  } else if (s.tool === 'angle' && pts.length >= 2) {
    const a = P(pts[0]), b = P(pts[1]), cc = pts[2] ? P(pts[2]) : null;
    c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
    if (cc) c.lineTo(cc[0], cc[1]);
    c.stroke();
    if (cc) {
      const a1 = Math.atan2(a[1] - b[1], a[0] - b[0]);
      const a2 = Math.atan2(cc[1] - b[1], cc[0] - b[0]);
      let d = Math.abs(a1 - a2) * 180 / Math.PI; if (d > 180) d = 360 - d;
      const rad = Math.min(r.h * .11, Math.hypot(a[0] - b[0], a[1] - b[1]) * .55);
      c.beginPath(); c.lineWidth = lw * .7;
      c.arc(b[0], b[1], rad, Math.min(a1, a2), Math.max(a1, a2), Math.max(a1, a2) - Math.min(a1, a2) > Math.PI);
      c.stroke();
      const fs = Math.max(13, r.h / 26);
      c.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const mid = (Math.min(a1, a2) + Math.max(a1, a2)) / 2;
      c.fillStyle = 'rgba(0,0,0,.6)';
      const tx = b[0] + Math.cos(mid) * (rad + fs * 1.1), ty = b[1] + Math.sin(mid) * (rad + fs * 1.1);
      const label = `${d.toFixed(1)}°`;
      const tw = c.measureText(label).width;
      roundRect(c, tx - tw / 2 - 7, ty - fs * .72, tw + 14, fs * 1.44, fs * .5); c.fill();
      c.fillStyle = s.color; c.fillText(label, tx, ty);
    }
  }
  c.restore();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r); c.closePath();
}

/* ============================================================
   Zoom / pan — a CSS transform on .deck__view drives the live
   picture (canvas + video scale together, so drawings stay put).
   The same geometry re-derives an equivalent source crop for the
   recording composite, so exported lessons show what's on screen.
   ============================================================ */
function clampPan(d) {
  const W = d.el.clientWidth || 1, H = d.el.clientHeight || 1;
  const maxX = Math.max(0, (d.zoom - 1) * W / 2);
  const maxY = Math.max(0, (d.zoom - 1) * H / 2);
  d.panX = clamp(d.panX, -maxX, maxX);
  d.panY = clamp(d.panY, -maxY, maxY);
}

function applyTransform(d) {
  /* Flip is the outermost transform — it mirrors the already zoomed/panned
     picture as a whole, so it never has to be factored into zoom/pan math
     itself (see norm(), setZoom(), and the hand-tool drag for the few
     places that DO need to know about it: converting screen-space input
     back into this same canonical, unflipped space). */
  const flip = d.flipped ? 'scaleX(-1) ' : '';
  const panzoom = (d.zoom === 1 && d.panX === 0 && d.panY === 0)
    ? ''
    : `translate(${d.panX}px, ${d.panY}px) scale(${d.zoom})`;
  d.view.style.transform = flip + panzoom;
}

/* zoom level changed: re-rasterize the canvas at a resolution matched
   to the new zoom (resize() does the clamp + transform + redraw too) */
function applyZoom(d) {
  d.resize();
  updateZoomUI();
}

function setZoom(d, zoom, anchorClientX, anchorClientY) {
  const old = d.zoom;
  const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  if (anchorClientX != null && old !== z) {
    const b = d.el.getBoundingClientRect();
    let mx = anchorClientX - b.left;
    const my = anchorClientY - b.top;
    const cx = b.width / 2, cy = b.height / 2;
    if (d.flipped) mx = 2 * cx - mx;   // zoom toward the visible point, not its mirror
    d.panX = (mx - cx) - (z / old) * (mx - cx - d.panX);
    d.panY = (my - cy) - (z / old) * (my - cy - d.panY);
  }
  d.zoom = z;
  applyZoom(d);
}

function zoomBy(d, factor, anchorX, anchorY) { setZoom(d, d.zoom * factor, anchorX, anchorY); }
function resetZoom(d) { d.zoom = 1; d.panX = 0; d.panY = 0; applyZoom(d); }

function toggleFlip(d) {
  d.flipped = !d.flipped;
  applyTransform(d);
  updateZoomUI();
}

function updateZoomUI() {
  $('#btnZoomReset').classList.toggle('is-active', focused.zoom > 1.001);
  $('#btnFlip').classList.toggle('is-active', focused.flipped);
}

/* the visible crop for a deck, as both a video-source pixel rect
   (for drawImage) and a "virtual content rect" that maps the whole
   video into the destination box (for paintStroke, unchanged) */
function deckViewport(deck, destX, destY, destW, destH) {
  const elW = deck.el.clientWidth || destW, elH = deck.el.clientHeight || destH;
  const r0 = deck.contentRect(elW, elH);
  const zoom = deck.zoom || 1, panX = deck.panX || 0, panY = deck.panY || 0;
  const cx = elW / 2, cy = elH / 2;

  const ltX = (0 - cx - panX) / zoom + cx, ltY = (0 - cy - panY) / zoom + cy;
  const brX = (elW - cx - panX) / zoom + cx, brY = (elH - cy - panY) / zoom + cy;

  const fx0 = (ltX - r0.x) / r0.w, fy0 = (ltY - r0.y) / r0.h;
  const fx1 = (brX - r0.x) / r0.w, fy1 = (brY - r0.y) / r0.h;

  const vw = deck.video.videoWidth || 16, vh = deck.video.videoHeight || 9;
  const rw = destW / (fx1 - fx0), rh = destH / (fy1 - fy0);

  return {
    sx: fx0 * vw, sy: fy0 * vh, sw: (fx1 - fx0) * vw, sh: (fy1 - fy0) * vh,
    r: { x: destX - fx0 * rw, y: destY - fy0 * rh, w: rw, h: rh },
  };
}

function drawZoomedDeck(c, deck, destX, destY, destW, destH) {
  if (!deck.loaded) return;
  const vw = deck.video.videoWidth, vh = deck.video.videoHeight;
  if (!vw) return;

  c.save();
  c.beginPath(); c.rect(destX, destY, destW, destH); c.clip();
  /* mirror image + strokes together around the panel's own centre line,
     matching the live view's shared-transform flip exactly */
  if (deck.flipped) { c.translate(2 * destX + destW, 0); c.scale(-1, 1); }

  const { sx, sy, sw, sh, r } = deckViewport(deck, destX, destY, destW, destH);
  const csx = Math.max(0, sx), csy = Math.max(0, sy);
  const csw = Math.min(vw, sx + sw) - csx, csh = Math.min(vh, sy + sh) - csy;
  if (csw > 0 && csh > 0) {
    const fx0 = csx / vw, fy0 = csy / vh, fx1 = (csx + csw) / vw, fy1 = (csy + csh) / vh;
    c.drawImage(deck.video, csx, csy, csw, csh,
      r.x + fx0 * r.w, r.y + fy0 * r.h, (fx1 - fx0) * r.w, (fy1 - fy0) * r.h);
  }

  for (const st of deck.strokes) paintStroke(c, st, r);
  c.restore();
}

/* ============================================================
   App state
   ============================================================ */
const A = new Deck('A'), B = new Deck('B');
const decks = [A, B];
let focused = A;

const state = {
  layout: prefs.layout,
  tool:   prefs.tool,
  color:  prefs.color,
  weight: prefs.weight,
  speed:  prefs.speed,
  fps:    prefs.fps,
  linked: true,
  offset: 0,            // B.currentTime - A.currentTime, locked when linking
  mic:    prefs.mic,
  pip:    { x: 62, y: 6, w: 34 },
  webcam: { on: false, expanded: false, shape: prefs.webcamShape, xFrac: 0.68, yFrac: 0.64, sizeFrac: 0.24 },
};

const stage = $('#stage');

function focus(d) {
  focused = d;
  refreshTimeline();
  updateZoomUI();
}

/* which decks the transport drives */
function driven() {
  if (!B.loaded || state.layout === 'single') return [A].filter(d => d.loaded);
  if (state.linked) return decks.filter(d => d.loaded);
  return [focused].filter(d => d.loaded);
}

/* ============================================================
   Layout
   ============================================================ */
function setLayout(name) {
  state.layout = name; prefs.layout = name; savePrefs();
  stage.dataset.layout = name;
  $$('#layoutSeg .seg').forEach(b => b.setAttribute('aria-selected', String(b.dataset.layout === name)));
  moveSegThumb();
  if (name !== 'single' && !B.loaded) toast('Load swing B to use this view');
  updateScrubVisibility();
  requestAnimationFrame(() => decks.forEach(d => d.resize()));
}

function moveSegThumb() {
  const btn = $(`#layoutSeg .seg[aria-selected="true"]`);
  if (!btn) return;
  const thumb = $('#segThumb');
  thumb.style.width = btn.offsetWidth + 'px';
  thumb.style.transform = `translateX(${btn.offsetLeft - 2}px)`;
}

function updatePipAspect() {
  if (!B.video.videoWidth) return;
  stage.style.setProperty('--pip-ar', `${B.video.videoWidth} / ${B.video.videoHeight}`);
}

function applyPip() {
  stage.style.setProperty('--pip-x', state.pip.x + '%');
  stage.style.setProperty('--pip-y', state.pip.y + '%');
  stage.style.setProperty('--pip-w', state.pip.w + '%');
}
applyPip();

/* drag + resize the PiP inset */
(function pipGestures() {
  const grip = document.createElement('div');
  grip.className = 'pip-grip';
  B.el.appendChild(grip);

  let mode = null, sx = 0, sy = 0, base = null;

  const start = (e, m) => {
    if (state.layout !== 'pip') return;
    mode = m; sx = e.clientX; sy = e.clientY; base = { ...state.pip };
    B.el.classList.add('is-dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  };
  const move = e => {
    if (!mode) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    const dx = (e.clientX - sx) / W * 100, dy = (e.clientY - sy) / H * 100;
    if (mode === 'drag') {
      state.pip.x = clamp(base.x + dx, 0, 100 - state.pip.w);
      state.pip.y = clamp(base.y + dy, 0, 92);
    } else {
      state.pip.w = clamp(base.w + dx, 14, 70);
      state.pip.x = clamp(state.pip.x, 0, 100 - state.pip.w);
    }
    applyPip();
  };
  const end = () => { mode = null; B.el.classList.remove('is-dragging'); B.resize(); };

  B.el.addEventListener('pointerdown', e => { if (e.target !== grip) start(e, 'drag'); });
  grip.addEventListener('pointerdown', e => start(e, 'resize'));
  B.el.addEventListener('pointermove', move);
  grip.addEventListener('pointermove', move);
  B.el.addEventListener('pointerup', end);
  grip.addEventListener('pointerup', end);
  B.el.addEventListener('pointercancel', end);
})();

/* ============================================================
   Transport
   ============================================================ */
const vid = $('#icoPlay'), vidPause = $('#icoPause');

function isPlaying() { return driven().some(d => !d.video.paused); }

function play() {
  const ds = driven();
  if (!ds.length) { openSheet(); return; }
  if (state.linked && A.loaded && B.loaded && state.layout !== 'single') {
    B.video.currentTime = clamp(A.video.currentTime + state.offset, 0, B.video.duration || 0);
  }
  ds.forEach(d => { d.video.playbackRate = state.speed; d.video.play().catch(() => {}); });
  syncIcons();
}
function pause() { decks.forEach(d => d.video.pause()); syncIcons(); }
function toggle() { isPlaying() ? pause() : play(); }

function syncIcons() {
  const p = isPlaying();
  vid.classList.toggle('hidden', p);
  vidPause.classList.toggle('hidden', !p);
}

function step(dir) {
  pause();
  const dt = dir / state.fps;
  driven().forEach(d => {
    d.video.currentTime = clamp(d.video.currentTime + dt, 0, d.video.duration || 0);
  });
  refreshTimeline();
}

function seek(t) {
  const ds = driven();
  if (!ds.length) return;
  const lead = ds[0];
  lead.video.currentTime = clamp(t, 0, lead.video.duration || 0);
  if (ds.length === 2) {
    B.video.currentTime = clamp(lead.video.currentTime + state.offset, 0, B.video.duration || 0);
  }
  refreshTimeline();
}

/* Seek one specific deck directly — used by each deck's own mini scrubber
   in split view. Generalizes seek() to work from either deck as the
   reference, so dragging B's scrubber while linked correctly carries A
   along too (not just A driving B). */
function seekDeck(d, t) {
  pause();
  d.video.currentTime = clamp(t, 0, d.video.duration || 0);
  if (state.linked && A.loaded && B.loaded && state.layout !== 'single') {
    const other = d === A ? B : A;
    const target = d === A ? d.video.currentTime + state.offset : d.video.currentTime - state.offset;
    other.video.currentTime = clamp(target, 0, other.video.duration || 0);
  }
  refreshTimeline();
}

function setSpeed(s) {
  state.speed = s; prefs.speed = s; savePrefs();
  decks.forEach(d => d.video.playbackRate = s);
  $$('#speeds .chip').forEach(c => c.classList.toggle('is-active', +c.dataset.speed === s));
}

/* keep B glued to A while linked, and keep the scrubber honest */
function tick() {
  if (state.linked && A.loaded && B.loaded && state.layout !== 'single' && !A.video.paused) {
    const want = clamp(A.video.currentTime + state.offset, 0, B.video.duration || 0);
    if (B.video.paused) B.video.play().catch(() => {});
    if (Math.abs(B.video.currentTime - want) > 0.05) B.video.currentTime = want;
  }
  refreshTimeline();
  requestAnimationFrame(tick);
}

const timeNow = $('#timeNow'), timeEnd = $('#timeEnd'),
      fill = $('#scrubFill'), knob = $('#scrubKnob'), track = $('#scrubTrack'),
      globalScrub = $('#globalScrub');

let lastCur = -1, lastDur = -1, lastPlaying = null;

function refreshTimeline() {
  const d = (driven()[0] || focused).video;
  const dur = d.duration || 0, cur = d.currentTime || 0;

  /* the rAF loop calls this ~60×/s — skip the DOM work when nothing moved */
  const playing = isPlaying();
  if (cur === lastCur && dur === lastDur && playing === lastPlaying) return;
  lastCur = cur; lastDur = dur; lastPlaying = playing;

  timeNow.textContent = fmt(cur);
  timeEnd.textContent = fmt(dur);
  const pct = dur ? (cur / dur) * 100 : 0;
  fill.style.width = pct + '%';
  knob.style.left  = pct + '%';
  A.refreshScrub(); B.refreshScrub();
  syncIcons();
}

/* Split view gets its own scrubber per deck instead of the single global
   one — dragging either seeks that video directly, no need to focus it
   first. Any other layout only ever shows one video at a time, so the
   shared transport-bar scrubber keeps making sense there. */
function updateScrubVisibility() {
  const splitBoth = state.layout === 'split';
  A.scrubEl.classList.toggle('is-shown', splitBoth && A.loaded);
  B.scrubEl.classList.toggle('is-shown', splitBoth && B.loaded);
  globalScrub.classList.toggle('hidden', splitBoth && (A.loaded || B.loaded));
}

/* scrubbing */
(function scrubber() {
  let dragging = false;
  const at = e => {
    const b = track.getBoundingClientRect();
    const d = (driven()[0] || focused).video;
    return clamp((e.clientX - b.left) / b.width, 0, 1) * (d.duration || 0);
  };
  track.addEventListener('pointerdown', e => {
    dragging = true; track.setPointerCapture(e.pointerId); pause(); seek(at(e));
  });
  track.addEventListener('pointermove', e => { if (dragging) seek(at(e)); });
  track.addEventListener('pointerup',   () => dragging = false);
  track.addEventListener('pointercancel', () => dragging = false);
})();

/* ============================================================
   Recording — composites exactly what's on the stage into one
   canvas, adds the mic, hands back an MP4/WebM lesson.
   ============================================================ */
const rec = { mr: null, chunks: [], raf: 0, t0: 0, stream: null, mic: null };

function recSize() {
  const w = stage.clientWidth || 1280, h = stage.clientHeight || 720;
  const scale = Math.min(1, 1600 / Math.max(w, h));
  return { w: Math.round(w * scale / 2) * 2, h: Math.round(h * scale / 2) * 2 };
}

/* Webcam bubble geometry — shared by the live DOM overlay (applyWebcam,
   using the stage's on-screen box) and the recording composite (drawWebcam,
   using the recording canvas box), so what's recorded matches what's shown. */
function webcamRectFor(W, H) {
  const w = state.webcam, short = Math.min(W, H);
  if (w.expanded) {
    const size = short * (w.shape === 'circle' ? 0.62 : 0.7);
    return { x: (W - size) / 2, y: (H - size) / 2, size };
  }
  const size = clamp(short * w.sizeFrac, 70, short * 0.5);
  return { x: clamp(w.xFrac * W, 0, W - size), y: clamp(w.yFrac * H, 0, H - size), size };
}

function drawWebcam(c, W, H) {
  if (!state.webcam.on || !webcamVideo.videoWidth) return;
  const { x, y, size } = webcamRectFor(W, H);
  const vw = webcamVideo.videoWidth, vh = webcamVideo.videoHeight;
  const scale = Math.max(size / vw, size / vh);
  const sw = size / scale, sh = size / scale;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

  c.save();
  c.beginPath();
  if (state.webcam.shape === 'circle') c.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  else roundRect(c, x, y, size, size, size * 0.14);
  c.clip();
  c.drawImage(webcamVideo, sx, sy, sw, sh, x, y, size, size);
  c.restore();

  c.save();
  c.lineWidth = Math.max(2, size * 0.012);
  c.strokeStyle = 'rgba(255,255,255,.55)';
  c.beginPath();
  if (state.webcam.shape === 'circle') c.arc(x + size / 2, y + size / 2, size / 2 - c.lineWidth / 2, 0, Math.PI * 2);
  else roundRect(c, x + 1, y + 1, size - 2, size - 2, size * 0.14);
  c.stroke();
  c.restore();
}

function composite(c, W, H) {
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.fillStyle = '#050505';
  c.fillRect(0, 0, W, H);

  const L = state.layout;
  if (L === 'single' || !B.loaded) {
    drawZoomedDeck(c, A, 0, 0, W, H);

  } else if (L === 'split') {
    const stacked = getComputedStyle(stage).flexDirection === 'column';
    if (stacked) { drawZoomedDeck(c, A, 0, 0, W, H / 2); drawZoomedDeck(c, B, 0, H / 2, W, H / 2); }
    else         { drawZoomedDeck(c, A, 0, 0, W / 2, H); drawZoomedDeck(c, B, W / 2, 0, W / 2, H); }

  } else if (L === 'pip') {
    drawZoomedDeck(c, A, 0, 0, W, H);
    const pw = W * state.pip.w / 100;
    const ar = (B.video.videoWidth || 9) / (B.video.videoHeight || 16);
    const ph = pw / ar;
    const px = W * state.pip.x / 100, py = H * state.pip.y / 100;
    c.save();
    roundRect(c, px, py, pw, ph, Math.min(14, pw * .06)); c.clip();
    drawZoomedDeck(c, B, px, py, pw, ph);
    c.restore();
    c.strokeStyle = 'rgba(255,255,255,.22)'; c.lineWidth = 1.5;
    roundRect(c, px, py, pw, ph, Math.min(14, pw * .06)); c.stroke();

  } else if (L === 'overlay') {
    drawZoomedDeck(c, A, 0, 0, W, H);
    c.globalAlpha = +($('#overlayOpacity').value) / 100;
    c.globalCompositeOperation = $('#blendToggle').dataset.blend === 'normal'
      ? 'source-over'
      : $('#blendToggle').dataset.blend;
    drawZoomedDeck(c, B, 0, 0, W, H);
  }
  c.restore();

  drawWebcam(c, W, H);
}

async function startRecording() {
  if (!A.loaded) { openSheet(); return; }

  const { w, h } = recSize();
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { alpha: false });

  const loop = () => { composite(c, w, h); rec.raf = requestAnimationFrame(loop); };
  loop();

  const stream = cv.captureStream(30);
  rec.stream = stream;

  if (state.mic) {
    try {
      rec.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      rec.mic.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch { toast('Mic unavailable — recording video only'); }
  }

  const mimes = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mime = mimes.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) { toast('Recording not supported in this browser'); stopRecording(true); return; }

  rec.chunks = [];
  rec.mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  rec.mr.ondataavailable = e => { if (e.data.size) rec.chunks.push(e.data); };
  rec.mr.onstop = () => finishRecording(mime);
  rec.mr.start(200);

  rec.t0 = performance.now();
  document.body.classList.add('is-recording');
  $('#btnRecord').classList.add('is-live');
  $('#recLabel').textContent = 'Stop';
  tickRecClock();
  toast('Recording — talk them through it');
}

function tickRecClock() {
  if (!document.body.classList.contains('is-recording')) return;
  const s = (performance.now() - rec.t0) / 1000;
  $('#recTime').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  setTimeout(tickRecClock, 250);
}

function stopRecording(silent) {
  if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop();
  else if (silent) cleanupRec();
  document.body.classList.remove('is-recording');
  $('#btnRecord').classList.remove('is-live');
  $('#recLabel').textContent = 'Record';
}

function cleanupRec() {
  cancelAnimationFrame(rec.raf);
  if (rec.mic) rec.mic.getTracks().forEach(t => t.stop());
  rec.mic = null; rec.stream = null; rec.mr = null;
}

async function finishRecording(mime) {
  const ext  = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const blob = new Blob(rec.chunks, { type: mime });
  cleanupRec();
  if (!blob.size) { toast('Nothing recorded'); return; }

  const name = `swing-lesson-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
  const file = new File([blob], name, { type: mime });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Swing lesson' }); return; } catch {}
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Lesson saved');
}

/* ============================================================
   Native picture-in-picture (float the video over other apps)
   ============================================================ */
async function nativePip() {
  const v = focused.loaded ? focused.video : A.video;
  if (!v.src) { openSheet(); return; }
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (v.requestPictureInPicture) await v.requestPictureInPicture();
    else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(
      v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    else toast('Floating video not supported here');
  } catch { toast('Floating video unavailable'); }
}

/* ============================================================
   Webcam bubble — a movable, resizeable-by-drag-corner-free face
   cam for recordings. Tap to expand for a live close-up, tap again
   to shrink. Drawn into the recording composite (see drawWebcam).
   ============================================================ */
const webcamEl    = $('#webcamBubble');
const webcamVideo = $('.webcam__video', webcamEl);
const btnWebcam   = $('#btnWebcam');
let webcamStream  = null;

function applyWebcam() {
  webcamEl.dataset.shape = state.webcam.shape;
  webcamEl.classList.toggle('is-expanded', state.webcam.expanded);
  const { x, y, size } = webcamRectFor(stage.clientWidth || 1, stage.clientHeight || 1);
  webcamEl.style.left = x + 'px';
  webcamEl.style.top = y + 'px';
  webcamEl.style.width = size + 'px';
  webcamEl.style.height = size + 'px';
}

async function toggleWebcam() {
  if (state.webcam.on) { stopWebcam(); return; }
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    webcamVideo.srcObject = webcamStream;
    await webcamVideo.play().catch(() => {});
    state.webcam.on = true;
    webcamEl.hidden = false;
    applyWebcam();
    btnWebcam.classList.add('is-active');
  } catch {
    toast('Camera unavailable — check permission');
  }
}

function stopWebcam() {
  if (webcamStream) webcamStream.getTracks().forEach(t => t.stop());
  webcamStream = null;
  webcamVideo.srcObject = null;
  state.webcam.on = false; state.webcam.expanded = false;
  webcamEl.hidden = true;
  btnWebcam.classList.remove('is-active');
}

function toggleWebcamExpand() {
  state.webcam.expanded = !state.webcam.expanded;
  applyWebcam();
}

(function webcamDrag() {
  let mode = null, sx = 0, sy = 0, startX = 0, startY = 0, moved = false;

  webcamEl.addEventListener('pointerdown', e => {
    if ($('.webcam__shape', webcamEl).contains(e.target)) return;
    sx = e.clientX; sy = e.clientY; moved = false;
    if (state.webcam.expanded) { mode = 'wait-click'; return; }
    mode = 'drag';
    startX = webcamEl.offsetLeft; startY = webcamEl.offsetTop;
    webcamEl.setPointerCapture(e.pointerId);
    webcamEl.classList.add('is-dragging');
  });

  webcamEl.addEventListener('pointermove', e => {
    if (mode !== 'drag') return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.hypot(dx, dy) > 4) moved = true;
    const stg = stage.getBoundingClientRect();
    const size = webcamEl.offsetWidth;
    const nx = clamp(startX + dx, 0, Math.max(0, stg.width - size));
    const ny = clamp(startY + dy, 0, Math.max(0, stg.height - size));
    webcamEl.style.left = nx + 'px'; webcamEl.style.top = ny + 'px';
    state.webcam.xFrac = nx / stg.width; state.webcam.yFrac = ny / stg.height;
  });

  const end = () => {
    if (!mode) return;
    const wasExpandedTap = mode === 'wait-click';
    webcamEl.classList.remove('is-dragging');
    mode = null;
    if (wasExpandedTap || !moved) toggleWebcamExpand();
  };
  webcamEl.addEventListener('pointerup', end);
  webcamEl.addEventListener('pointercancel', () => { mode = null; webcamEl.classList.remove('is-dragging'); });
})();

$('#webcamShapeBtn').addEventListener('click', e => {
  e.stopPropagation();
  state.webcam.shape = state.webcam.shape === 'circle' ? 'square' : 'circle';
  prefs.webcamShape = state.webcam.shape; savePrefs();
  applyWebcam();
});

btnWebcam.addEventListener('click', toggleWebcam);

/* ============================================================
   UI wiring
   ============================================================ */
/* colour swatches — live in a popover off the trigger button so the rail
   doesn't have to give up permanent height to seven options at once */
const colorPanel = $('#colorPanel'), colorTriggerDot = $('#colorTriggerDot');
colorTriggerDot.style.background = state.color;
COLORS.forEach(c => {
  const b = document.createElement('button');
  b.className = 'swatch' + (c.hex === state.color ? ' is-active' : '');
  b.style.background = c.hex;
  b.style.setProperty('--glow', c.hex + '80');
  b.title = c.name;
  b.addEventListener('click', () => {
    state.color = c.hex; prefs.color = c.hex; savePrefs();
    $$('.swatch').forEach(s => s.classList.toggle('is-active', s === b));
    colorTriggerDot.style.background = c.hex;
    closeDropdowns();
  });
  colorPanel.appendChild(b);
});

/* tools — the hand tool lives in the zoom rail group, drawing tools in
   their own group, so select by [data-tool] across the whole rail */
function setTool(t) {
  state.tool = t; prefs.tool = t; savePrefs();
  decks.forEach(d => { d.anglePts = null; d.redraw(); d.canvas.classList.toggle('tool-hand', t === 'hand'); });
  $$('#rail [data-tool]').forEach(b => b.classList.toggle('is-active', b.dataset.tool === t));
}
$$('#rail [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
setTool(state.tool);

$('#btnUndo').addEventListener('click', () => {
  const d = focused.strokes.length ? focused : (A.strokes.length ? A : B);
  d.anglePts = null; d.strokes.pop(); d.redraw();
});
$('#btnClear').addEventListener('click', () => {
  decks.forEach(d => { d.strokes = []; d.anglePts = null; d.redraw(); });
  toast('Drawings cleared');
});

/* layout */
$$('#layoutSeg .seg').forEach(b => b.addEventListener('click', () => setLayout(b.dataset.layout)));

/* overlay controls */
$('#overlayOpacity').addEventListener('input', e => {
  stage.style.setProperty('--ov-opacity', e.target.value / 100);
});
stage.style.setProperty('--ov-opacity', .5);
$('#blendToggle').addEventListener('click', e => {
  const modes = ['normal', 'screen', 'difference'];
  const next = modes[(modes.indexOf(e.target.dataset.blend) + 1) % modes.length];
  e.target.dataset.blend = next;
  e.target.textContent = next === 'normal' ? 'Blend' : next[0].toUpperCase() + next.slice(1);
  e.target.classList.toggle('is-active', next !== 'normal');
  stage.style.setProperty('--ov-blend', next);
});

/* transport */
$('#btnPlay').addEventListener('click', toggle);
$('#btnStepBack').addEventListener('click', () => step(-1));
$('#btnStepFwd').addEventListener('click', () => step(1));
$$('#speeds .chip').forEach(c => c.addEventListener('click', () => setSpeed(+c.dataset.speed)));
setSpeed(state.speed);

$('#btnSync').addEventListener('click', e => {
  state.linked = !state.linked;
  if (state.linked && A.loaded && B.loaded) {
    state.offset = B.video.currentTime - A.video.currentTime;
    toast('Linked at this position');
  } else if (!state.linked) {
    toast('Unlinked — scrub each swing to impact, then link');
  }
  e.currentTarget.classList.toggle('is-active', state.linked);
  $('span', e.currentTarget).textContent = state.linked ? 'Linked' : 'Free';
});

$('#btnFps').addEventListener('click', e => {
  state.fps = FPS_STEPS[(FPS_STEPS.indexOf(state.fps) + 1) % FPS_STEPS.length];
  prefs.fps = state.fps; savePrefs();
  e.currentTarget.textContent = `${state.fps} fps`;
});
$('#btnFps').textContent = `${state.fps} fps`;

const micBtn = $('#btnMic');
micBtn.classList.toggle('is-active', state.mic);
micBtn.addEventListener('click', () => {
  state.mic = !state.mic; prefs.mic = state.mic; savePrefs();
  micBtn.classList.toggle('is-active', state.mic);
  toast(state.mic ? 'Mic on for recordings' : 'Mic off');
});

/* record + pip */
$('#btnRecord').addEventListener('click', () =>
  document.body.classList.contains('is-recording') ? stopRecording() : startRecording());
$('#btnNativePip').addEventListener('click', nativePip);

/* load sheet */
const scrim = $('#scrim');
function openSheet()  { document.body.classList.add('sheet-open'); loadLibrary(); }
function closeSheet() { document.body.classList.remove('sheet-open'); }
$('#btnLibrary').addEventListener('click', openSheet);
scrim.addEventListener('click', closeSheet);

/* ---------- incoming swings library ---------- */
const libSection = $('#libSection'), libList = $('#libList'), libCount = $('#libCount'), libStatus = $('#libStatus');

const bytes = n => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB'
              : n > 1e6 ? Math.round(n / 1e6) + ' MB'
              : Math.round(n / 1e3) + ' KB';

const ago = ts => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24)  return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
};

function showSync(s) {
  if (!s)                 { libStatus.textContent = ''; return; }
  if (s.running)          { libStatus.textContent = 'Checking ClickUp…'; return; }
  if (!s.configured)      { libStatus.textContent = 'ClickUp sync off — add your API token to .env'; return; }
  libStatus.textContent = s.lastRun
    ? `ClickUp: ${s.lastResult} · ${ago(s.lastRun)}`
    : 'ClickUp sync ready';
}

async function loadLibrary() {
  let items = [], syncState = null;
  try {
    const r = await fetch('/api/library', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    items = data.items || [];
    syncState = data.sync;
  } catch {
    /* No server behind this build (e.g. hosted as static files) — this
       whole feature is optional, so hide it rather than show a broken
       "start node server.js" message that means nothing to a visitor. */
    libSection.hidden = true;
    return;
  }
  libSection.hidden = false;
  showSync(syncState);

  libCount.textContent = items.length ? `(${items.length})` : '';
  if (!items.length) {
    libList.innerHTML = '<p class="lib__empty">Nothing here yet. New swing submissions land here automatically.</p>';
    return;
  }

  libList.textContent = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'lib__item';

    const meta = document.createElement('div');
    meta.className = 'lib__meta';
    const name = document.createElement('div');
    name.className = 'lib__name';
    name.textContent = it.student || it.file;
    const sub = document.createElement('div');
    sub.className = 'lib__sub';
    sub.textContent = [it.angle, it.date, bytes(it.size)].filter(Boolean).join(' · ');
    meta.append(name, sub);

    const pick = document.createElement('div');
    pick.className = 'lib__pick';
    for (const id of ['A', 'B']) {
      const b = document.createElement('button');
      b.className = `lib__btn lib__btn--${id.toLowerCase()}`;
      b.textContent = id;
      b.title = `Load into ${id}`;
      b.addEventListener('click', () => {
        const deck = id === 'A' ? A : B;
        const label = [it.student, it.angle].filter(Boolean).join(' — ');
        deck.loadUrl('/library/' + encodeURIComponent(it.file), label);
        if (id === 'B' && state.layout === 'single') setLayout('split');
        closeSheet();
      });
      pick.appendChild(b);
    }

    row.append(meta, pick);
    libList.appendChild(row);
  }
}

/* Sync now: kick the ClickUp pull, then poll until it settles. */
$('#libSync').addEventListener('click', async () => {
  libStatus.textContent = 'Checking ClickUp…';
  try { await fetch('/api/sync', { cache: 'no-store' }); } catch {}
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    let data;
    try { data = await (await fetch('/api/library', { cache: 'no-store' })).json(); } catch { break; }
    if (!data.sync || !data.sync.running) { await loadLibrary(); break; }
    showSync(data.sync);
  }
});

$$('#sheetLoad .row').forEach(r => r.addEventListener('click', () => {
  const { mode, target } = r.dataset;
  closeSheet();
  if (mode === 'file') { (target === 'A' ? A : B).file.click(); if (target === 'B' && state.layout === 'single') setLayout('split'); }
  if (mode === 'swap') swap();
  if (mode === 'clearAll') { decks.forEach(d => d.unload()); setLayout('single'); }
}));

function swap() {
  const a = { src: A.video.src, name: A.nameEl.textContent, strokes: A.strokes, url: A.url, loaded: A.loaded };
  const b = { src: B.video.src, name: B.nameEl.textContent, strokes: B.strokes, url: B.url, loaded: B.loaded };
  const put = (d, s) => {
    d.url = s.url; d.loaded = s.loaded; d.strokes = s.strokes;
    if (s.src) { d.video.src = s.src; d.video.load(); d.el.classList.add('has-video'); }
    else { d.video.removeAttribute('src'); d.video.load(); d.el.classList.remove('has-video'); }
    d.nameEl.textContent = s.name; d.redraw();
  };
  put(A, b); put(B, a);
  toast('Swapped');
}

/* click a deck to focus it (matters when unlinked) */
decks.forEach(d => d.el.addEventListener('pointerdown', () => focus(d), true));

/* drag & drop files straight onto a deck (desktop) */
decks.forEach(d => {
  d.el.addEventListener('dragover', e => { e.preventDefault(); });
  d.el.addEventListener('drop', e => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith('video/'));
    if (f) { d.load(f); if (d === B && state.layout === 'single') setLayout('split'); }
  });
});

/* ---------- zoom: mouse wheel over a deck, zoomed at the cursor ---------- */
decks.forEach(d => {
  d.el.addEventListener('wheel', e => {
    if (!d.loaded) return;
    e.preventDefault();
    focus(d);
    const factor = Math.exp(-e.deltaY * 0.0018);
    zoomBy(d, factor, e.clientX, e.clientY);
  }, { passive: false });
});

/* ---------- zoom: rail buttons ---------- */
$('#btnZoomIn').addEventListener('click', () => zoomBy(focused, 1.35));
$('#btnZoomOut').addEventListener('click', () => zoomBy(focused, 1 / 1.35));
$('#btnZoomReset').addEventListener('click', () => resetZoom(focused));
$('#btnFlip').addEventListener('click', () => toggleFlip(focused));

/* ---------- line weight ---------- */
const weightTriggerDot = $('#weightTriggerDot');
function setWeight(w) {
  state.weight = w; prefs.weight = w; savePrefs();
  $$('#weightPanel .weight').forEach(b => b.classList.toggle('is-active', +b.dataset.weight === w));
  weightTriggerDot.style.height = $(`#weightPanel .weight[data-weight="${w}"] .weight__dot`).style.height;
}
$$('#weightPanel .weight').forEach(b => b.addEventListener('click', () => { setWeight(+b.dataset.weight); closeDropdowns(); }));
setWeight(state.weight);

/* ---------- rail dropdowns (colour / thickness) ----------
   The panels are detached from the rail into a body-level layer.
   `.rail` has its own backdrop-filter, which — like `transform` —
   establishes a containing block for position:fixed descendants;
   combined with the rail's overflow-y:auto, a panel left nested
   inside it gets silently clipped to the rail's own ~60px width no
   matter what left/top coordinates are set on it. Moving it out from
   under that ancestor is what actually lets it float free. */
const dropdownLayer = document.createElement('div');
dropdownLayer.id = 'dropdownLayer';
document.body.appendChild(dropdownLayer);
$$('.dropdown__panel').forEach(p => dropdownLayer.appendChild(p));

function closeDropdowns() {
  $$('.dropdown__panel.is-open').forEach(p => p.classList.remove('is-open'));
}
function openDropdown(trigger, panel) {
  const wasOpen = panel.classList.contains('is-open');
  closeDropdowns();
  if (wasOpen) return;
  /* clamped to the viewport: on short screens the colour/weight
     triggers sit near the bottom of the rail, and an unclamped
     centre-on-trigger placement pushed the panel off-screen */
  const r = trigger.getBoundingClientRect();
  const margin = 8;
  const panelH = panel.offsetHeight, panelW = panel.offsetWidth;
  const top  = clamp(r.top + r.height / 2, panelH / 2 + margin, innerHeight - panelH / 2 - margin);
  const left = clamp(r.right + 10, margin, innerWidth - panelW - margin);
  panel.style.left = left + 'px';
  panel.style.top  = top + 'px';
  panel.classList.add('is-open');
}
$('#colorTrigger').addEventListener('click', () => openDropdown($('#colorTrigger'), $('#colorPanel')));
$('#weightTrigger').addEventListener('click', () => openDropdown($('#weightTrigger'), $('#weightPanel')));
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.dropdown') && !e.target.closest('#dropdownLayer')) closeDropdowns();
}, true);

/* ---------- keyboard ---------- */
addEventListener('keydown', e => {
  if (e.target.matches('input,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') { closeDropdowns(); return; }
  const map = { p: 'pen', l: 'line', w: 'arrow', o: 'circle', b: 'rect', a: 'angle', h: 'hand' };
  if (map[k]) { setTool(map[k]); return; }
  if (k === ' ')          { e.preventDefault(); toggle(); }
  else if (k === 'arrowleft')  { e.preventDefault(); step(-1); }
  else if (k === 'arrowright') { e.preventDefault(); step(1); }
  else if (k === 'u')     { $('#btnUndo').click(); }
  else if (k === 'c')     { $('#btnClear').click(); }
  else if (k === 's')     { $('#btnSync').click(); }
  else if (k === 'r')     { $('#btnRecord').click(); }
  else if (k === '+' || k === '=') { e.preventDefault(); zoomBy(focused, 1.35); }
  else if (k === '-' || k === '_') { e.preventDefault(); zoomBy(focused, 1 / 1.35); }
  else if (k === '0')     { resetZoom(focused); }
  else if (k === 'f')     { toggleFlip(focused); }
  else if (['1','2','3','4'].includes(k)) setLayout(['single','split','pip','overlay'][+k - 1]);
});

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2000);
}

/* ---------- boot ---------- */
addEventListener('resize', () => {
  moveSegThumb(); decks.forEach(d => d.resize());
  if (state.webcam.on) applyWebcam();
});
addEventListener('orientationchange', () => setTimeout(() => {
  decks.forEach(d => d.resize());
  if (state.webcam.on) applyWebcam();
}, 250));
decks.forEach(d => d.video.addEventListener('ended', syncIcons));

setLayout(state.layout);
requestAnimationFrame(() => { moveSegThumb(); tick(); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
