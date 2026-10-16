/* Medição Trena — app de campo (v3)
   Lê o PDF "Relação de Itens para Medição" do CEM, mede pela câmera (leitura do visor da trena)
   e devolve o PDF preenchido. */
'use strict';
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIELDS = { L: 'Largura', H: 'Altura', cL: 'Larg. contramarco', cH: 'Alt. contramarco' };
const DIF_MAX = 50; // mm — leituras longe da última provavelmente são de outro vão

let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ================= armazenamento ================= */
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

/* ================= perfis de trena ================= */
// box em frações da IMAGEM DA CÂMERA (não da tela)
const DEFAULT_PROFILE = { mode: 'multi', box: { x: 0.12, y: 0.28, w: 0.76, h: 0.34 }, chan: 'lum', pol: 'auto', off: 0 };
let profiles = lsGet('trenas', null);
if (!profiles || !profiles.length) profiles = [Object.assign({ id: 'p' + Date.now(), name: 'Trena padrão' }, JSON.parse(JSON.stringify(DEFAULT_PROFILE)))];
let activeProfileId = lsGet('trenaAtiva', profiles[0].id);
const activeProfile = () => profiles.find(p => p.id === activeProfileId) || profiles[0];
const saveProfiles = () => { lsSet('trenas', profiles); lsSet('trenaAtiva', activeProfileId); };
const isMulti = prm => (prm.mode || 'multi') === 'multi';

/* ================= leitura do PDF ================= */
if (window.pdfjsLib && pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc)
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const mulM = (m1, m2) => [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];

/* posições das imagens (croquis) de uma página, em pontos PDF */
async function pageImages(page) {
  const O = pdfjsLib.OPS, ops = await page.getOperatorList(), out = [];
  const paint = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintJpegXObject].filter(v => v != null));
  let ctm = [1, 0, 0, 1, 0, 0]; const st = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === O.save) st.push(ctm.slice());
    else if (fn === O.restore) ctm = st.pop() || ctm;
    else if (fn === O.transform) ctm = mulM(ctm, a);
    else if (fn === O.paintFormXObjectBegin) { st.push(ctm.slice()); if (a && Array.isArray(a[0]) && a[0].length === 6) ctm = mulM(ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) ctm = st.pop() || ctm;
    else if (paint.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      out.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
  }
  return out;
}

async function renderCroqui(doc, cq) {
  const page = await doc.getPage(cq.page + 1), scale = 3;
  const vp = page.getViewport({ scale }), vb = vp.viewBox || [0, 0, vp.width / scale, vp.height / scale];
  const pad = 1, x0 = cq.x0 - pad, x1 = cq.x1 + pad, y0 = cq.y0 - pad, y1 = cq.y1 + pad;
  const c = document.createElement('canvas'); c.width = Math.round((x1 - x0) * scale); c.height = Math.round((y1 - y0) * scale);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -(x0 - vb[0]) * scale, -(vb[3] - y1) * scale] }).promise;
  return c.toDataURL('image/jpeg', 0.85);
}

async function readPdf(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    let images = []; try { images = await pageImages(pg); } catch (e) { console.warn('imagens', e); }
    pages.push({ images, items: tc.items.filter(it => it.str !== undefined).map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })) });
  }
  const meta = MedParse.parseMedicao(pages);
  for (const it of meta.items) if (it.croqui) { try { it.croquiImg = await renderCroqui(doc, it.croqui); } catch (e) { console.warn('croqui', e); } }
  return meta;
}

async function importPdf(file) {
  toast('Lendo o PDF…', 8000);
  const bytes = await file.arrayBuffer();
  let parsed;
  try { parsed = await readPdf(bytes); } catch (e) { console.error(e); toast('Não consegui ler este PDF.'); return; }
  const totalUnits = parsed.items.reduce((s, i) => s + i.units.length, 0);
  if (!totalUnits) { toast('Não encontrei linhas de medição (1/1, 1/2…) neste PDF.', 4000); return; }
  for (const it of parsed.items) for (const u of it.units) { u.loc = u.loc0 || it.loc || ''; u.v = {}; }
  const obra = { id: 'o' + Date.now(), criado: Date.now(), arquivo: file.name, pdf: bytes, meta: parsed, page: 0 };
  await DB.put(obra);
  $('#toast').classList.add('hidden');
  location.hash = '#/obra/' + obra.id;
}

/* ================= telas ================= */
let current = null;      // obra aberta
let saveT;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(() => current && DB.put(current), 400); }

function show(view, title, back) {
  for (const v of ['#viewHome', '#viewObra', '#viewTrenas']) $(v).classList.toggle('hidden', v !== view);
  $('#title').textContent = title;
  $('#btnBack').classList.toggle('hidden', !back);
}

async function route() {
  if (camState) closeCam(true);
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/obra\/(\w+)/))) {
    const o = (current && current.id === m[1]) ? current : await DB.get(m[1]);
    if (!o) { location.hash = '#/'; return; }
    current = o; renderObra(true);
  } else if (h.startsWith('#/trenas')) {
    current = null; renderTrenas();
  } else {
    current = null; renderHome();
  }
}

async function renderHome() {
  show('#viewHome', 'Medição Trena', false); window.scrollTo(0, 0);
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

const unitDone = u => !!(u.v.L && u.v.L.val && u.v.H && u.v.H.val);
function progress(o) {
  let done = 0, total = 0;
  for (const it of o.meta.items) for (const u of it.units) { total++; if (unitDone(u)) done++; }
  return { done, total };
}
const fmt = n => (n == null || n === '' ? '' : String(n));
const others = v => { const o = (v.reads || []).slice(); const i = o.indexOf(v.val); if (i >= 0) o.splice(i, 1); return o; };

function fieldHtml(key, f, u) {
  const v = u.v[f] || {}, rest = others(v);
  return `<div class="field">
    <label>${FIELDS[f]}</label>
    <div class="val"><input inputmode="numeric" pattern="[0-9]*" data-k="${key}" data-f="${f}" value="${esc(fmt(v.val))}" placeholder="mm">
    <button class="camb" data-cam="${key}" data-f="${f}" aria-label="Medir com a câmera">📷</button></div>
    <div class="reads">${rest.length ? 'registro: ' + rest.join(' · ') : ''}</div></div>`;
}

function renderObra(top) {
  const o = current, m = o.meta, items = m.items;
  o.page = Math.max(0, Math.min(items.length - 1, o.page || 0));
  show('#viewObra', (m.codigo ? m.codigo + ' · ' : '') + (m.obra || 'Obra'), true);
  renderObraHead();
  // paginação: um chip por item, na ordem da planilha
  $('#pager').innerHTML = items.map((it, ii) => {
    const done = it.units.length && it.units.every(unitDone);
    return `<button class="pg ${ii === o.page ? 'on' : ''} ${done ? 'ok' : ''}" data-pg="${ii}">${esc(it.tipo || it.item)}${done ? ' ✓' : ''}</button>`;
  }).join('');
  const pgOn = $('#pager .pg.on'); if (pgOn && pgOn.scrollIntoView) pgOn.scrollIntoView({ block: 'nearest', inline: 'center' });

  const ii = o.page, it = items[ii], p = it.proj || {};
  const projTxt = p.L ? `${p.L} × ${p.H}` + (p.cL && (p.cL !== p.L || p.cH !== p.H) ? ` <span class="muted">(contramarco ${p.cL} × ${p.cH})</span>` : '') : '—';
  const units = it.units.map((u, ui) => {
    const key = ii + '-' + ui;
    const showCm = u.showCm || (u.v.cL && u.v.cL.val) || (u.v.cH && u.v.cH.val);
    return `<div class="unit"><h4>${esc(it.tipo)} · ${esc(u.label)} ${unitDone(u) ? '<span class="done">✓ medida</span>' : ''}</h4>
      <div class="fields">
        <div class="field loc"><label>Localização${u.loc0 || it.loc ? ' <span class="muted">(da planilha — pode alterar)</span>' : ''}</label>
          <input data-k="${key}" data-f="loc" value="${esc(u.loc)}" placeholder="ex.: Sala, Suíte 1…"></div>
        ${fieldHtml(key, 'L', u)}${fieldHtml(key, 'H', u)}
        ${showCm ? fieldHtml(key, 'cL', u) + fieldHtml(key, 'cH', u) : ''}
      </div>
      ${showCm ? '' : `<button class="cm-toggle" data-cm="${key}">+ medidas do contramarco</button>`}
    </div>`;
  }).join('');
  const info = [['Vidro', it.vidro], ['Tratamento', it.trat], ['Linha', it.linha], ['Obs', it.obs]].filter(x => x[1]);
  $('#itemPage').innerHTML = `<div class="card">
    <div class="row"><span class="tag big">${esc(it.tipo)}</span>
      <div class="grow"><div class="small muted">Item ${it.item} · ${ii + 1} de ${items.length}</div><div class="small">Qtde <b>${it.qtde}</b> · Projeto <b>${projTxt}</b></div></div></div>
    ${it.croquiImg ? `<div class="croqui"><img src="${it.croquiImg}" alt="Croqui ${esc(it.tipo)}"></div>` : ''}
    <div class="descfull">${esc(it.desc) || '<span class="muted">Sem descrição</span>'}</div>
    ${info.length ? `<div class="info">${info.map(([k, v]) => `<div><b>${k}:</b> ${esc(v)}</div>`).join('')}</div>` : ''}
    ${units || '<div class="muted small">Sem linhas de medição.</div>'}
  </div>`;
  $('#btnPrev').disabled = ii === 0;
  $('#btnNext').textContent = ii === items.length - 1 ? 'Gerar PDF' : 'Próximo ▶';
  if (top) window.scrollTo(0, 0);
}

function renderObraHead() {
  const o = current, m = o.meta, { done, total } = progress(o);
  $('#obraHead').innerHTML = `<div style="font-weight:700">${esc(m.obra || o.arquivo)}</div>
    <div class="muted small">${esc(m.endereco || '')}</div>
    <div class="row" style="margin-top:6px"><div class="grow small">Trena: <b>${esc(activeProfile().name)}</b> · <span class="${done === total ? 'done' : ''}">${done}/${total} medidas</span></div>
    <button class="btn pri sm" id="btnExport">Gerar PDF</button></div>`;
}
function goPage(n) { if (!current) return; current.page = n; scheduleSave(); renderObra(true); }

function unitByKey(key) { const [ii, ui] = key.split('-').map(Number); return { it: current.meta.items[ii], u: current.meta.items[ii].units[ui] }; }

function setMeasure(u, f, reads) {
  reads = (reads || []).filter(n => n > 0);
  if (!reads.length) { delete u.v[f]; return; }
  u.v[f] = { val: Math.min(...reads), reads };
}

/* eventos */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open],[data-del],[data-cam],[data-cm],[data-prof],[data-pcal],[data-pdel],[data-pg],#btnExport');
  if (!t) return;
  if (t.id === 'btnExport') exportPdf();
  else if (t.dataset.pg) goPage(+t.dataset.pg);
  else if (t.dataset.open) location.hash = '#/obra/' + t.dataset.open;
  else if (t.dataset.del) { if (confirm('Apagar esta obra do celular?')) DB.del(t.dataset.del).then(renderHome); }
  else if (t.dataset.cm) { unitByKey(t.dataset.cm).u.showCm = true; scheduleSave(); renderObra(); }
  else if (t.dataset.cam) {
    const { it, u } = unitByKey(t.dataset.cam), f = t.dataset.f;
    const prm = activeProfile();
    openCam({
      mode: 'measure', title: `${it.tipo} ${u.label} · ${FIELDS[f]}`,
      onDone: reads => {
        // modo "4 medidas" substitui; modo "só a principal" acumula leituras
        const prev = (u.v[f] && u.v[f].reads) || [];
        setMeasure(u, f, isMulti(prm) ? reads : prev.concat(reads));
        scheduleSave(); renderObra();
      }
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
$('#btnPrev').onclick = () => current && goPage(current.page - 1);
$('#btnNext').onclick = () => { if (!current) return; if (current.page >= current.meta.items.length - 1) exportPdf(); else goPage(current.page + 1); };

/* ================= perfis (tela) ================= */
function renderTrenas() {
  show('#viewTrenas', 'Trenas', true); window.scrollTo(0, 0);
  $('#profList').innerHTML = profiles.map(p => `<div class="prof">
    <div class="grow" data-prof="${p.id}" style="cursor:pointer"><b>${esc(p.name)}</b><br>
      <span class="muted small">${isMulti(p) ? 'Lê as 4 medidas da tela' : 'Lê só a medida principal'} · ${p.calibrado ? 'calibrada ' + new Date(p.calibrado).toLocaleDateString('pt-BR') : 'não calibrada'}</span>
      ${p.id === activeProfileId ? '<div class="on">● ativa</div>' : ''}</div>
    <button class="btn" data-pcal="${p.id}">Calibrar</button>
    <button class="btn bad" data-pdel="${p.id}" aria-label="Apagar">🗑</button></div>`).join('');
}
$('#btnNewProf').onclick = () => {
  const name = $('#newProfName').value.trim() || 'Trena ' + (profiles.length + 1);
  const p = Object.assign(JSON.parse(JSON.stringify(DEFAULT_PROFILE)), { id: 'p' + Date.now(), name, calibrado: null });
  profiles.push(p); activeProfileId = p.id; saveProfiles(); $('#newProfName').value = '';
  startCalib(p);
};

/* ================= leitor (OCR) ================= */
let ocrSched = null, ocrLoading = null;
function getOcr() {
  if (ocrSched) return Promise.resolve(ocrSched);
  if (ocrLoading) return ocrLoading;
  ocrLoading = (async () => {
    const s = Tesseract.createScheduler();
    for (let i = 0; i < 2; i++) {     // 2 leitores em paralelo
      const w = await Tesseract.createWorker('eng', 1, {});
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
      s.addWorker(w);
    }
    ocrSched = s; return s;
  })();
  ocrLoading.catch(() => { ocrLoading = null; });
  return ocrLoading;
}
async function ocr(canvas) { const s = await getOcr(); const r = await s.addJob('recognize', canvas); return r.data; }

/* recorte do quadro (box em frações da imagem da câmera) */
function grabCrop(video, box, targetH = 360) {
  const vw = video.videoWidth, vh = video.videoHeight;
  let x = box.x * vw, y = box.y * vh, w = box.w * vw, h = box.h * vh;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  const k = Math.min(targetH / h, 1000 / w);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
  g.drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

/* binariza: máscara com 1 = pixel de texto (dígito claro ou escuro, detectado sozinho) */
function makeMask(src, prm) {
  const W = src.width, H = src.height;
  const d = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const g = new Uint8Array(W * H), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    const v = prm.chan === 'max' ? Math.max(r, gg, b) : prm.chan === 'min' ? Math.min(r, gg, b) : (0.299 * r + 0.587 * gg + 0.114 * b) | 0;
    g[j] = v; hist[v]++;
  }
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

/* componentes conectados (8-vizinhança) */
function labelCC(mk) {
  const { m, W, H } = mk, lab = new Int32Array(W * H), par = [0];
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) par[b] = a; else par[a] = b; } };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!m[i]) continue;
    let l = 0;
    const nb = [x > 0 ? lab[i - 1] : 0, y > 0 && x > 0 ? lab[i - W - 1] : 0, y > 0 ? lab[i - W] : 0, y > 0 && x < W - 1 ? lab[i - W + 1] : 0];
    for (const n of nb) if (n) { if (!l) l = n; else if (n !== l) uni(l, n); }
    if (!l) { l = par.length; par.push(l); }
    lab[i] = l;
  }
  const stats = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!lab[i]) continue;
    const r = find(lab[i]); lab[i] = r;
    let s = stats.get(r); if (!s) { s = { i: r, x0: x, x1: x, y0: y, y1: y, a: 0 }; stats.set(r, s); }
    if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y; s.a++;
  }
  return { lab, W, H, comps: [...stats.values()].map(s => ({ i: s.i, x: s.x0, y: s.y0, w: s.x1 - s.x0 + 1, h: s.y1 - s.y0 + 1, a: s.a })) };
}

const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/* encontra as linhas de medida: só os dígitos grandes de cada linha
   (descarta ícones, ponto, "m", ângulo e o décimo de mm em subscrito) */
function glyphRows(cc) {
  const { W, H } = cc;
  const comps = cc.comps.filter(c => c.a >= 6 && c.h >= 6 && c.h <= 0.45 * H && c.w <= 0.45 * W && c.w <= 6 * c.h)
    .map(c => Object.assign(c, { cy: c.y + c.h / 2 })).sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const c of comps) {
    const r = rows.find(r => Math.abs(c.cy - r.cy) < 0.5 * Math.max(r.h, c.h));
    if (r) { r.c.push(c); r.h = median(r.c.map(k => k.h)); r.cy = median(r.c.map(k => k.cy)); }
    else rows.push({ c: [c], h: c.h, cy: c.cy });
  }
  const out = [];
  for (const r of rows) {
    const cs = r.c.sort((a, b) => a.x - b.x), gl = [];
    for (const c of cs) {
      const g = gl[gl.length - 1];
      if (g && c.x <= g.x1 - 1) { g.x1 = Math.max(g.x1, c.x + c.w); g.y0 = Math.min(g.y0, c.y); g.y1 = Math.max(g.y1, c.y + c.h); g.ids.push(c.i); }
      else gl.push({ x0: c.x, x1: c.x + c.w, y0: c.y, y1: c.y + c.h, ids: [c.i] });
    }
    gl.forEach(g => { g.h = g.y1 - g.y0; g.w = g.x1 - g.x0; });
    const med = median(gl.map(g => g.h));
    const groups = [[gl[0]]];
    for (const g of gl.slice(1)) { const last = groups[groups.length - 1]; if (g.x0 - last[last.length - 1].x1 > 1.1 * med) groups.push([g]); else last.push(g); }
    for (let k = groups.length - 1; k >= 0; k--) {     // grupo mais à direita com >= 3 dígitos
      const hs = groups[k].map(g => g.h), top = Math.max(...hs);
      const Hd = Math.max(...hs.filter(h => h >= 0.75 * top));
      const tall = groups[k].filter(g => g.h >= 0.86 * Hd && g.h <= 1.15 * Hd);
      if (tall.length >= 3) {
        const mw = median(tall.map(g => g.w));
        const n = tall.reduce((s, g) => s + Math.max(1, Math.round(g.w / mw)), 0);  // dígitos encostados contam 2
        out.push({ g: tall, Hd, n, ymid: r.cy }); break;
      }
    }
  }
  return out;
}

/* monta a linha só com os dígitos, espaçados por igual, preto sobre branco */
function renderRow(cc, row, outH = 80) {
  const gap = Math.round(0.3 * row.Hd), y0 = Math.min(...row.g.map(g => g.y0)), y1 = Math.max(...row.g.map(g => g.y1)), h = y1 - y0;
  const w = row.g.reduce((s, g) => s + g.w, 0) + gap * (row.g.length - 1);
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tx = t.getContext('2d'), im = tx.createImageData(w, h), o = im.data; o.fill(255);
  let ox = 0;
  for (const g of row.g) {
    const ids = new Set(g.ids);
    for (let y = y0; y < y1; y++) for (let x = g.x0; x < g.x1; x++) {
      if (ids.has(cc.lab[y * cc.W + x])) { const i = ((y - y0) * w + (x - g.x0 + ox)) * 4; o[i] = o[i + 1] = o[i + 2] = 0; }
    }
    ox += g.w + gap;
  }
  tx.putImageData(im, 0, 0);
  const k = outH / h, P = 16, c = document.createElement('canvas');
  c.width = Math.round(w * k) + 2 * P; c.height = outH + 2 * P;
  const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingQuality = 'high'; x.drawImage(t, P, P, Math.round(w * k), outH);
  return c;
}

function maskPreview(mk) {
  const c = document.createElement('canvas'); c.width = mk.W; c.height = mk.H;
  const x = c.getContext('2d'), im = x.createImageData(mk.W, mk.H), o = im.data;
  for (let j = 0, i = 0; j < mk.m.length; j++, i += 4) { const v = mk.m[j] ? 0 : 255; o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255; }
  x.putImageData(im, 0, 0); return c;
}

/* lê a tela: devolve as linhas (de cima para baixo) e qual é a principal (a maior) */
async function readScreen(crop, prm, wantPreview) {
  const mk = makeMask(crop, prm), cc = labelCC(mk), rows = glyphRows(cc);
  const res = await Promise.all(rows.map(async r => {
    const d = await ocr(renderRow(cc, r));
    const digits = (d.text || '').replace(/\D/g, '');
    const mm = digits.length >= 3 ? parseInt(digits, 10) : null;   // m com 3 casas ou mm: os dígitos já são milímetros
    const valid = mm != null && mm >= 30 && mm <= 99999;
    return { digits, n: r.n, Hd: r.Hd, mm: valid ? mm : null, ok: valid && digits.length === r.n, conf: d.confidence || 0 };
  }));
  const hmax = Math.max(0, ...res.map(r => r.Hd));
  res.forEach(r => { r.main = r.Hd === hmax && r.Hd >= 1.2 * Math.min(...res.map(q => q.Hd)) || res.length === 1; });
  // se todas têm o mesmo tamanho, a principal é a última (de baixo)
  if (!res.some(r => r.main) && res.length) res[res.length - 1].main = true;
  const main = res.find(r => r.main);
  let out = res.filter(r => r.mm);
  if (!isMulti(prm)) out = main && main.mm ? [main] : [];
  const okRows = out.filter(r => r.ok).length;
  const score = okRows * 100 + (main && main.ok ? 50 : 0) + (out.length ? out.reduce((s, r) => s + r.conf, 0) / out.length : 0);
  const perfect = !!(main && main.ok) && out.length > 0 && out.every(r => r.ok);
  return { rows: res, vals: out, main, okRows, score, perfect, preview: wantPreview ? maskPreview(mk) : null };
}

function parseExpected(str) {
  const s = (str || '').trim().replace(',', '.'); if (!s) return null;
  if (s.includes('.')) { const [a, b] = s.split('.'); return parseInt(a || '0', 10) * 1000 + parseInt((b + '000').slice(0, 3), 10); }
  const n = parseInt(s, 10); return isFinite(n) ? n : null;
}

/* ================= câmera ================= */
let camState = null, stream = null;

function camMap() {
  const v = $('#video'), st = $('#camStage');
  const vw = v.videoWidth, vh = v.videoHeight, sw = st.clientWidth, sh = st.clientHeight;
  if (!vw || !vh || !sw || !sh) return null;
  const sc = Math.max(sw / vw, sh / vh);
  return { vw, vh, sw, sh, sc, ox: (sw - vw * sc) / 2, oy: (sh - vh * sc) / 2 };
}

async function openCam(opts) {
  camState = Object.assign({ loop: 0 }, opts);
  camState.prm = JSON.parse(JSON.stringify(opts.profile || activeProfile()));
  const s = camState, multi = isMulti(s.prm);
  $('#cam').classList.remove('hidden');
  $('#camTitle').textContent = opts.title;
  $('#measureCtl').classList.toggle('hidden', opts.mode !== 'measure');
  $('#calibCtl').classList.toggle('hidden', opts.mode !== 'calib');
  $('#procWrap').classList.add('hidden');
  $('#box .hint').textContent = multi ? 'Enquadre as medidas da tela' : 'Enquadre a medida principal';
  history.pushState({ cam: 1 }, '');
  resetMeasureUi(); placeBox();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const v = $('#video'); v.srcObject = stream; await v.play();
    try {
      const tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
      if (cap.focusMode && cap.focusMode.includes('continuous')) await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch (e) { }
  } catch (e) { setStatus('Sem acesso à câmera. Libere a permissão do navegador.'); return; }
  placeBox();
  if (opts.mode === 'measure') {
    setStatus(ocrSched ? 'Aponte para a tela da trena' : 'Carregando leitor (1ª vez precisa de internet)…');
    try { await getOcr(); } catch (e) { setStatus('Falha ao carregar o leitor. Verifique a internet.'); return; }
    startLoop();
  } else {
    $('#calResult').textContent = 'Enquadre a tela da trena e toque em Capturar.';
    getOcr().catch(() => { });
  }
}
const setStatus = t => { $('#readStatus').textContent = t; };

function closeCam(fromRoute) {
  if (!camState) return;
  camState.loop++; camState = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('#cam').classList.add('hidden');
  if (!fromRoute && history.state && history.state.cam) history.back();
}
window.addEventListener('popstate', () => { if (camState) closeCam(true); });
window.addEventListener('hashchange', route);
$('#btnCamClose').onclick = () => closeCam();

/* ---- medição: lê sozinho e congela no primeiro resultado confiável ---- */
function resetMeasureUi() {
  const s = camState; if (!s) return;
  s.sel = null; s.frozen = false; s.best = null; s.t0 = Date.now();
  $('#box').classList.remove('stable'); $('#snapWrap').classList.add('hidden');
  $('#reading').innerHTML = '—'; $('#chips').innerHTML = '';
  $('#btnUse').disabled = true; $('#btnUse').textContent = '✓ Usar medidas';
}
function startLoop() { const s = camState; if (!s) return; resetMeasureUi(); runLoop(++s.loop); }

async function runLoop(id) {
  const v = $('#video');
  while (camState && camState.loop === id && !camState.frozen) {
    if (!v.videoWidth) { await sleep(120); continue; }
    const s = camState;
    try {
      const crop = grabCrop(v, s.prm.box);
      const r = await readScreen(crop, s.prm);
      if (camState !== s || s.loop !== id || s.frozen) break;
      r.crop = crop;
      if (!s.best || r.score > s.best.score) s.best = r;
      const waited = Date.now() - s.t0;
      if (r.perfect) { freeze(r); break; }
      if (waited > 5000 && s.best.main && s.best.main.mm) { freeze(s.best); break; }   // depois de 5 s usa a melhor leitura
      $('#reading').innerHTML = r.vals.length ? `<span style="opacity:.45;font-size:24px">${r.vals.map(x => x.mm).join(' · ')}</span>` : '—';
      setStatus(r.vals.length ? 'Lendo… segure firme' : 'Enquadre as medidas da tela no quadro');
    } catch (e) { console.warn(e); await sleep(300); }
  }
}

function freeze(r) {
  const s = camState; s.frozen = true;
  if (navigator.vibrate) navigator.vibrate(60);
  $('#box').classList.add('stable');
  const snap = $('#snapImg'); snap.src = r.crop.toDataURL('image/jpeg', 0.8); $('#snapWrap').classList.remove('hidden');
  const ref = r.main && r.main.mm ? r.main.mm : r.vals[r.vals.length - 1].mm;
  s.sel = r.vals.map(v => ({ mm: v.mm, main: v.main, ok: v.ok, far: Math.abs(v.mm - ref) > DIF_MAX }));
  s.sel.forEach(v => { v.on = v.ok && !v.far; });
  if (!s.sel.some(v => v.on) && s.sel.length) { const m = s.sel.find(v => v.main) || s.sel[s.sel.length - 1]; m.on = true; }
  renderSel();
}

function renderSel() {
  const s = camState; if (!s || !s.sel) return;
  const on = s.sel.filter(v => v.on).map(v => v.mm), min = on.length ? Math.min(...on) : null;
  $('#reading').innerHTML = min ? `${min}<span class="u">mm${on.length > 1 ? ' (menor)' : ''}</span>` : '—';
  const warn = [];
  if (s.sel.some(v => v.far)) warn.push(`⚠ = mais de ${DIF_MAX} mm de diferença da última (pode ser de outro vão)`);
  if (s.sel.some(v => !v.ok)) warn.push('? = leitura duvidosa');
  setStatus((warn.length ? warn.join(' · ') + ' — ' : '') + 'Confira com a foto. Toque para marcar/desmarcar.');
  $('#chips').innerHTML = s.sel.map((v, i) => `<span class="chipR tg ${v.on ? (v.mm === min ? 'min' : '') : 'off'}" data-tg="${i}">
    ${v.far ? '⚠ ' : ''}${v.ok ? '' : '? '}${v.mm}${v.main ? ' <small>(última)</small>' : ''}</span>`).join('');
  $('#btnUse').disabled = !on.length;
  $('#btnUse').textContent = on.length ? `✓ Usar ${on.length > 1 ? on.length + ' medidas' : min}` : 'Nenhuma marcada';
}
$('#chips').addEventListener('click', e => {
  const t = e.target.closest('[data-tg]'); if (!t || !camState || !camState.sel) return;
  const v = camState.sel[+t.dataset.tg]; v.on = !v.on; renderSel();
});
$('#btnUse').onclick = () => {
  const s = camState; if (!s || !s.sel) return;
  const reads = s.sel.filter(v => v.on).map(v => v.mm); if (!reads.length) return;
  closeCam(); s.onDone && s.onDone(reads);
};
$('#btnRetry').onclick = () => { if (camState) { startLoop(); setStatus('Aponte para a tela da trena'); } };

/* quadro arrastável (posição guardada em relação à imagem da câmera) */
function placeBox() {
  if (!camState) return;
  const b = camState.prm.box, el = $('#box'), m = camMap();
  if (!m) { el.style.left = (b.x * 100) + '%'; el.style.top = (b.y * 100) + '%'; el.style.width = (b.w * 100) + '%'; el.style.height = (b.h * 100) + '%'; return; }
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

/* ================= calibração (sobre uma foto capturada) ================= */
function startCalib(p) {
  openCam({
    mode: 'calib', title: 'Calibrar: ' + p.name, profile: p,
    onSave: prm => { Object.assign(p, prm, { calibrado: Date.now() }); activeProfileId = p.id; saveProfiles(); renderTrenas(); toast('Perfil salvo e ativado.'); }
  });
  const prm = camState.prm; prm.mode = prm.mode || 'multi';
  camState.snap = null; camState.found = null;
  $('#calMode').value = prm.mode;
  $('#rgW').value = Math.round(prm.box.w * 100); $('#rgH').value = Math.round(prm.box.h * 100);
  $('#calChan').value = prm.chan || 'lum'; $('#calOff').value = prm.off || 0; $('#offV').textContent = prm.off || 0;
  $('#calExpect').value = ''; $('#btnAutoCal').disabled = true; $('#btnCapture').textContent = '📸 Capturar';
  $('#btnCalSave').disabled = !p.calibrado;
}
function resizeBox(k, v) {
  if (!camState) return; const b = camState.prm.box, cxv = b.x + b.w / 2, cyv = b.y + b.h / 2;
  b[k] = v / 100;
  b.x = Math.min(1 - b.w, Math.max(0, cxv - b.w / 2)); b.y = Math.min(1 - b.h, Math.max(0, cyv - b.h / 2)); placeBox();
}
$('#rgW').oninput = e => resizeBox('w', +e.target.value);
$('#rgH').oninput = e => resizeBox('h', +e.target.value);
$('#calMode').onchange = e => { if (camState) { camState.prm.mode = e.target.value; $('#box .hint').textContent = isMulti(camState.prm) ? 'Enquadre as medidas da tela' : 'Enquadre a medida principal'; } };
$('#calChan').onchange = e => { camState && (camState.prm.chan = e.target.value); };
$('#calOff').oninput = e => { $('#offV').textContent = e.target.value; camState && (camState.prm.off = +e.target.value); };
$('#btnCalCancel').onclick = () => closeCam();
$('#btnCalSave').onclick = () => { const s = camState; if (!s) return; const prm = JSON.parse(JSON.stringify(s.prm)); closeCam(); s.onSave(prm); };

$('#btnCapture').onclick = () => {
  const s = camState, v = $('#video'); if (!s || !v.videoWidth) return;
  s.snap = grabCrop(v, s.prm.box);
  const pc = $('#procCanvas'); pc.width = s.snap.width; pc.height = s.snap.height; pc.getContext('2d').drawImage(s.snap, 0, 0);
  $('#procWrap').classList.remove('hidden');
  $('#btnCapture').textContent = '📸 Capturar de novo'; $('#btnAutoCal').disabled = false;
  $('#calResult').textContent = 'Foto capturada. Digite a medida principal (opcional) e toque em Auto calibrar.';
};

$('#btnAutoCal').onclick = async () => {
  const s = camState; if (!s || !s.snap || s.autoBusy) return;
  const expected = parseExpected($('#calExpect').value);
  s.autoBusy = true; $('#btnAutoCal').disabled = true; $('#btnCapture').disabled = true;
  try { await getOcr(); } catch (e) { $('#calResult').textContent = 'Falha ao carregar o leitor. Verifique a internet.'; s.autoBusy = false; $('#btnAutoCal').disabled = false; $('#btnCapture').disabled = false; return; }
  const combos = [];
  for (const off of [0, 20, -20, 40, -40]) for (const chan of ['lum', 'min', 'max']) combos.push({ chan, off, pol: 'auto' });
  let best = null, n = 0;
  for (const c of combos) {
    if (camState !== s) return;
    n++; $('#calResult').textContent = `Testando ajustes… ${n}/${combos.length}`;
    const prm = Object.assign({}, s.prm, c);
    let r; try { r = await readScreen(s.snap, prm, true); } catch (e) { continue; }
    const hit = expected != null && r.main && r.main.mm === expected;
    const score = (hit ? 10000 : 0) + r.score;
    if (!best || score > best.score) best = { score, c, r, hit };
    if (hit && r.perfect && (!isMulti(prm) || r.vals.length >= 4)) break;
  }
  s.autoBusy = false; $('#btnAutoCal').disabled = false; $('#btnCapture').disabled = false;
  if (!best || !best.r.vals.length) { $('#calResult').textContent = 'Não consegui ler. Ajuste o quadro para cobrir as medidas, capture de novo e tente outra vez.'; return; }
  Object.assign(s.prm, best.c);
  $('#calChan').value = best.c.chan; $('#calOff').value = best.c.off; $('#offV').textContent = best.c.off;
  const r = best.r, others = r.vals.filter(v => !v.main).map(v => v.mm + (v.ok ? '' : '?'));
  const main = r.main && r.main.mm ? r.main.mm + (r.main.ok ? '' : '?') : '—';
  let msg = (expected != null ? (best.hit ? '✓ Calibrado! ' : `⚠ Não achei ${expected} como medida principal. Melhor ajuste: `) : 'Melhor ajuste: ');
  msg += `principal ${main}` + (others.length ? ` · anteriores ${others.join(' · ')}` : '') + '. Confira e toque em Salvar.';
  $('#calResult').textContent = msg;
  const pc = $('#procCanvas'); pc.width = r.preview.width; pc.height = r.preview.height; pc.getContext('2d').drawImage(r.preview, 0, 0);
  $('#btnCalSave').disabled = false;
};

/* ================= exportar PDF ================= */
async function buildPdf(o) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.load(o.pdf.slice(0));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontR = await doc.embedFont(StandardFonts.Helvetica);
  const blue = rgb(0.04, 0.24, 0.55), grey = rgb(0.35, 0.42, 0.5);
  const cols = o.meta.cols;
  const safe = (f, s) => { try { f.widthOfTextAtSize(s, 8); return s; } catch (e) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?'); } };
  const pages = doc.getPages();
  const cellW = Math.abs(cols.H - cols.L) - 3;
  for (const it of o.meta.items) for (const u of it.units) {
    const pg = pages[u.page]; if (!pg) continue;
    for (const f of ['L', 'H', 'cL', 'cH']) {
      const v = u.v[f]; if (!v || !v.val) continue;
      const rest = others(v);
      // medida oficial (a menor) em destaque; as demais em letra pequena, como registro
      const s = String(v.val), size = 9, w = font.widthOfTextAtSize(s, size);
      pg.drawText(s, { x: cols[f] - w / 2, y: rest.length ? u.y - 2.5 : u.y, size, font, color: blue });
      if (rest.length) {
        let t = rest.join(' '), sz = 4.6;
        while (fontR.widthOfTextAtSize(t, sz) > cellW && sz > 3.2) sz -= 0.2;
        const tw = fontR.widthOfTextAtSize(t, sz);
        pg.drawText(t, { x: cols[f] - tw / 2, y: u.y + 6.2, size: sz, font: fontR, color: grey });
      }
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

async function exportPdf() {
  if (!current) return;
  const btns = [$('#btnExport'), $('#btnNext')].filter(Boolean);
  btns.forEach(b => b.disabled = true); toast('Gerando PDF…');
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
  finally { btns.forEach(b => b.disabled = false); if (current) renderObra(); }
}

/* ================= início ================= */
$('#btnImport').onclick = () => $('#filePdf').click();
$('#filePdf').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdf(f); };
$('#btnBack').onclick = () => { location.hash = '#/'; };
$('#btnTrenas').onclick = $('#btnGoTrenas').onclick = () => { location.hash = '#/trenas'; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
saveProfiles();
route();
