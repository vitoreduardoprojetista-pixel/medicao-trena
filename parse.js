/* Leitura da "Relação de Itens para Medição" do SmartCEM.
   Entrada: pages = [{ items: [{ str, x, y, w }] }]   (x,y em pontos PDF; y = linha de base, origem embaixo)
   Saída: { codigo, obra, cliente, endereco, cols, items:[{ item, tipo, qtde, desc, vidro, proj, units:[{label,page,y}] }] } */
(function (root) {
  const DEFAULT_COLS = { locL: 239, locR: 398, L: 423.5, H: 464.6, cL: 505.7, cH: 546.8, item: 94, tipo: 148.6, qtde: 208.8 };
  const LABELS = ['Tratamento', 'Linha', 'Obs', 'Esquadria', 'Contramarco', 'Item', 'Localiza', 'Relação', 'Relacao',
    'Emitido', 'Atenção', 'Atencao', 'Responsável', 'Responsavel', 'SmartCEM', 'ALUMNIX'];
  const DESC_X = 175;

  function groupLines(items, tol) {
    const sorted = items.filter(i => i.str && i.str.trim()).slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const ln = lines.find(l => Math.abs(l.y - it.y) <= tol);
      if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (const l of lines) l.items.sort((a, b) => a.x - b.x);
    lines.sort((a, b) => b.y - a.y);
    return lines;
  }
  const txt = its => its.map(i => i.str.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const cx = i => i.x + (i.w || 0) / 2;

  function findCols(pages) {
    for (const p of pages) {
      const lines = groupLines(p.items, 2);
      for (const ln of lines) {
        const loc = ln.items.find(i => /^Localiza/.test(i.str.trim()));
        if (!loc) continue;
        const lh = ln.items.filter(i => /^[LH]$/.test(i.str.trim())).sort((a, b) => a.x - b.x);
        const item = ln.items.find(i => i.str.trim() === 'Item');
        const tipo = ln.items.find(i => i.str.trim() === 'Tipo');
        const qtde = ln.items.find(i => i.str.trim() === 'Qtde');
        if (lh.length >= 4) {
          const c = cx(loc);
          return {
            locL: c - 78, locR: c + 78,
            L: cx(lh[0]), H: cx(lh[1]), cL: cx(lh[2]), cH: cx(lh[3]),
            item: item ? cx(item) : DEFAULT_COLS.item, tipo: tipo ? cx(tipo) : DEFAULT_COLS.tipo, qtde: qtde ? cx(qtde) : DEFAULT_COLS.qtde
          };
        }
      }
    }
    return Object.assign({}, DEFAULT_COLS);
  }

  function nearest(items, center, maxd) {
    let best = null, bd = maxd;
    for (const i of items) { const d = Math.abs(cx(i) - center); if (d < bd) { bd = d; best = i; } }
    return best;
  }

  function parseMedicao(pages) {
    const cols = findCols(pages);
    const out = { codigo: '', obra: '', cliente: '', endereco: '', cols, items: [] };
    const byNum = new Map();
    const getItem = (num, tipo) => {
      if (!byNum.has(num)) { const o = { item: num, tipo: tipo || '', qtde: 0, desc: '', vidro: '', proj: {}, units: [] }; byNum.set(num, o); out.items.push(o); }
      const o = byNum.get(num); if (tipo && !o.tipo) o.tipo = tipo; return o;
    };
    let descBuf = [], pendingDesc = '', pendingVidro = '', pendingCroqui = null, pendingInfo = {};
    const locText = ln => txt(ln.items.filter(i => cx(i) > cols.locL && cx(i) < cols.locR));

    pages.forEach((p, pi) => {
      const imgs = (p.images || []).filter(im => im.x0 < DESC_X && (im.x1 - im.x0) > 40 && (im.y1 - im.y0) > 30);
      const lines = groupLines(p.items, 2);
      for (const ln of lines) {
        const all = txt(ln.items);
        if (pi === 0) {
          let m;
          if (!out.codigo && (m = all.match(/Medi[çc][ãa]o:\s*(\S+)/))) out.codigo = m[1];
          if (!out.obra && (m = all.match(/^Obra:\s*(.+)$/))) out.obra = m[1].trim();
          if (!out.cliente && (m = all.match(/^Cliente:\s*(.+)$/))) out.cliente = m[1].trim();
          if (!out.endereco && (m = all.match(/^Endere[çc]o:\s*(.+)$/))) out.endereco = m[1].trim();
        }
        const first = ln.items[0];
        const f = first.str.trim();
        const rowNum = () => { const n = nearest(ln.items.filter(i => /^\d+$/.test(i.str.trim())), cols.item, 22); return n ? parseInt(n.str, 10) : null; };
        const rowTipo = () => { const t = nearest(ln.items.filter(i => i !== first), cols.tipo, 30); return t ? t.str.trim() : ''; };

        if (first.x < 75 && /^\d+\/\d+$/.test(f)) {                 // linha de unidade (1/2, 2/2 ...)
          const num = rowNum(); if (num == null) continue;
          getItem(num, rowTipo()).units.push({ label: f, page: pi, y: first.y, loc0: locText(ln) });
          descBuf = [];
          continue;
        }
        if (first.x < 75 && f === 'CEM') {                            // linha de projeto do CEM
          const num = rowNum(); if (num == null) continue;
          const it = getItem(num, rowTipo());
          const q = nearest(ln.items.filter(i => /^\d+$/.test(i.str.trim())), cols.qtde, 20);
          if (q) it.qtde = parseInt(q.str, 10);
          const nums = ln.items.filter(i => /^\d+([.,]\d+)?$/.test(i.str.trim()) && cx(i) > cols.locR);
          for (const k of ['L', 'H', 'cL', 'cH']) { const n = nearest(nums, cols[k], 18); if (n) it.proj[k] = parseInt(n.str, 10); }
          if (pendingDesc && !it.desc) { it.desc = pendingDesc; it.vidro = pendingVidro; Object.assign(it, pendingInfo); }
          if (pendingCroqui && !it.croqui) it.croqui = pendingCroqui;
          it.loc = locText(ln);
          pendingDesc = ''; pendingVidro = ''; pendingCroqui = null; pendingInfo = {}; descBuf = [];
          continue;
        }
        if (first.x < 40) { descBuf = []; continue; }                  // cabeçalho/rodapé de largura total
        const right = ln.items.filter(i => i.x >= DESC_X);
        if (!right.length) continue;
        const rt = txt(right);
        if (/^Vidros?:/.test(rt)) {
          pendingDesc = descBuf.join(' ').trim(); pendingVidro = rt.replace(/^Vidros?:\s*/, ''); descBuf = [];
          // croqui = imagem à esquerda mais próxima desta linha
          let best = null, bd = 120;
          for (const im of imgs) { const d = Math.abs((im.y0 + im.y1) / 2 - ln.y); if (d < bd) { bd = d; best = im; } }
          pendingCroqui = best ? { page: pi, x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 } : null;
          continue;
        }
        let mm;
        if ((mm = rt.match(/^Tratamento:\s*(.*)$/))) { pendingInfo.trat = mm[1]; continue; }
        if ((mm = rt.match(/^Linha:\s*(.*)$/))) { pendingInfo.linha = mm[1]; continue; }
        if ((mm = rt.match(/^Obs:\s*(.*)$/))) { pendingInfo.obs = mm[1]; continue; }
        if (LABELS.some(l => rt.startsWith(l))) continue;
        if (/^\d+\s*\/\s*\d+$/.test(rt)) continue;                    // número de página
        descBuf.push(rt);
      }
    });
    // mantém a ordem em que os itens aparecem na planilha
    for (const it of out.items) { if (!it.qtde) it.qtde = it.units.length; }
    return out;
  }

  const api = { parseMedicao, DEFAULT_COLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MedParse = api;
})(this);
