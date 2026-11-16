// "שערי מטבע": the Bank of Israel representative rate + daily change, the market rate (open.er-api), crypto (CoinGecko),
// a 30-day sparkline per currency (BOI SDMX for fiat, CoinGecko market_chart for crypto) and a converter.
import { h, proxied, BROWSER_UA, log, openLayer } from '../core.js';
import { row, toggle, choice, section, more } from '../ui.js';

// A switch whose grey hint sits under its label (not between the label and the switch).
const sw = (label, value, on, hint, deps) => toggle(hint ? h('span', {}, label, h('span', { class: 'hint' }, hint)) : label, value, on, '', deps);

const BOI = 'https://boi.org.il/PublicApi/GetExchangeRates';
const SDMX = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/';
const ER = 'https://open.er-api.com/v6/latest/ILS';
const CG = 'https://api.coingecko.com/api/v3';
const CACHE = 'haluach.c.rates';
const HIST_TTL = 6 * 3600_000; // history moves once a day: fetch it at most every 6 hours

const CRYPTO = { bitcoin: ['ביטקוין', 'BTC'], ethereum: ['אתריום', 'ETH'], solana: ['סולנה', 'SOL'], ripple: ['ריפל', 'XRP'], tether: ['טת\'ר', 'USDT'], litecoin: ['לייטקוין', 'LTC'], dogecoin: ['דוג\'קוין', 'DOGE'], cardano: ['קרדנו', 'ADA'] };
const FIAT_HE = { USD: 'דולר', EUR: 'יורו', GBP: 'לירה שטרלינג', JPY: 'יין', CHF: 'פרנק שוויצרי', CAD: 'דולר קנדי', AUD: 'דולר אוסטרלי', JOD: 'דינר ירדני', EGP: 'לירה מצרית' };
let dn = null;
export function fiatName(code) {
  if (FIAT_HE[code]) return FIAT_HE[code];
  try { dn ||= new Intl.DisplayNames('he', { type: 'currency' }); return dn.of(code); } catch { return code; }
}
const cryptoName = id => CRYPTO[id]?.[0] || id;

// ---------- pure parsing ----------
/** PublicApi -> { USD: { rate (per 1 unit), change (%), unit, at } }. */
export function parseBoi(j) {
  const out = {};
  for (const r of j.exchangeRates || []) out[r.key] = { rate: r.currentExchangeRate / (r.unit || 1), change: r.currentChange, unit: r.unit || 1, at: r.lastUpdate };
  return out;
}
/** open.er-api (base ILS) -> { USD: shekels per 1 unit }. */
export function parseEr(j) {
  const out = {};
  for (const [k, v] of Object.entries(j.rates || {})) if (v) out[k] = 1 / v;
  return out;
}
/** SDMX-JSON -> { USD: [[ 'YYYY-MM-DD', value ], ...] } (only the shape matters for the sparkline). */
export function parseSdmx(j) {
  const st = j.data.structure, codes = st.dimensions.series.find(d => d.id === 'SERIES_CODE').values.map(v => v.id);
  const times = st.dimensions.observation[0].values.map(v => v.id);
  const out = {};
  for (const [key, ser] of Object.entries(j.data.dataSets[0].series || {})) {
    const code = codes[+key.split(':')[0]].replace(/^RER_|_ILS$/g, '');
    out[code] = Object.entries(ser.observations).map(([i, v]) => [times[+i], +v[0]]).filter(x => x[1]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  return out;
}
/** CoinGecko simple/price -> { bitcoin: { ils, usd, change } }. */
export function parseCg(j) {
  const out = {};
  for (const [id, v] of Object.entries(j || {})) out[id] = { ils: v.ils, usd: v.usd, change: v.ils_24h_change };
  return out;
}

/** Shekels for one unit of an item: 'USD' / 'bitcoin' / 'ILS'. by = 'boi' | 'market'. */
export function shekels(d, item, by = 'boi') {
  if (item === 'ILS') return 1;
  if (d.crypto?.[item]) return d.crypto[item].ils;
  const boi = d.boi?.[item]?.rate, mk = d.market?.[item];
  return by === 'market' ? (mk ?? boi) : (boi ?? mk);
}
export function convert(d, amount, from, to, by) {
  const a = shekels(d, from, by), b = shekels(d, to, by);
  return a && b ? amount * a / b : null;
}

// ---------- fetching ----------
const ago = days => { const d = new Date(Date.now() - days * 86400_000); return d.toISOString().slice(0, 10); };
async function fetchAll(s, old) {
  const fiat = s.fiat || [], crypto = s.crypto || [];
  const jobs = {
    boi: proxied(BOI, { headers: [BROWSER_UA] }).then(parseBoi),
    market: proxied(ER).then(parseEr),
    crypto: crypto.length ? proxied(`${CG}/simple/price?ids=${crypto.join(',')}&vs_currencies=ils,usd&include_24hr_change=true`).then(parseCg) : Promise.resolve({}),
  };
  const keys = Object.keys(jobs), res = await Promise.allSettled(Object.values(jobs));
  const d = { ...(old || {}) };
  let ok = 0;
  res.forEach((r, i) => { if (r.status === 'fulfilled') { d[keys[i]] = r.value; ok++; } else log('rates: ' + r.reason?.message); });
  if (!ok) throw new Error('rates: no source answered');
  // History: once in HIST_TTL, or when the list of currencies changed.
  const hist = { ...(d.hist || {}) }, want = [...fiat.filter(c => d.boi?.[c]), ...crypto];
  const fresh = d.histAt && Date.now() - d.histAt < HIST_TTL;
  const missing = want.filter(k => !hist[k]);
  if (!fresh || missing.length) {
    const needFiat = (fresh ? missing : want).filter(k => d.boi?.[k]);
    const needCrypto = (fresh ? missing : want).filter(k => crypto.includes(k));
    const hj = [];
    if (needFiat.length) hj.push(proxied(`${SDMX}${needFiat.map(c => `RER_${c}_ILS`).join('+')}?startperiod=${ago(31)}&format=sdmx-json`, { headers: [BROWSER_UA] })
      .then(j => Object.assign(hist, parseSdmx(j))));
    for (const id of needCrypto) hj.push(proxied(`${CG}/coins/${id}/market_chart?vs_currency=ils&days=30&interval=daily`)
      .then(j => { hist[id] = j.prices.map(([t, v]) => [new Date(t).toISOString().slice(0, 10), v]); }));
    const hr = await Promise.allSettled(hj);
    hr.forEach(r => r.status === 'rejected' && log('rates history: ' + r.reason?.message));
    d.hist = hist;
    if (hr.every(r => r.status === 'fulfilled')) d.histAt = Date.now();
  }
  d.at = Date.now();
  return d;
}
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch { return null; } }

// ---------- view ----------
function spark(points) {
  if (!points || points.length < 2) return h('span', { class: 'fx-spark' });
  const v = points.map(p => p[1]), lo = Math.min(...v), hi = Math.max(...v), W = 70, H = 22;
  // RTL board: the newest point on the left, like the zmanim arc (morning on the right).
  const xy = v.map((y, i) => `${(W - (i / (v.length - 1)) * W).toFixed(1)},${(H - 2 - ((y - lo) / ((hi - lo) || 1)) * (H - 4)).toFixed(1)}`);
  const up = v.at(-1) >= v[0];
  return h('svg', { class: 'fx-spark ' + (up ? 'up' : 'down'), viewBox: `0 0 ${W} ${H}`, width: W, height: H,
    html: `<title>30 יום: ${lo.toFixed(lo < 10 ? 4 : 0)} עד ${hi.toFixed(hi < 10 ? 4 : 0)}</title><polyline points="${xy.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>` });
}
const fmt = (n, d) => n == null ? '-' : n.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = c => h('span', { class: 'fx-ch num' + (c > 0 ? ' up' : c < 0 ? ' down' : '') }, c == null ? '' : (c > 0 ? '+' : '') + c.toFixed(2) + '%');
const digits = v => v >= 1000 ? 0 : v >= 10 ? 2 : v >= 0.1 ? 3 : 5;

/** One item per chosen currency/crypto: { key, name, value, title, change, extra (market or USD), hist }. */
function items(d, s) {
  const out = [];
  for (const c of s.fiat || []) {
    const b = d.boi?.[c], mk = d.market?.[c];
    const main = b ? b.rate * b.unit : mk;
    if (main == null) continue;
    out.push({ key: c, name: (b && b.unit > 1 ? b.unit + ' ' : '') + fiatName(c), value: fmt(main, digits(main)), title: b ? 'שער יציג, בנק ישראל' : 'שער שוק',
      change: b ? b.change : null, extra: s.showMarket && b && mk ? ['שוק', fmt(mk * b.unit, digits(main))] : null, hist: d.hist?.[c] });
  }
  for (const id of s.crypto || []) {
    const x = d.crypto?.[id];
    if (!x) continue;
    out.push({ key: id, name: cryptoName(id), value: '₪' + fmt(x.ils, digits(x.ils)), title: '', change: x.change,
      extra: x.usd != null ? ['דולר', '$' + fmt(x.usd, digits(x.usd))] : null, hist: d.hist?.[id] });
  }
  return out;
}

// The converter keeps its amount across re-renders (module state; the pair is saved in the settings).
let amount = 100;
const SWAP = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3"/></svg>';
function converter(d, ctx) {
  const s = ctx.s;
  const items = ['ILS', ...(s.fiat || []).filter(c => shekels(d, c)), ...(s.crypto || []).filter(c => d.crypto?.[c])];
  const label = k => k === 'ILS' ? 'שקל' : d.crypto?.[k] ? cryptoName(k) : fiatName(k);
  const pick = val => h('select', { onchange: () => { ctx.set({ conv: { from: from.value, to: to.value } }); calc(); } },
    ...items.map(k => h('option', { value: k, selected: k === val }, label(k))));
  const from = pick(items.includes(s.conv?.from) ? s.conv.from : items[1] || 'ILS');
  const to = pick(items.includes(s.conv?.to) ? s.conv.to : 'ILS');
  const inp = h('input', { type: 'number', class: 'fx-amt num', value: amount, min: 0, step: 'any', 'aria-label': 'סכום', oninput: () => { amount = +inp.value || 0; calc(); } });
  const out = h('span', { class: 'num big' });
  const swap = h('button', { class: 'icon', title: 'החלפה', 'aria-label': 'החלפה', html: SWAP, onclick: () => { const f = from.value; from.value = to.value; to.value = f; ctx.set({ conv: { from: from.value, to: to.value } }); calc(); } });
  function calc() {
    const r = convert(d, amount, from.value, to.value, s.convBy);
    out.textContent = r == null ? '-' : fmt(r, digits(r));
  }
  calc();
  return h('div', { class: 'fx-conv' }, h('div', { class: 'fx-conv-in' }, inp, from, swap, to), out);
}

function details(d, ctx) {
  const s = ctx.s;
  openLayer(body => {
    body.append(h('h2', {}, 'שערי מטבע'));
    for (const x of items(d, s)) {
      body.append(h('div', { class: 'fx-row wide' },
        h('span', { class: 'fx-name', title: x.key }, x.name),
        spark(x.hist),
        h('span', { class: 'fx-v' }, h('b', { class: 'num', title: x.title }, x.value), x.extra ? h('div', { class: 'faint num fx-mk' }, x.extra[0] + ' ' + x.extra[1]) : null),
        pct(x.change)));
    }
    const boiAt = Object.values(d.boi || {})[0]?.at;
    if (boiAt) body.append(h('div', { class: 'faint fx-note' }, 'שער יציג מ-' + new Date(boiAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + '. הגרף: 30 יום.'));
    if (s.converter) body.append(h('hr', { class: 'sep' }), h('div', { class: 'item' }, h('div', { class: 'val' }, 'המרה')), converter(d, ctx));
  });
}

const pctText = c => c == null ? '' : ` (${c > 0 ? '+' : ''}${c.toFixed(2)}%)`;
/** The widget: big = the USD representative rate, sub = its daily change, rows = each chosen currency/crypto. */
export function widgetSummary(d, s) {
  const usd = d.boi?.USD, usdV = usd ? usd.rate : d.market?.USD;
  const rows = [];
  for (const c of s.fiat || []) {
    const b = d.boi?.[c], main = b ? b.rate * b.unit : d.market?.[c];
    if (main != null) rows.push([(b && b.unit > 1 ? b.unit + ' ' : '') + fiatName(c), fmt(main, digits(main)) + (b ? pctText(b.change) : '')]);
  }
  for (const id of s.crypto || []) {
    const x = d.crypto?.[id];
    if (x?.ils != null) rows.push([cryptoName(id), '₪' + fmt(x.ils, digits(x.ils)) + pctText(x.change)]);
  }
  // One summary per item, for a widget set (התאמה אישית) to a single currency or coin. Keys as in the settings.
  const per = {};
  const chText = (c, when) => c == null ? '' : `, ${c > 0 ? '+' : ''}${c.toFixed(2)}% ${when}`;
  for (const c of s.fiat || []) {
    const b = d.boi?.[c], mk = d.market?.[c], main = b ? b.rate * b.unit : mk;
    if (main == null) continue;
    const name = (b && b.unit > 1 ? b.unit + ' ' : '') + fiatName(c);
    per[c] = { name, big: '₪ ' + fmt(main, digits(main)), sub: b ? name + ' יציג' + chText(b.change, 'היום') : name + ', שער שוק',
      rows: b && mk ? [['שער שוק', fmt(mk * b.unit, digits(main))]] : [], at: d.at };
  }
  for (const id of s.crypto || []) {
    const x = d.crypto?.[id];
    if (x?.ils == null) continue;
    per[id] = { name: cryptoName(id), big: '₪ ' + fmt(x.ils, digits(x.ils)), sub: cryptoName(id) + chText(x.change, 'ב-24 שעות'),
      rows: x.usd != null ? [['דולר', '$' + fmt(x.usd, digits(x.usd))]] : [], at: d.at };
  }
  return {
    per,
    big: usdV != null ? '$ ' + fmt(usdV, 3) : '',
    sub: usd?.change != null ? `דולר יציג, ${usd.change > 0 ? '+' : ''}${usd.change.toFixed(2)}% היום` : usdV != null ? 'דולר, שער שוק' : 'אין שער דולר',
    rows,
  };
}

const X = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const DEFAULTS = { fiat: ['USD', 'EUR'], crypto: ['bitcoin'], showMarket: true, convBy: 'boi', converter: true, refreshMin: 60, conv: { from: 'USD', to: 'ILS' } };

export default {
  id: 'rates',
  title: 'שערי מטבע',
  size: [1, 3],
  defaults: DEFAULTS,
  every: ctx => Math.max(5, +ctx.s.refreshMin || 60) * 60_000,
  css: `
.fx-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 60px; gap: 8px; align-items: baseline; padding: 3px 0; font-size: 13px; width: 100%; background: none; border: 0; text-align: start; cursor: pointer; }
.fx-row.wide { grid-template-columns: minmax(0, 1fr) 70px auto 60px; align-items: center; cursor: default; }
.fx-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-row b { font-weight: 600; }
.fx-v { text-align: end; }
.fx-mk { font-size: 11px; }
.fx-ch { font-size: 12px; text-align: left; color: var(--fg3); }
.fx-ch.up { color: var(--good); } .fx-ch.down { color: var(--bad); }
.fx-spark { width: 70px; height: 22px; color: var(--fg3); }
.fx-spark.up { color: var(--good); } .fx-spark.down { color: var(--bad); }
.fx-note { font-size: 11px; padding-top: 6px; }
.fx-conv { display: grid; gap: 6px; }
.fx-conv-in { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.fx-conv select { max-width: 10em; }
.fx-amt { width: 7em; }
.fx-add { display: inline-flex; gap: 6px; align-items: center; }
.fx-add input { width: 9em; }
`,
  async render(el, ctx) {
    const s = ctx.s;
    let c = readCache();
    try {
      c = await fetchAll(s, c);
      try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch {}
      ctx.stale(new Date(c.at), false);
    } catch (e) {
      log(e.message);
      ctx.stale(c ? new Date(c.at) : null, true);
      if (!c) { el.replaceChildren(h('div', { class: 'sub' }, 'אין חיבור למקורות השערים.')); return; }
    }
    const list = items(c, s), open = () => details(c, ctx);
    if (!list.length) { el.replaceChildren(h('div', { class: 'sub' }, 'אין שערים להצגה.')); return; }
    el.replaceChildren(
      ...list.map(x => h('button', { class: 'fx-row', title: x.title, onclick: open },
        h('span', { class: 'fx-name' }, x.name), h('b', { class: 'num' }, x.value), pct(x.change))),
      h('button', { class: 'more', onclick: open }, s.converter ? 'פירוט והמרה' : 'פירוט'));
  },
  // From the card's cache; fetches only when the cache is older than the refresh interval (the card is hidden).
  async widget(ctx) {
    try {
      const s = ctx?.s || DEFAULTS;
      let c = readCache();
      if (!c || Date.now() - (c.at || 0) > Math.max(5, +s.refreshMin || 60) * 60_000) {
        try { c = await fetchAll(s, c); try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch {} } catch (e) { log('rates widget: ' + e.message); }
      }
      if (!c) return { big: '', sub: 'אין נתוני שערים', rows: [] };
      return widgetSummary(c, s);
    } catch { return { big: '', sub: 'אין נתוני שערים', rows: [] }; }
  },
  settings(box, ctx) {
    const s = ctx.s, d = readCache() || {};
    const fiat = [...(s.fiat || [])], crypto = [...(s.crypto || [])];
    const put = (patch, redraw = true) => { ctx.set(patch); if (redraw) ctx.rerender(); };
    const list = h('div', { class: 'form' });
    const rm = (arr, i, key) => h('button', { class: 'icon', title: 'הסרה', 'aria-label': 'הסרה', html: X, onclick: () => { arr.splice(i, 1); put({ [key]: [...arr] }); draw(); } });
    const draw = () => list.replaceChildren(
      ...fiat.map((c, i) => row(fiatName(c), rm(fiat, i, 'fiat'), d.boi?.[c] ? 'שער יציג' : 'שער שוק בלבד')),
      ...crypto.map((c, i) => row(cryptoName(c), rm(crypto, i, 'crypto'), 'מטבע דיגיטלי')),
      fiat.length + crypto.length ? '' : h('div', { class: 'sub' }, 'לא נבחר מטבע.'));
    draw();
    // Fiat: every code the Bank of Israel publishes first, then the rest of the market list.
    const codes = [...new Set([...Object.keys(d.boi || FIAT_HE), ...Object.keys(d.market || {})])].filter(k => k !== 'ILS');
    const addF = h('select', {}, h('option', { value: '' }, 'בחירה...'), ...codes.map(k => h('option', { value: k }, fiatName(k))));
    addF.onchange = () => { if (addF.value && !fiat.includes(addF.value)) { fiat.push(addF.value); put({ fiat: [...fiat] }); draw(); } addF.value = ''; };
    // Digital coins: a Hebrew name from the short list, or the coin's English name.
    const addC = h('input', { type: 'text', list: 'fx-cg', placeholder: 'ביטקוין, אתריום...' });
    const dl = h('datalist', { id: 'fx-cg' }, ...Object.values(CRYPTO).map(([he]) => h('option', { value: he })));
    const msg = h('span', { class: 'hint' });
    const addCBtn = h('button', { class: 'btn primary', onclick: async () => {
      const v = addC.value.trim();
      const id = Object.entries(CRYPTO).find(([, [he]]) => he === v)?.[0] || v.toLowerCase().replace(/\s+/g, '-');
      if (!id || crypto.includes(id)) return;
      msg.textContent = 'בודק...';
      try {
        const j = await proxied(`${CG}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=ils`);
        if (!j[id]) { msg.textContent = 'המטבע לא נמצא.'; return; }
        crypto.push(id); addC.value = ''; msg.textContent = ''; put({ crypto: [...crypto] }); draw();
      } catch { msg.textContent = 'אין חיבור. נסו שוב.'; }
    } }, 'הוספה');
    box.append(
      section('מטבעות'), list,
      row('הוספת מטבע', addF),
      h('div', { class: 'srow' }, h('span', {}, 'מטבע דיגיטלי', msg), h('span', { class: 'fx-add' }, addC, addCBtn)), dl,
      section('תצוגה'),
      ...sw('גם שער שוק', s.showMarket, v => put({ showMarket: v }), 'ליד השער היציג, בפירוט'),
      ...sw('מחשבון המרה', s.converter, v => put({ converter: v }), '', [
        row('ההמרה לפי', choice([['boi', 'שער יציג'], ['market', 'שער שוק']], s.convBy === 'market' ? 'market' : 'boi', v => put({ convBy: v }, false)))]),
      more(row('רענון', choice([[15, '15 דק׳'], [30, '30 דק׳'], [60, 'שעה'], [180, '3 שעות']], +s.refreshMin, v => put({ refreshMin: v }, false)))),
    );
  },
};
