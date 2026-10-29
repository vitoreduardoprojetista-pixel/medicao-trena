/* Protocolo Bluetooth da Tuya (chip "TY", serviço 0x1910), usado na trena Mileseey D5T.
   Baseado no projeto aberto github.com/PlusPlus-ua/ha_tuya_ble.
   Precisa das credenciais da trena tiradas da nuvem Tuya: device_id, local_key e uuid. */
(function (root) {
  const SERV = '00001910-0000-1000-8000-00805f9b34fb';
  const NOTIFY = '00002b10-0000-1000-8000-00805f9b34fb';
  const WRITE = '00002b11-0000-1000-8000-00805f9b34fb';
  const MTU = 20;
  const COD = { DEVICE_INFO: 0x0000, PAIR: 0x0001, DEVICE_STATUS: 0x0003, RECEIVE_DP: 0x8001, RECEIVE_TIME_DP: 0x8003,
    RECEIVE_SIGN_DP: 0x8004, RECEIVE_SIGN_TIME_DP: 0x8005, RECEIVE_DP_V4: 0x8006, RECEIVE_TIME_DP_V4: 0x8007,
    TIME1_REQ: 0x8011, TIME2_REQ: 0x8012 };
  const TIPOS = ['RAW', 'BOOL', 'VALUE', 'STRING', 'ENUM', 'BITMAP'];
  const subtle = (root.crypto || globalThis.crypto).subtle;
  const enc = s => new TextEncoder().encode(s);
  const cat = (...arrs) => { const r = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0)); let p = 0; for (const a of arrs) { r.set(a, p); p += a.length; } return r; };
  const hex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');

  // ---------- MD5 (o navegador não tem) ----------
  function md5(bytes) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
    const n = bytes.length, total = ((n + 8) >> 6) + 1, M = new Uint32Array(total * 16);
    for (let i = 0; i < n; i++) M[i >> 2] |= bytes[i] << ((i % 4) * 8);
    M[n >> 2] |= 0x80 << ((n % 4) * 8);
    M[total * 16 - 2] = (n * 8) >>> 0; M[total * 16 - 1] = Math.floor(n / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let j = 0; j < total; j++) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[j * 16 + g]) >>> 0;
        const s = S[(i >> 4) * 4 + (i % 4)];
        A = D; D = C; C = B; B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, k) => { for (let i = 0; i < 4; i++) out[k * 4 + i] = (v >>> (8 * i)) & 255; });
    return out;
  }

  // ---------- AES-CBC sem preenchimento (o WebCrypto só faz com PKCS7) ----------
  const chave = k => subtle.importKey('raw', k, 'AES-CBC', false, ['encrypt', 'decrypt']);
  async function aesEnc(k, iv, plain) {   // plain com tamanho múltiplo de 16
    const c = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, await chave(k), plain));
    return c.slice(0, plain.length);       // descarta o bloco extra do PKCS7
  }
  async function aesDec(k, iv, cif) {
    // Acrescenta um bloco que decifra como preenchimento PKCS7 válido (16 x 0x10)
    const ultimo = cif.slice(cif.length - 16);
    const alvo = new Uint8Array(16).map((_, i) => 0x10 ^ ultimo[i]);
    const extra = await aesEnc(k, new Uint8Array(16), alvo);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, await chave(k), cat(cif, extra)));
  }

  function crc16(d) {
    let crc = 0xffff;
    for (const b of d) { crc ^= b; for (let i = 0; i < 8; i++) { const t = crc & 1; crc >>= 1; if (t) crc ^= 0xa001; } }
    return crc;
  }
  function packInt(v) { const r = []; do { let b = v & 0x7f; v >>= 7; if (v) b |= 0x80; r.push(b); } while (v); return r; }
  function unpackInt(d, p) { let r = 0, o = 0; while (o < 5) { const b = d[p + o]; r |= (b & 0x7f) << (o * 7); o++; if (!(b & 0x80)) break; } return [r, p + o]; }

  // ---------- Pontos de dados (DP) ----------
  function lerDps(d, p, len2) {
    const dps = [];
    while (d.length - p >= (len2 ? 5 : 4)) {
      const id = d[p], tipo = d[p + 1];
      const n = len2 ? (d[p + 2] << 8) | d[p + 3] : d[p + 2];
      p += len2 ? 4 : 3;
      if (tipo > 5 || p + n > d.length) return null;
      const raw = d.slice(p, p + n);
      let valor;
      if (tipo === 1) valor = raw.some(b => b);
      else if (tipo === 2 || tipo === 4) { valor = 0; for (const b of raw) valor = valor * 256 + b; if (n === 4 && valor > 0x7fffffff) valor -= 2 ** 32; }
      else if (tipo === 3) valor = new TextDecoder().decode(raw);
      else valor = hex(raw);
      dps.push({ id, tipo: TIPOS[tipo], valor });
      p += n;
    }
    return p === d.length ? dps : null;
  }

  class TuyaTrena {
    constructor(cred, log) {
      this.cred = cred; this.log = log || (() => { });
      this.local6 = enc(cred.local_key.slice(0, 6));
      this.loginKey = md5(this.local6);
      this.sessionKey = null; this.authKey = null;
      this.versao = 2; this.seq = 1; this.esperando = new Map();
      this.buf = null; this.esperadoN = 0; this.esperadoLen = 0;
      this.aoReceberDps = () => { };
    }

    async montarPacotes(codigo, dados, respostaA) {
      const ehInfo = codigo === COD.DEVICE_INFO;
      const k = ehInfo ? this.loginKey : this.sessionKey;
      const seq = this.seq++;
      const cab = new Uint8Array(12); const dv = new DataView(cab.buffer);
      dv.setUint32(0, seq); dv.setUint32(4, respostaA || 0); dv.setUint16(8, codigo); dv.setUint16(10, dados.length);
      let raw = cat(cab, dados);
      const crc = crc16(raw);
      raw = cat(raw, new Uint8Array([crc >> 8, crc & 255]));
      if (raw.length % 16) raw = cat(raw, new Uint8Array(16 - raw.length % 16));
      const iv = (root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(16));
      const cifrado = cat(new Uint8Array([ehInfo ? 4 : 5]), iv, await aesEnc(k, iv, raw));
      const pacotes = []; let pos = 0, num = 0;
      while (pos < cifrado.length) {
        let p = packInt(num);
        if (num === 0) p = p.concat(packInt(cifrado.length), [this.versao << 4]);
        const parte = cifrado.slice(pos, pos + MTU - p.length);
        pacotes.push(cat(new Uint8Array(p), parte));
        pos += parte.length; num++;
      }
      return { seq, pacotes };
    }

    async enviar(codigo, dados, respostaA, esperar) {
      const { seq, pacotes } = await this.montarPacotes(codigo, dados, respostaA);
      let promessa = null;
      if (esperar) promessa = new Promise((ok, erro) => {
        this.esperando.set(seq, { ok, erro });
        setTimeout(() => { if (this.esperando.delete(seq)) erro(new Error('a trena não respondeu')); }, esperar);
      });
      for (const p of pacotes) await this.escrever(p);
      return promessa;
    }

    // Chamado a cada notificação recebida da característica 2b10
    async receber(d) {
      let [num, p] = unpackInt(d, 0);
      if (num === 0) { this.buf = new Uint8Array(0); this.esperadoN = 0; [this.esperadoLen, p] = unpackInt(d, p); p += 1; }
      if (num !== this.esperadoN || !this.buf) { this.log('Tuya: pacote fora de ordem'); this.buf = null; this.esperadoN = 0; return; }
      this.buf = cat(this.buf, d.slice(p)); this.esperadoN++;
      if (this.buf.length < this.esperadoLen) return;
      const tudo = this.buf; this.buf = null; this.esperadoN = 0;
      await this.decifrar(tudo);
    }

    async decifrar(tudo) {
      const flag = tudo[0];
      const k = flag === 1 ? this.authKey : flag === 4 ? this.loginKey : this.sessionKey;
      if (!k) { this.log('Tuya: chave ' + flag + ' ainda não disponível'); return; }
      const raw = await aesDec(k, tudo.slice(1, 17), tudo.slice(17));
      const dv = new DataView(raw.buffer);
      const seq = dv.getUint32(0), respostaA = dv.getUint32(4), codigo = dv.getUint16(8), len = dv.getUint16(10);
      if (raw.length < 12 + len) { this.log('Tuya: mensagem curta'); return; }
      if (raw.length >= 14 + len) {
        const crc = (raw[12 + len] << 8) | raw[13 + len];
        if (crc !== crc16(raw.slice(0, 12 + len))) { this.log('Tuya: CRC errado (chave incorreta?)'); return; }
      }
      const dados = raw.slice(12, 12 + len);
      this.log('Tuya: recebido código 0x' + codigo.toString(16) + ' (' + hex(dados) + ')');
      await this.tratar(seq, respostaA, codigo, dados);
    }

    async tratar(seq, respostaA, codigo, d) {
      let resultado = 0;
      if (codigo === COD.DEVICE_INFO) {
        // mantém a versão de envio em 2 (como o app Smart Life faz na gravação da D5T);
        // d[2] é só a versão de protocolo que a trena relata, usada no log abaixo
        this.sessionKey = md5(cat(this.local6, d.slice(6, 12)));
        this.authKey = d.slice(14, 46);
        this.log(`Tuya: protocolo ${d[2]}.${d[3]}, firmware ${d[0]}.${d[1]}`);
      } else if (codigo === COD.PAIR || codigo === COD.DEVICE_STATUS) {
        resultado = d[0] === 2 ? 0 : d[0];   // 2 = já pareado
      } else if (codigo === COD.TIME1_REQ) {
        const tz = Math.round(-new Date().getTimezoneOffset() / 0.6);
        const r = cat(enc(String(Date.now())), new Uint8Array([(tz >> 8) & 255, tz & 255]));
        await this.enviar(codigo, r, seq);
      } else if (codigo === COD.TIME2_REQ) {
        const t = new Date(), tz = Math.round(-t.getTimezoneOffset() / 0.6);
        await this.enviar(codigo, new Uint8Array([t.getFullYear() % 100, t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds(), t.getDay(), (tz >> 8) & 255, tz & 255]), seq);
      } else if (codigo >= 0x8001 && codigo <= 0x8007) {
        let dps = null, resposta = new Uint8Array(0);
        if (codigo === COD.RECEIVE_DP) dps = lerDps(d, 0, false);
        else if (codigo === COD.RECEIVE_SIGN_DP) { dps = lerDps(d, 3, false) || lerDps(d, 2, false); resposta = new Uint8Array([d[0], d[1], d[2], 0]); }
        else if (codigo === COD.RECEIVE_TIME_DP) dps = lerDps(d, d[0] === 0 ? 14 : 5, false);
        else if (codigo === COD.RECEIVE_SIGN_TIME_DP) { dps = lerDps(d, 3 + (d[3] === 0 ? 14 : 5), false); resposta = new Uint8Array([d[0], d[1], d[2], 0]); }
        else {  // versão 4: tenta os formatos conhecidos
          for (const ini of [5, 4, 0]) { dps = lerDps(d, ini, true); if (dps) break; }
          resposta = d.slice(0, 4);
        }
        await this.enviar(codigo, resposta, seq);
        if (dps) { this.log('Tuya DP: ' + dps.map(x => `${x.id}=${x.valor} (${x.tipo})`).join(', ')); this.aoReceberDps(dps); }
        else this.log('Tuya: não entendi os dados acima');
      }
      if (respostaA) {
        const p = this.esperando.get(respostaA);
        if (p) { this.esperando.delete(respostaA); resultado === 0 ? p.ok(resultado) : p.erro(new Error('a trena recusou (código ' + resultado + ')')); }
      }
    }

    // Aperto de mão: pede as informações da trena e depois faz o pareamento com as credenciais
    async conectar() {
      let ok = false;
      for (const v of [2, 3, 4]) {
        this.versao = v;
        try { await this.enviar(COD.DEVICE_INFO, new Uint8Array(0), 0, 4000); ok = true; break; }
        catch (e) { this.log('Tuya: sem resposta com protocolo ' + v); }
      }
      if (!ok) throw new Error('A trena não respondeu ao pedido de informações. Confira a local_key.');
      const c = this.cred;
      let par = cat(enc(c.uuid), this.local6, enc(c.device_id));
      if (par.length < 44) par = cat(par, new Uint8Array(44 - par.length));
      await this.enviar(COD.PAIR, par, 0, 6000);
    }
  }

  // Lê device_id, local_key e uuid de um texto colado (resposta JSON da Tuya ou "campo: valor")
  function lerCredenciais(txt) {
    const pega = re => { const m = txt.match(re); return m ? m[1].trim() : ''; };
    return {
      device_id: pega(/"(?:device_id|id)"\s*:\s*"([^"]+)"/) || pega(/device[_ ]?id\W+([A-Za-z0-9]{10,})/i),
      local_key: pega(/"local_key"\s*:\s*"([^"]+)"/) || pega(/local[_ ]?key\W+(\S{6,})/i),
      uuid: pega(/"uuid"\s*:\s*"([^"]+)"/) || pega(/uuid\W+([A-Za-z0-9]{6,})/i)
    };
  }

  const api = { SERV, NOTIFY, WRITE, COD, TuyaTrena, lerCredenciais, md5, aesEnc, aesDec, crc16, lerDps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Tuya = api;
})(typeof window !== 'undefined' ? window : globalThis);
