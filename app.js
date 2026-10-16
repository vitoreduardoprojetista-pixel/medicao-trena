/* Medição Trena — app de campo
   Lê o PDF "Relação de Itens para Medição" do CEM, mede pela câmera (OCR do visor da trena)
   e devolve o PDF preenchido. */
'use strict';
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIELDS = { L: 'Largura', H: 'Altura', cL: 'Larg. contramarco', cH: 'Alt. contramarco' };

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------------- armazenamento ---------------- */
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('medicao-trena', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('obras', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('obras', mode); const st = t.objectStore('obras');
      const out = fn(st); t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', st => st.getAll()); },
  get(id) { return this.tx('readonly', st => st.get(id)); },
  put(o) { return this.tx('readwrite', st => st.put(o)); },
  del(id) { return this.tx('readwrite', st => st.delete(id)); }
};
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

/* ---------------- perfis de trena ---------------- */
// box em frações da imagem da câmera
const DEFAULT_PROFILE = { mode: 'multi', box: { x: 0.15, y: 0.30, w: 0.70, h: 0.30 }, chan: 'min', pol: 'auto', off: 0, unit: 'm' };
let profiles = lsGet('trenas', null);
if (!profiles || !profiles.length) profiles = [Object.assign({ id: 'p' + Date.now(), name: 'Trena padrão' }, JSON.parse(JSON.stringify(DEFAULT_PROFILE)))];
let activeProfileId = lsGet('trenaAtiva', profiles[0].id);
const activeProfile = () => profiles.find(p => p.id === activeProfileId) || profiles[0];
const saveProfiles = () => { lsSet('trenas', profiles); lsSet('trenaAtiva', activeProfileId); };

/* ---------------- leitura do PDF ---------------- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

async function readPdf(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    pages.push({ items: tc.items.filter(it => it.str !== undefined).map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })) });
  }
  return MedParse.parseMedicao(pages);
}

async function importPdf(file) {
  const bytes = await file.arrayBuffer();
  let parsed;
  try { parsed = await readPdf(bytes); } catch (e) { console.error(e); toast('Não consegui ler este PDF.'); return; }
  const totalUnits = parsed.items.reduce((s, i) => s + i.units.length, 0);
  if (!totalUnits) { toast('Não encontrei linhas de medição (1/1, 1/2…) neste PDF.', 4000); return; }
  for (const it of parsed.items) for (const u of it.units) { u.loc = ''; u.v = {}; }
  const obra = { id: 'o' + Date.now(), criado: Date.now(), arquivo: file.name, pdf: bytes, meta: parsed };
  await DB.put(obra);
  location.hash = '#/obra/' + obra.id;
}

/* ---------------- telas ---------------- */
let current = null;      // obra aberta
let saveT;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(() => current && DB.put(current), 400); }

function show(view, title, back) {
  for (const v of ['#viewHome', '#viewObra', '#viewTrenas']) $(v).classList.toggle('hidden', v !== view);
  $('#title').textContent = title;
  $('#btnBack').classList.toggle('hidden', !back);
  window.scrollTo(0, 0);
}

async function route() {
  if (camState) closeCam(true);
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/obra\/(\w+)/))) {
    const o = await DB.get(m[1]);
    if (!o) { location.hash = '#/'; return; }
    current = o; renderObra();
  } else if (h.startsWith('#/trenas')) {
    current = null; renderTrenas();
  } else {
    current = null; renderHome();
  }
}

async function renderHome() {
  show('#viewHome', 'Medição Trena', false);
  $('#homeTrena').textContent = activeProfile().name;
  const obras = (await DB.all()).sort((a, b) => b.criado - a.criado);
  const el = $('#obrasList');
  if (!obras.length) { el.innerHTML = 'Nenhuma obra ainda. Importe o PDF de medição do CEM.'; el.className = 'muted'; return; }
  el.className = '';
  el.innerHTML = obras.map(o => {
    const { done, total } = progress(o);
    return `<div class="list-item">
      <div class="grow" data-open="${o.id}" style="cursor:pointer">
        <div><span class="tag">${esc(o.meta.codigo || '—')}</span> <b>${esc(o.meta.obra || o.arquivo)}</b></div>
        <div class="muted small">${done} de ${total} unidades medidas · ${new Date(o.criado).toLocaleDateString('pt-BR')}</div>
      </div>
      <button class="btn bad" data-del="${o.id}" aria-label="Apagar">🗑</button></div>`;
  }).join('');
}

function progress(o) {
  let done = 0, total = 0;
  for (const it of o.meta.items) for (const u of it.units) { total++; if (u.v.L && u.v.L.val && u.v.H && u.v.H.val) done++; }
  return { done, total };
}
const fmt = n => (n == null || n === '' ? '' : String(n));

function fieldHtml(key, f, u) {
  const v = u.v[f] || {};
  // registro = as outras leituras (sem a menor, que já está no campo)
  const others = (v.reads || []).slice(); const iMin = others.indexOf(v.val); if (iMin >= 0) others.splice(iMin, 1);
  return `<div class="field">
    <label>${FIELDS[f]}</label>
    <div class="val"><input inputmode="numeric" pattern="[0-9]*" data-k="${key}" data-f="${f}" value="${esc(fmt(v.val))}" placeholder="mm">
    <button class="camb" data-cam="${key}" data-f="${f}" aria-label="Medir com a câmera">📷</button></div>
    <div class="reads">${others.length ? 'registro: ' + others.join(' · ') : ''}</div></div>`;
}

function renderObra() {
  const o = current, m = o.meta;
  show('#viewObra', (m.codigo ? m.codigo + ' · ' : '') + (m.obra || 'Obra'), true);
  renderObraHead();
  $('#itemsList').innerHTML = m.items.map((it, ii) => {
    const p = it.proj || {};
    const projTxt = p.L ? `Projeto: ${p.L} × ${p.H}` + (p.cL && (p.cL !== p.L || p.cH !== p.H) ? ` · CM ${p.cL} × ${p.cH}` : '') : '';
    const units = it.units.map((u, ui) => {
      const key = ii + '-' + ui;
      const ok = u.v.L && u.v.L.val && u.v.H && u.v.H.val;
      const showCm = u.showCm || (u.v.cL && u.v.cL.val) || (u.v.cH && u.v.cH.val);
      return `<div class="unit"><h4>${esc(it.tipo)} · ${esc(u.label)} ${ok ? '<span class="done">✓</span>' : ''}</h4>
        <div class="fields">
          <div class="field loc"><label>Localização</label><input data-k="${key}" data-f="loc" value="${esc(u.loc)}" placeholder="ex.: Sala, Suíte 1…"></div>
          ${fieldHtml(key, 'L', u)}${fieldHtml(key, 'H', u)}
          ${showCm ? fieldHtml(key, 'cL', u) + fieldHtml(key, 'cH', u) : ''}
        </div>
        ${showCm ? '' : `<button class="cm-toggle" data-cm="${key}">+ medidas do contramarco</button>`}
      </div>`;
    }).join('');
    return `<div class="card"><div class="row"><span class="tag">${esc(it.tipo)}</span><div class="grow muted small">Item ${it.item} · Qtde ${it.qtde}</div><div class="proj">${projTxt}</div></div>
      <div class="desc">${esc(it.desc)}</div>${units || '<div class="muted small">Sem linhas de medição.</div>'}</div>`;
  }).join('');
}

function renderObraHead() {
  const o = current, m = o.meta, { done, total } = progress(o);
  $('#obraHead').innerHTML = `<div style="font-weight:700">${esc(m.obra || o.arquivo)}</div>
    <div class="muted small">${esc(m.endereco || '')}</div>
    <div class="row" style="margin-top:6px"><div class="grow small">Trena: <b>${esc(activeProfile().name)}</b></div>
    <div class="small ${done === total ? 'done' : ''}">${done}/${total} medidas</div></div>`;
}

function unitByKey(key) { const [ii, ui] = key.split('-').map(Number); return { it: current.meta.items[ii], u: current.meta.items[ii].units[ui] }; }

function setMeasure(u, f, reads) {
  reads = (reads || []).filter(n => n > 0);
  if (!reads.length) { delete u.v[f]; return; }
  u.v[f] = { val: Math.min(...reads), reads };
}

/* eventos da lista */
document.addEventListener('click', e => {
  const d = e.target.closest('.desc'); if (d) { d.classList.toggle('open'); return; }
  const t = e.target.closest('[data-open],[data-del],[data-cam],[data-cm],[data-prof],[data-pcal],[data-pdel]');
  if (!t) return;
  if (t.dataset.open) location.hash = '#/obra/' + t.dataset.open;
  else if (t.dataset.del) { if (confirm('Apagar esta obra do celular?')) DB.del(t.dataset.del).then(renderHome); }
  else if (t.dataset.cm) { unitByKey(t.dataset.cm).u.showCm = true; scheduleSave(); renderObra(); }
  else if (t.dataset.cam) {
    const { it, u } = unitByKey(t.dataset.cam), f = t.dataset.f;
    openCam({
      mode: 'measure', title: `${it.tipo} ${u.label} · ${FIELDS[f]}`, reads: (u.v[f] && u.v[f].reads) || [],
      onDone: reads => { setMeasure(u, f, reads); scheduleSave(); renderObra(); }
    });
  }
  else if (t.dataset.prof) { activeProfileId = t.dataset.prof; saveProfiles(); renderTrenas(); toast('Trena ativa: ' + activeProfile().name); }
  else if (t.dataset.pcal) startCalib(profiles.find(p => p.id === t.dataset.pcal));
  else if (t.dataset.pdel) {
    if (profiles.length < 2) { toast('Mantenha pelo menos um perfil.'); return; }
    if (!confirm('Apagar este perfil de trena?')) return;
    profiles = profiles.filter(p => p.id !== t.dataset.pdel);
    if (!profiles.find(p => p.id === activeProfileId)) activeProfileId = profiles[0].id;
    saveProfiles(); renderTrenas();
  }
});
document.addEventListener('change', e => {
  const t = e.target; if (!t.dataset || !t.dataset.k || !current) return;
  const { u } = unitByKey(t.dataset.k), f = t.dataset.f;
  if (f === 'loc') u.loc = t.value.trim();
  else {
    const n = parseInt(t.value.replace(/\D/g, ''), 10); setMeasure(u, f, n ? [n] : []);
    t.value = n || ''; const rd = t.closest('.field').querySelector('.reads'); if (rd) rd.textContent = '';
    renderObraHead();
  }
  scheduleSave();
});

/* ---------------- perfis (tela) ---------------- */
function renderTrenas() {
  show('#viewTrenas', 'Trenas', true);
  $('#profList').innerHTML = profiles.map(p => `<div class="prof">
    <div class="grow" data-prof="${p.id}" style="cursor:pointer"><b>${esc(p.name)}</b><br>
      <span class="muted small">Visor em ${p.unit === 'm' ? 'metros' : p.unit === 'cm' ? 'centímetros' : 'milímetros'} · ${p.calibrado ? 'calibrado ' + new Date(p.calibrado).toLocaleDateString('pt-BR') : 'não calibrado'}</span>
      ${p.id === activeProfileId ? '<div class="on">● ativa</div>' : ''}</div>
    <button class="btn" data-pcal="${p.id}">Calibrar</button>
    <button class="btn bad" data-pdel="${p.id}" aria-label="Apagar">🗑</button></div>`).join('');
}
$('#btnNewProf').onclick = () => {
  const name = $('#newProfName').value.trim() || 'Trena ' + (profiles.length + 1);
  const p = Object.assign({ id: 'p' + Date.now(), name }, JSON.parse(JSON.stringify(activeProfile() || DEFAULT_PROFILE)), { name, calibrado: null });
  p.id = 'p' + Date.now();
  profiles.push(p); activeProfileId = p.id; saveProfiles(); $('#newProfName').value = '';
  startCalib(p);
};

/* ---------------- OCR ---------------- */
let ocrWorker = null, ocrLoading = null;
function getWorker() {
  if (ocrWorker) return Promise.resolve(ocrWorker);
  if (ocrLoading) return ocrLoading;
  ocrLoading = (async () => {
    const w = await Tesseract.createWorker('eng', 1, {});
    await w.setParameters({ tessedit_char_whitelist: '0123456789.,m', tessedit_pageseg_mode: '7' });
    ocrWorker = w; return w;
  })();
  ocrLoading.catch(() => { ocrLoading = null; });
  return ocrLoading;
}

/* O quadro (box) é guardado em frações da IMAGEM DA CÂMERA (não da tela), para não mudar
   de lugar quando o painel de baixo muda de tamanho. camMap converte imagem <-> tela (object-fit: cover). */
function camMap() {
  const v = $('#video'), st = $('#camStage');
  const vw = v.videoWidth, vh = v.videoHeight, sw = st.clientWidth, sh = st.clientHeight;
  if (!vw || !vh || !sw || !sh) return null;
  const sc = Math.max(sw / vw, sh / vh);
  return { vw, vh, sw, sh, sc, ox: (sw - vw * sc) / 2, oy: (sh - vh * sc) / 2 };
}
function grabCrop(video, stage, box, targetH = 96) {
  const vw = video.videoWidth, vh = video.videoHeight;
  let x = box.x * vw, y = box.y * vh, w = box.w * vw, h = box.h * vh;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  const k = Math.min(targetH / h, 900 / w);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
  g.drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

/* binariza: máscara com 1 = pixel de texto */
function makeMask(src, prm) {
  const W = src.width, H = src.height;
  const d = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const g = new Uint8Array(W * H), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const v = prm.chan === 'max' ? Math.max(r, gg, b) : prm.chan === 'lum' ? (0.299 * r + 0.587 * gg + 0.114 * b) | 0 : Math.min(r, gg, b);
    g[j] = v; hist[v]++;
  }
  // Otsu
  const N = W * H; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = N - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = t; }
  }
  th = Math.max(1, Math.min(254, th + (prm.off || 0)));
  let bright = 0; for (let j = 0; j < N; j++) if (g[j] > th) bright++;
  const textBright = prm.pol === 'light' ? true : prm.pol === 'dark' ? false : bright < N / 2;
  const m = new Uint8Array(N);
  for (let j = 0; j < N; j++) m[j] = (textBright ? g[j] > th : g[j] <= th) ? 1 : 0;
  return { m, W, H };
}

/* desenha um trecho da máscara: texto preto sobre branco, com margem; targetH redimensiona */
function maskToCanvas(mk, x0, y0, x1, y1, targetH) {
  const w = x1 - x0, h = y1 - y0, P = 16;
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tx = t.getContext('2d'); const im = tx.createImageData(w, h), o = im.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = mk.m[(y + y0) * mk.W + x + x0] ? 0 : 255, i = (y * w + x) * 4;
    o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
  }
  tx.putImageData(im, 0, 0);
  const k = targetH ? targetH / h : 1;
  const c = document.createElement('canvas'); c.width = Math.round(w * k) + 2 * P; c.height = Math.round(h * k) + 2 * P;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = 'high';
  x.drawImage(t, P, P, Math.round(w * k), Math.round(h * k));
  return c;
}
function preprocess(src, prm) { const mk = makeMask(src, prm); return maskToCanvas(mk, 0, 0, mk.W, mk.H); }

/* separa as linhas do visor (faixas de texto) e, em cada uma, fica só com o número
   (descarta ícones à esquerda separados por espaço grande e a linha divisória fina) */
function splitRows(mk) {
  const { m, W, H } = mk, prof = new Uint32Array(H);
  for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) s += m[y * W + x]; prof[y] = s; }
  const lim = Math.max(2, 0.015 * W), bands = [];
  for (let y = 0; y < H;) {
    if (prof[y] > lim) { const y0 = y; while (y < H && prof[y] > lim) y++; bands.push([y0, y]); } else y++;
  }
  const merged = [];
  for (const b of bands) { const l = merged[merged.length - 1]; if (l && b[0] - l[1] <= 2) l[1] = b[1]; else merged.push(b.slice()); }
  if (!merged.length) return [];
  const hmax = Math.max(...merged.map(b => b[1] - b[0]));
  const rows = [];
  for (const [y0, y1] of merged) {
    const h = y1 - y0; if (h < 0.35 * hmax || h < 6) continue;
    const cols = [];
    for (let x = 0; x < W; x++) { let s = 0; for (let y = y0; y < y1; y++) s += m[y * W + x]; if (s) cols.push(x); }
    if (!cols.length) continue;
    let g0 = cols[0], g1 = cols[0];
    for (const x of cols.slice(1)) { if (x - g1 > 0.6 * h) { g0 = x; g1 = x; } else g1 = x; }
    rows.push({ y0, y1, x0: Math.max(0, g0 - 3), x1: Math.min(W, g1 + 4), h });
  }
  return rows;
}

/* lê todas as medidas da tela (histórico + principal) */
async function ocrMulti(c, prm) {
  const w = await getWorker();
  const mk = makeMask(c, prm);
  const rows = splitRows(mk), out = [];
  for (const r of rows) {
    const { data } = await w.recognize(maskToCanvas(mk, r.x0, r.y0, r.x1, r.y1, 96));
    out.push({ h: r.h, text: data.text.trim(), conf: data.confidence || 0, mm: parseReading(data.text, prm.unit) });
  }
  const hmax = Math.max(0, ...out.map(o => o.h));
  out.forEach(o => { o.main = o.h === hmax; });
  return { rows: out, vals: out.filter(o => o.mm), canvas: maskToCanvas(mk, 0, 0, mk.W, mk.H) };
}

/* texto do OCR -> milímetros */
function parseReading(text, unit) {
  let t = (text || '').replace(/\s+/g, '');
  const mi = t.indexOf('m'); if (mi > 0) t = t.slice(0, mi);
  const runs = t.match(/[\d.,]+/g); if (!runs) return null;
  let s = runs.sort((a, b) => b.length - a.length)[0].replace(/^[.,]+|[.,]+$/g, '');
  const digits = s.replace(/[.,]/g, ''); if (!digits) return null;
  const parts = s.split(/[.,]/);
  let mm;
  if (unit === 'mm') mm = parseInt(digits, 10);
  else if (unit === 'cm') mm = parts.length > 1 ? Math.round(parseFloat(parts.slice(0, -1).join('') + '.' + parts[parts.length - 1]) * 10) : parseInt(digits, 10);
  else { // metros com 3 casas: os dígitos já são os milímetros
    if (parts.length > 1 && parts[parts.length - 1].length !== 3) return null;
    if (digits.length < 3) return null;
    mm = parseInt(digits, 10);
  }
  return mm >= 30 && mm <= 99999 ? mm : null;
}
function parseExpected(str, unit) {
  const s = (str || '').trim().replace(',', '.'); if (!s) return null;
  const n = parseFloat(s); if (!isFinite(n)) return null;
  return unit === 'm' ? Math.round(n * 1000) : unit === 'cm' ? Math.round(n * 10) : Math.round(n);
}

async function ocrCanvas(c, prm) {
  const w = await getWorker();
  const pc = preprocess(c, prm);
  const { data } = await w.recognize(pc);
  return { text: data.text.trim(), conf: data.confidence || 0, mm: parseReading(data.text, prm.unit), canvas: pc };
}

/* ---------------- câmera ---------------- */
let camState = null, stream = null;

async function openCam(opts) {
  camState = Object.assign({ reads: [], hist: [], current: null, loop: 0 }, opts);
  camState.reads = camState.reads.slice();
  camState.prm = JSON.parse(JSON.stringify(opts.profile || activeProfile()));
  $('#cam').classList.remove('hidden');
  $('#camTitle').textContent = opts.title;
  $('#measureCtl').classList.toggle('hidden', opts.mode !== 'measure');
  $('#calibCtl').classList.toggle('hidden', opts.mode !== 'calib');
  $('#procWrap').classList.toggle('hidden', opts.mode !== 'calib');
  $('#reading').innerHTML = '—'; $('#readStatus').textContent = 'Abrindo câmera…';
  history.pushState({ cam: 1 }, '');
  applyModeUi();
  placeBox(); renderChips();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const v = $('#video'); v.srcObject = stream; await v.play();
    try { // foco contínuo / zoom leve quando o aparelho permite
      const tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
      const adv = {}; if (cap.focusMode && cap.focusMode.includes('continuous')) adv.focusMode = 'continuous';
      if (Object.keys(adv).length) await tr.applyConstraints({ advanced: [adv] });
    } catch (e) { }
  } catch (e) {
    $('#readStatus').textContent = 'Sem acesso à câmera. Libere a permissão do navegador.'; return;
  }
  $('#readStatus').textContent = ocrWorker ? 'Aponte para o visor' : 'Carregando leitor (1ª vez precisa de internet)…';
  try { await getWorker(); } catch (e) { $('#readStatus').textContent = 'Falha ao carregar o leitor. Verifique a internet.'; return; }
  runLoop(++camState.loop);
}

function applyModeUi() {
  const s = camState; if (!s) return;
  const multi = isMulti(s.prm);
  $('#box .hint').textContent = multi ? 'Enquadre as 4 medidas da tela' : 'Enquadre só o número principal';
  $('#btnAddRead').disabled = true;
  $('#btnAddRead').textContent = multi ? '✓ Usar medidas' : '＋ Adicionar leitura';
  $('#btnDone').textContent = multi ? 'Ler de novo' : 'Concluir';
  $('#btnAddRead').className = multi ? 'btn ok grow' : 'btn grow';
  $('#btnDone').className = multi ? 'btn grow' : 'btn ok grow';
  s.sel = null; s.frozen = false; s.mhist = []; s.hist = [];
}

function closeCam(fromRoute) {
  if (!camState) return;
  camState.loop++; camState = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('#cam').classList.add('hidden');
  if (!fromRoute && history.state && history.state.cam) history.back();
}
window.addEventListener('popstate', () => { if (camState) closeCam(true); });
window.addEventListener('hashchange', route);

async function runLoop(id) {
  const v = $('#video'), stage = $('#camStage');
  while (camState && camState.loop === id) {
    if (camState.busy || !v.videoWidth) { await sleep(120); continue; }
    try {
      if (camState.frozen) { await sleep(150); continue; }
      const multi = isMulti(camState.prm);
      const crop = grabCrop(v, stage, camState.prm.box, multi ? 360 : 96);
      const r = multi ? await ocrMulti(crop, camState.prm) : await ocrCanvas(crop, camState.prm);
      if (!camState || camState.loop !== id || camState.frozen) continue;
      multi ? onMulti(r) : onReading(r);
    } catch (e) { console.warn(e); await sleep(300); }
    await sleep(80);
  }
}

function onReading(r) {
  const s = camState;
  if (s.mode === 'calib') {
    const pc = $('#procCanvas'); pc.width = r.canvas.width; pc.height = r.canvas.height; pc.getContext('2d').drawImage(r.canvas, 0, 0);
    if (!s.autoBusy && !(s.msgUntil > Date.now())) $('#calResult').textContent = r.mm ? `Lendo: ${r.mm} mm  (texto "${r.text}")` : `Sem leitura válida (texto "${r.text}")`;
    return;
  }
  s.hist.push(r.mm); if (s.hist.length > 4) s.hist.shift();
  // só aceita quando duas leituras seguidas são iguais (evita número errado "plausível")
  const n = s.hist.length, stable = r.mm && n >= 2 && s.hist[n - 1] === s.hist[n - 2];
  if (stable) s.current = r.mm;
  else if (r.mm && s.current && r.mm !== s.current) s.current = null;
  $('#box').classList.toggle('stable', !!s.current);
  const shown = s.current || r.mm;
  $('#reading').innerHTML = shown ? `<span style="opacity:${s.current ? 1 : .45}">${shown}<span class="u">mm</span></span>` : '—';
  $('#readStatus').textContent = s.current ? 'Leitura confirmada ✓ — toque em Adicionar' : r.mm ? 'Conferindo… segure firme' : 'Enquadre só o número principal no quadro';
  $('#btnAddRead').disabled = !s.current;
  $('#btnAddRead').textContent = s.current ? `＋ Adicionar ${s.current}` : '＋ Adicionar leitura';
}

/* ---- modo "4 medidas": lê o histórico da trena de uma vez ---- */
const isMulti = prm => (prm.mode || 'multi') === 'multi';
const DIF_MAX = 50; // mm — leituras longe da mediana provavelmente são de outro vão

function onMulti(r) {
  const s = camState;
  const vals = r.vals.map(v => v.mm);
  if (s.mode === 'calib') {
    const pc = $('#procCanvas'); pc.width = r.canvas.width; pc.height = r.canvas.height; pc.getContext('2d').drawImage(r.canvas, 0, 0);
    const main = r.rows.find(o => o.main);
    if (!s.autoBusy && !(s.msgUntil > Date.now()))
      $('#calResult').textContent = vals.length ? `Lendo ${vals.length} medida(s): ${vals.join(' · ')}` + (main && main.mm ? ` — principal ${main.mm}` : '') : 'Sem leitura válida — ajuste o quadro';
    return;
  }
  const key = JSON.stringify(vals);
  s.mhist = s.mhist || []; s.mhist.push(key); if (s.mhist.length > 3) s.mhist.shift();
  const n = s.mhist.length, stable = vals.length && n >= 2 && s.mhist[n - 1] === s.mhist[n - 2];
  if (!stable) {
    $('#box').classList.remove('stable');
    $('#reading').innerHTML = vals.length ? `<span style="opacity:.45;font-size:26px">${vals.join(' · ')}</span>` : '—';
    $('#readStatus').textContent = vals.length ? 'Conferindo… segure firme' : 'Enquadre as medidas da tela no quadro';
    return;
  }
  // confirmado: congela e marca as que parecem de outro vão
  // referência = a última medida (a grande, embaixo), que com certeza é deste vão
  const mainV = r.vals.find(v => v.main), ref = mainV ? mainV.mm : vals[vals.length - 1];
  s.sel = r.vals.map(v => ({ mm: v.mm, main: v.main, far: Math.abs(v.mm - ref) > DIF_MAX }));
  s.sel.forEach(v => { v.on = !v.far; });
  s.frozen = true; if (navigator.vibrate) navigator.vibrate(60);
  $('#box').classList.add('stable');
  renderMulti();
}

function renderMulti() {
  const s = camState; if (!s || !s.sel) return;
  const on = s.sel.filter(v => v.on).map(v => v.mm), min = on.length ? Math.min(...on) : null;
  $('#reading').innerHTML = min ? `${min}<span class="u">mm (menor)</span>` : '—';
  const far = s.sel.some(v => v.far);
  $('#readStatus').textContent = far ? `⚠ Desmarquei leitura(s) com mais de ${DIF_MAX} mm de diferença — podem ser de outro vão` : 'Toque numa medida para marcar/desmarcar';
  $('#chips').innerHTML = s.sel.map((v, i) => `<span class="chipR ${v.on ? (v.mm === min ? 'min' : '') : 'off'}" data-tg="${i}" style="${v.on ? '' : 'opacity:.45;text-decoration:line-through'}">
    ${v.far ? '⚠ ' : ''}${v.mm}${v.main ? ' <small>(última)</small>' : ''}</span>`).join('');
  $('#btnAddRead').disabled = !on.length;
  $('#btnAddRead').textContent = on.length ? `✓ Usar ${on.length} medida${on.length > 1 ? 's' : ''}` : 'Nenhuma marcada';
}

function renderChips() {
  const s = camState; if (!s) return;
  if (isMulti(s.prm) && s.mode === 'measure') {
    if (!s.sel) $('#chips').innerHTML = '<span class="small" style="opacity:.6">Faça os 4 pontos na trena e aponte para a tela — leio todas de uma vez.</span>';
    return renderMulti();
  }
  const min = s.reads.length ? Math.min(...s.reads) : null;
  let minShown = false;
  $('#chips').innerHTML = s.reads.map((r, i) => {
    const isMin = r === min && !minShown; if (isMin) minShown = true;
    return `<span class="chipR ${isMin ? 'min' : ''}">${r}${isMin ? ' (menor)' : ''}<button data-rm="${i}" aria-label="Remover">✕</button></span>`;
  }).join('') || '<span class="small" style="opacity:.6">Meça 3 ou 4 pontos — fica a menor medida.</span>';
}
$('#chips').addEventListener('click', e => {
  if (!camState) return;
  const t = e.target.closest('[data-tg]'); if (t && camState.sel) { const v = camState.sel[+t.dataset.tg]; v.on = !v.on; return renderMulti(); }
  const b = e.target.closest('[data-rm]'); if (!b) return; camState.reads.splice(+b.dataset.rm, 1); renderChips();
});
$('#btnAddRead').onclick = () => {
  const s = camState; if (!s) return;
  if (isMulti(s.prm)) {
    if (!s.sel) return;
    const reads = s.sel.filter(v => v.on).map(v => v.mm); if (!reads.length) return;
    closeCam(); s.onDone && s.onDone(reads); return;
  }
  if (!s.current) return;
  s.reads.push(s.current); s.hist = []; s.current = null;
  if (navigator.vibrate) navigator.vibrate(40);
  renderChips(); $('#reading').innerHTML = '—'; $('#btnAddRead').disabled = true; $('#btnAddRead').textContent = '＋ Adicionar leitura';
  $('#readStatus').textContent = 'Leitura guardada. Próximo ponto…';
};
$('#btnDone').onclick = () => {
  const s = camState; if (!s) return;
  if (isMulti(s.prm)) { // "Ler de novo"
    s.frozen = false; s.sel = null; s.mhist = []; $('#box').classList.remove('stable');
    $('#reading').innerHTML = '—'; $('#readStatus').textContent = 'Aponte para a tela da trena'; renderChips();
    $('#btnAddRead').disabled = true; $('#btnAddRead').textContent = '✓ Usar medidas'; return;
  }
  const reads = s.reads.slice(); closeCam(); s.onDone && s.onDone(reads); };
$('#btnCamClose').onclick = () => closeCam();

/* quadro arrastável */
function placeBox() {
  if (!camState) return;
  const b = camState.prm.box, el = $('#box'), m = camMap();
  if (!m) { // câmera ainda abrindo: posição aproximada
    el.style.left = (b.x * 100) + '%'; el.style.top = (b.y * 100) + '%'; el.style.width = (b.w * 100) + '%'; el.style.height = (b.h * 100) + '%';
    return;
  }
  el.style.left = (b.x * m.vw * m.sc + m.ox) + 'px'; el.style.top = (b.y * m.vh * m.sc + m.oy) + 'px';
  el.style.width = (b.w * m.vw * m.sc) + 'px'; el.style.height = (b.h * m.vh * m.sc) + 'px';
}
(function dragBox() {
  const el = $('#box'); let st = null;
  el.addEventListener('pointerdown', e => { if (!camState) return; st = { x: e.clientX, y: e.clientY, b: Object.assign({}, camState.prm.box) }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => {
    if (!st || !camState) return;
    const m = camMap(); if (!m) return;
    const b = camState.prm.box;
    b.x = Math.min(1 - b.w, Math.max(0, st.b.x + (e.clientX - st.x) / (m.vw * m.sc)));
    b.y = Math.min(1 - b.h, Math.max(0, st.b.y + (e.clientY - st.y) / (m.vh * m.sc)));
    placeBox();
  });
  el.addEventListener('pointerup', () => { st = null; });
  $('#video').addEventListener('loadedmetadata', placeBox);
  if (window.ResizeObserver) new ResizeObserver(() => placeBox()).observe($('#camStage'));
  else window.addEventListener('resize', placeBox);
})();

/* ---------------- calibração ---------------- */
function startCalib(p) {
  openCam({
    mode: 'calib', title: 'Calibrar: ' + p.name, profile: p,
    onSave: prm => { Object.assign(p, prm, { calibrado: Date.now() }); activeProfileId = p.id; saveProfiles(); renderTrenas(); toast('Perfil salvo e ativado.'); }
  });
  const prm = camState.prm;
  $('#rgW').value = Math.round(prm.box.w * 100); $('#rgH').value = Math.round(prm.box.h * 100);
  prm.mode = prm.mode || 'multi'; $('#calMode').value = prm.mode;
  $('#calUnit').value = prm.unit; $('#calChan').value = prm.chan; $('#calPol').value = prm.pol;
  $('#calOff').value = prm.off; $('#offV').textContent = prm.off; $('#calExpect').value = ''; $('#calResult').textContent = '';
}
function resizeBox(k, v) {
  if (!camState) return; const b = camState.prm.box, cxv = b.x + b.w / 2, cyv = b.y + b.h / 2;
  b[k] = v / 100;
  b.x = Math.min(1 - b.w, Math.max(0, cxv - b.w / 2)); b.y = Math.min(1 - b.h, Math.max(0, cyv - b.h / 2)); placeBox();
}
$('#rgW').oninput = e => resizeBox('w', +e.target.value);
$('#rgH').oninput = e => resizeBox('h', +e.target.value);
$('#calMode').onchange = e => {
  if (!camState) return; const p = camState.prm; p.mode = e.target.value;
  // ajusta o tamanho do quadro ao trocar de modo
  if (p.mode === 'multi' && p.box.h < 0.2) { p.box.y = Math.max(0, p.box.y - 0.18); p.box.h = 0.30; }
  if (p.mode === 'single' && p.box.h > 0.2) { p.box.y += p.box.h - 0.10; p.box.h = 0.10; }
  $('#rgH').value = Math.round(p.box.h * 100); placeBox(); applyModeUi();
};
$('#calUnit').onchange = e => { camState && (camState.prm.unit = e.target.value); };
$('#calChan').onchange = e => { camState && (camState.prm.chan = e.target.value); };
$('#calPol').onchange = e => { camState && (camState.prm.pol = e.target.value); };
$('#calOff').oninput = e => { $('#offV').textContent = e.target.value; camState && (camState.prm.off = +e.target.value); };
$('#btnCalCancel').onclick = () => closeCam();
$('#btnCalSave').onclick = () => { const s = camState; if (!s) return; const prm = JSON.parse(JSON.stringify(s.prm)); closeCam(); s.onSave(prm); };

$('#btnAutoCal').onclick = async () => {
  const s = camState; if (!s || s.autoBusy) return;
  const v = $('#video'); if (!v.videoWidth) return;
  const expected = parseExpected($('#calExpect').value, s.prm.unit);
  s.autoBusy = true; s.busy = true; $('#btnAutoCal').disabled = true;
  // espera o laço atual terminar e congela um quadro
  await sleep(250);
  const multi = isMulti(s.prm);
  const frame = grabCrop(v, $('#camStage'), s.prm.box, multi ? 360 : 96);
  const combos = [];
  for (const chan of ['min', 'lum', 'max']) for (const off of [0, -15, 15, -30, 30, -45, 45]) combos.push({ chan, off, pol: 'auto' });
  let best = null, n = 0;
  for (const c of combos) {
    if (camState !== s) return;
    n++; $('#calResult').textContent = `Testando ajustes… ${n}/${combos.length}`;
    const prm = Object.assign({}, s.prm, c);
    let r; try { r = multi ? await ocrMulti(frame, prm) : await ocrCanvas(frame, prm); } catch (e) { continue; }
    if (multi) { // principal certa + quantas linhas válidas
      const main = r.rows.find(o => o.main); r.mm = main && main.mm; r.n = r.vals.length;
      r.conf = r.vals.length ? r.vals.reduce((a, o) => a + o.conf, 0) / r.vals.length : 0;
    }
    const extra = multi ? 100 * r.n : 0;
    const score = expected ? (r.mm === expected ? 1000 + extra + r.conf : 0) : (r.mm ? extra + r.conf : 0);
    if (!best || score > best.score) best = { score, c, r };
    if (expected && r.mm === expected && r.conf > 85 && (!multi || r.n >= 4)) break;
  }
  s.autoBusy = false; s.busy = false; $('#btnAutoCal').disabled = false; s.msgUntil = Date.now() + 8000;
  if (!best || best.score <= 0) {
    $('#calResult').textContent = expected ? `Não consegui ler ${expected} mm. Ajuste o quadro só em volta do número e tente de novo.` : 'Nenhuma leitura válida. Ajuste o quadro e tente de novo.';
    return;
  }
  Object.assign(s.prm, best.c);
  $('#calChan').value = best.c.chan; $('#calPol').value = 'auto'; $('#calOff').value = best.c.off; $('#offV').textContent = best.c.off;
  $('#calResult').textContent = (expected ? '✓ Calibrado! ' : 'Melhor ajuste encontrado: ') +
    (multi ? `${best.r.n} medida(s) lidas: ${best.r.vals.map(o => o.mm).join(' · ')}. ` : `${best.r.mm} mm (confiança ${Math.round(best.r.conf)}%). `) + 'Toque em Salvar.';
  const pc = $('#procCanvas'); pc.width = best.r.canvas.width; pc.height = best.r.canvas.height; pc.getContext('2d').drawImage(best.r.canvas, 0, 0);
};

/* ---------------- exportar PDF ---------------- */
async function buildPdf(o) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(o.pdf.slice(0));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontR = await doc.embedFont(StandardFonts.Helvetica);
  const blue = rgb(0.04, 0.24, 0.55);
  const cols = o.meta.cols;
  const safe = (f, s) => { try { f.widthOfTextAtSize(s, 8); return s; } catch (e) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?'); } };
  const pages = doc.getPages();
  for (const it of o.meta.items) for (const u of it.units) {
    const pg = pages[u.page]; if (!pg) continue;
    for (const f of ['L', 'H', 'cL', 'cH']) {
      const v = u.v[f]; if (!v || !v.val) continue;
      const s = String(v.val), size = 9, w = font.widthOfTextAtSize(s, size);
      pg.drawText(s, { x: cols[f] - w / 2, y: u.y, size, font, color: blue });
    }
    if (u.loc) {
      let s = safe(fontR, u.loc); const maxW = cols.locR - cols.locL - 4; let size = 8;
      while (fontR.widthOfTextAtSize(s, size) > maxW && size > 6) size -= 0.5;
      while (fontR.widthOfTextAtSize(s, size) > maxW && s.length > 1) s = s.slice(0, -1);
      const w = fontR.widthOfTextAtSize(s, size);
      pg.drawText(s, { x: (cols.locL + cols.locR) / 2 - w / 2, y: u.y, size, font: fontR, color: blue });
    }
  }
  return doc.save();
}

$('#btnExport').onclick = async () => {
  if (!current) return;
  const btn = $('#btnExport'); btn.disabled = true; btn.textContent = 'Gerando…';
  try {
    const bytes = await buildPdf(current);
    const m = current.meta;
    const name = `${m.codigo || 'obra'} - ${(m.obra || 'medicao').replace(/[\\/:*?"<>|]/g, '')} - MEDIDO.pdf`;
    const file = new File([bytes], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  } catch (e) { console.error(e); toast('Erro ao gerar o PDF.'); }
  finally { btn.disabled = false; btn.textContent = 'Gerar PDF preenchido'; }
};

/* ---------------- início ---------------- */
$('#btnImport').onclick = () => $('#filePdf').click();
$('#filePdf').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdf(f); };
$('#btnBack').onclick = () => { location.hash = current ? '#/' : (location.hash.startsWith('#/trenas') ? '#/' : '#/'); };
$('#btnTrenas').onclick = $('#btnGoTrenas').onclick = () => { location.hash = '#/trenas'; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
saveProfiles();
route();

/* para testes fora do navegador */
if (typeof module !== 'undefined') module.exports = { parseReading, parseExpected, preprocess };
