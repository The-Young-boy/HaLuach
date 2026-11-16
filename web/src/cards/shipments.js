// "משלוחים": tracking numbers with names. The data comes from Cainiao only (SPEC); for other carriers the card
// shows the carrier's name and a link to its own tracking page.
import { h, proxied, openLayer, openExternal, cardSettings, log, openCardSettings } from '../core.js';
import { row, toggle, number, choice, section, more, debounce } from '../ui.js';

// A switch whose grey hint sits under its label (not between the label and the switch).
const sw = (label, value, on, hint, deps) => toggle(hint ? h('span', {}, label, h('span', { class: 'hint' }, hint)) : label, value, on, '', deps);

/** Carriers by number pattern, first match wins. `cainiao` = Cainiao's global tracking knows these numbers. */
export const CARRIERS = [
  { id: 'cainiao', name: 'עליאקספרס', cainiao: true, re: /^(LP\d{12,16}|CN[A-Z0-9]{8,}|CAINIAO\w+|AE\d{10,}|CNG\w+|ALS\d+)$/, url: n => `https://global.cainiao.com/newDetail.htm?mailNoList=${n}` },
  { id: 'chinapost', name: 'דואר סין', cainiao: true, re: /^[A-Z]{2}\d{9}CN$/, url: n => `https://global.cainiao.com/newDetail.htm?mailNoList=${n}` },
  { id: 'yun', name: 'YunExpress', cainiao: true, re: /^YT\d{16}$/, url: n => `https://www.yuntrack.com/parcelTracking?id=${n}` },
  { id: 'cainiao4px', name: '4PX', cainiao: true, re: /^4PX\w+$/, url: n => `https://track.4px.com/#/result/0/${n}` },
  { id: 'israelpost', name: 'דואר ישראל', cainiao: false, re: /^[A-Z]{2}\d{9}IL$/, url: n => `https://doar.israelpost.co.il/deliverytracking?itemcode=${n}` },
  { id: 'ups', name: 'UPS', cainiao: false, re: /^1Z[A-Z0-9]{16}$/, url: n => `https://www.ups.com/track?tracknum=${n}` },
  { id: 'amazon', name: 'Amazon', cainiao: false, re: /^TBA\d{9,13}$/, url: n => `https://track.amazon.com/tracking/${n}` },
  { id: 'dhl', name: 'DHL', cainiao: false, re: /^(\d{10}|JD\d{16,18}|JJD\d+|GM\d{16,20})$/, url: n => `https://www.dhl.com/il-he/home/tracking.html?tracking-id=${n}` },
  { id: 'fedex', name: 'FedEx', cainiao: false, re: /^(\d{12}|\d{15}|\d{20}|\d{22})$/, url: n => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  { id: 'upu', name: 'דואר בינלאומי', cainiao: true, re: /^[A-Z]{2}\d{9}[A-Z]{2}$/, url: n => `https://global.cainiao.com/newDetail.htm?mailNoList=${n}` },
  { id: 'hfd', name: 'HFD', cainiao: false, re: null, url: () => 'https://www.hfd.co.il/' },
  { id: 'chita', name: "צ'יטה", cainiao: false, re: null, url: () => 'https://chita-il.com/' },
  { id: 'boxit', name: 'Boxit', cainiao: false, re: null, url: () => 'https://boxit.co.il/' },
  { id: 'other', name: 'לא זוהה', cainiao: true, re: null, url: n => `https://global.cainiao.com/newDetail.htm?mailNoList=${n}` },
];
export const norm = n => String(n || '').toUpperCase().replace(/[\s-]/g, '');
export function detect(number) {
  const n = norm(number);
  return CARRIERS.find(c => c.re && c.re.test(n)) || CARRIERS.at(-1);
}
const carrierOf = item => CARRIERS.find(c => c.id === item.carrier) || detect(item.number);

// ---------- Cainiao ----------
const DELIVERED = /SIGN|DELIVER/i;
/** One `module[]` entry -> { status, statusText, delivered, events: [{ t, desc }] newest first }. */
export function parseCainiao(m) {
  const events = (m?.detailList || []).map(d => ({ t: d.time || Date.parse(String(d.timeStr).replace(' ', 'T')) || 0, desc: d.desc || d.standerdDesc || '', code: d.actionCode || '' }))
    .sort((a, b) => b.t - a.t);
  const latest = events[0];
  const delivered = DELIVERED.test(m?.status || '') || DELIVERED.test(latest?.code || '');
  return {
    status: m?.status || latest?.code || (events.length ? 'TRANSIT' : 'NONE'),
    statusText: m?.statusDesc || latest?.desc || (events.length ? '' : 'אין מידע עדיין'),
    latest: latest?.desc || '', latestAt: latest?.t || 0,
    delivered, deliveredAt: delivered ? latest?.t || Date.now() : 0,
    from: m?.originCountry || '', to: m?.destCountry || '', events,
  };
}
async function fetchCainiao(numbers, lang) {
  const out = {};
  for (let i = 0; i < numbers.length; i += 10) {
    const chunk = numbers.slice(i, i + 10);
    const d = await proxied(`https://global.cainiao.com/global/detail.json?mailNos=${chunk.map(encodeURIComponent).join(',')}&lang=${lang}`);
    if (!d?.success) throw new Error('cainiao: no success');
    for (const m of d.module || []) out[norm(m.mailNo)] = parseCainiao(m);
  }
  return out;
}

// ---------- the last data per number (localStorage) ----------
const DK = 'haluach.shipments.data';
const loadData = () => { try { return JSON.parse(localStorage.getItem(DK) || '{}'); } catch { return {}; } };
const saveData = d => { try { localStorage.setItem(DK, JSON.stringify(d)); } catch {} };

const DEFAULTS = { items: [], delivered: 'keep', hideDays: 7, lang: 'he-IL' };

/** Fetches every Cainiao number, keeps the data, and returns what changed since the last check:
 *  [{ number, name, status }] (status = the newest event's text). The owner wires background checks and notifications. */
export async function checkAll() {
  const s = cardSettings('shipments', DEFAULTS);
  const items = (s.items || []).filter(it => carrierOf(it).cainiao);
  if (!items.length) return [];
  const data = loadData();
  const got = await fetchCainiao(items.map(it => norm(it.number)), s.lang);
  const changes = [];
  for (const it of items) {
    const n = norm(it.number), now = got[n];
    if (!now) continue;
    const before = data[n];
    if (before && now.latestAt > (before.latestAt || 0)) changes.push({ number: n, name: it.name || n, status: now.latest || now.statusText });
    data[n] = { ...now, deliveredAt: before?.deliveredAt || now.deliveredAt, at: Date.now() };
  }
  data._at = Date.now();
  saveData(data);
  return changes;
}

const date = t => t ? new Date(t).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const visible = (it, d, s) => !(s.delivered === 'hide' && d?.delivered && d.deliveredAt && Date.now() - d.deliveredAt > s.hideDays * 864e5);

const cut = (t, n = 38) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** The widget: big = how many are on the way, sub = the latest change, rows = name -> status (changed in 24h = bold). */
export function widgetSummary(s, data, now = Date.now()) {
  const items = (s.items || []).filter(it => visible(it, data[norm(it.number)], s));
  const rows = [];
  let onWay = 0, latest = null;
  for (const it of items) {
    const c = carrierOf(it), d = data[norm(it.number)], name = it.name || norm(it.number);
    if (!d?.delivered) onWay++;
    if (d?.latestAt && (!latest || d.latestAt > latest.at)) latest = { at: d.latestAt, text: `${name}: ${d.latest || d.statusText}` };
    rows.push([name, !c.cainiao ? 'מעקב בדף החברה' : !d ? '...' : d.delivered ? 'נמסר' : cut(d.latest || d.statusText), !!d?.latestAt && now - d.latestAt < 864e5 && !d.delivered]);
  }
  // One summary per shipment, for a widget set (התאמה אישית) to one of them. Key: the number.
  const per = {};
  for (const it of s.items || []) {
    const c = carrierOf(it), d = data[norm(it.number)], name = it.name || norm(it.number);
    per[norm(it.number)] = { name, big: !c.cainiao ? '' : !d ? '...' : d.delivered ? 'נמסר' : 'בדרך',
      sub: !c.cainiao ? 'מעקב בדף החברה' : cut(d?.latest || d?.statusText || 'אין עדכון עדיין', 60),
      rows: (d?.events || []).slice(0, 3).map(e => [cut(e.desc, 40), date(e.t)]) };
  }
  if (!items.length) return { big: '0', sub: 'כל המשלוחים נמסרו', rows: [], per };
  return { big: `${onWay} בדרך`, sub: latest ? cut(latest.text, 60) : 'אין עדכון עדיין', rows, per };
}

function historyLayer(it, d) {
  const c = carrierOf(it);
  openLayer(body => {
    body.append(h('h2', {}, it.name || it.number),
      h('div', { class: 'sub' }, c.name, ' · ', h('span', { class: 'num' }, norm(it.number)), d?.from || d?.to ? ` · ${d.from || '?'} > ${d.to || '?'}` : ''),
      h('hr', { class: 'sep' }), h('button', { class: 'btn', onclick: () => openExternal(c.url(norm(it.number))) }, 'לדף המעקב של ' + c.name));
    if (!c.cainiao) { body.append(h('div', { class: 'sub' }, 'אין מקור נתונים פתוח לחברה הזאת. המעקב רק בדף שלה.')); return; }
    if (!d?.events?.length) { body.append(h('div', { class: 'sub' }, 'אין מידע עדיין.')); return; }
    body.append(h('hr', { class: 'sep' }), ...d.events.map((e, i) => h('div', { class: 'row' + (i === 0 ? ' next' : '') }, h('span', {}, e.desc), h('b', { class: 'num' }, date(e.t)))));
  });
}

/** One shipment: carrier above the name, a short status at the end; a click opens its history. */
function itemRow(it, data) {
  const c = carrierOf(it), d = data[norm(it.number)];
  const full = !c.cainiao ? 'מעקב בדף של החברה' : !d ? '...' : d.delivered ? 'נמסר' : (d.latest || d.statusText) + (d.latestAt ? ' · ' + date(d.latestAt) : '');
  const short = !c.cainiao ? 'בדף החברה' : !d ? '...' : d.delivered ? 'נמסר' : cut(d.latest || d.statusText, 18);
  return h('div', { class: 'item sh-it', role: 'button', tabindex: 0, title: full, onclick: () => historyLayer(it, d), onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); historyLayer(it, d); } } },
    h('div', {}, h('div', { class: 'lab' }, c.name), h('div', { class: 'val' }, it.name || norm(it.number))),
    h('span', { class: 'end ' + (d?.delivered ? 'up' : 'sub') }, short));
}

export default {
  id: 'shipments',
  title: 'משלוחים',
  size: [1, 3],
  defaults: DEFAULTS,
  every: 30 * 60_000,
  async render(el, ctx) {
    const s = ctx.s;
    if (!s.items?.length) { el.replaceChildren(h('div', { class: 'sub' }, 'אין משלוחים במעקב.'), h('button', { class: 'btn pod-empty', onclick: () => openCardSettings('shipments') }, 'הוספת משלוח')); return; }
    let failed = false;
    try { await checkAll(); } catch (e) { failed = true; log('shipments: ' + e.message); }
    const data = loadData();
    const shown = s.items.filter(it => visible(it, data[norm(it.number)], s));
    const rows = shown.map(it => itemRow(it, data));
    // At most 6 on the card; the rest in the layer.
    el.replaceChildren(...(rows.length ? rows.slice(0, 6) : [h('div', { class: 'sub' }, 'כל המשלוחים נמסרו.')]),
      rows.length > 6 ? h('button', { class: 'more', onclick: () => openLayer(body => body.append(h('h2', {}, 'משלוחים'), ...shown.map(it => itemRow(it, data)))) }, `עוד ${rows.length - 6}`) : '');
    ctx.stale(data._at ? new Date(data._at) : null, failed);
  },
  // The card's saved data; checks Cainiao only when the last check is older than the card's interval (card hidden).
  async widget(ctx) {
    try {
      const s = ctx?.s || DEFAULTS;
      if (!s.items?.length) return { big: '', sub: 'אין משלוחים במעקב', rows: [], empty: true };
      let data = loadData();
      if (!data._at || Date.now() - data._at > 30 * 60_000) {
        try { await checkAll(); } catch (e) { log('shipments widget: ' + e.message); }
        data = loadData();
      }
      return widgetSummary(s, data);
    } catch { return { big: '', sub: 'אין נתוני משלוחים', rows: [] }; }
  },
  settings(box, ctx) {
    const s = ctx.s;
    let items = [...(s.items || [])];
    const put = (patch, redraw = true) => { ctx.set(patch); if (redraw) ctx.rerender(); };
    const saveItems = debounce(() => put({ items: [...items] }));
    // Adding: the number (the carrier is found from it) and a name.
    const num = h('input', { type: 'text', class: 'sh-wide', placeholder: 'מספר מעקב', dir: 'ltr' });
    const name = h('input', { type: 'text', class: 'sh-wide', placeholder: 'למשל: אוזניות' });
    const found = h('span', { class: 'hint' });
    num.addEventListener('input', () => { found.textContent = num.value.trim() ? 'זוהה: ' + detect(num.value).name : ''; });
    const add = () => {
      const n = norm(num.value);
      if (n.length < 6) { found.textContent = 'מספר קצר מדי.'; return; }
      if (!items.some(x => norm(x.number) === n)) items.push({ number: n, name: name.value.trim(), carrier: detect(n).id, added: Date.now() });
      num.value = name.value = ''; found.textContent = '';
      put({ items: [...items] }); draw();
    };
    num.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    // The list: one folded group per shipment (name, carrier, delete inside).
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren(items.length ? section(`במעקב (${items.length})`) : '', ...items.map((it, i) => {
        const title = h('span', {}, it.name || norm(it.number));
        return h('details', {}, h('summary', {}, title, h('span', { class: 'faint num' }, norm(it.number))),
          h('div', { class: 'form' },
            row('שם', h('input', { type: 'text', class: 'sh-wide', value: it.name || '', placeholder: 'שם', oninput: e => { items[i] = { ...items[i], name: e.target.value }; title.textContent = e.target.value || norm(it.number); saveItems(); } })),
            row('חברת משלוחים', h('select', { onchange: e => { items[i] = { ...items[i], carrier: e.target.value }; put({ items: [...items] }); } },
              ...CARRIERS.map(c => h('option', { value: c.id, selected: c.id === carrierOf(it).id }, c.name)))),
            h('div', {}, h('button', { class: 'btn', onclick: () => { items.splice(i, 1); put({ items: [...items] }); draw(); } }, 'מחיקה'))));
      }));
    };
    draw();
    box.append(
      section('הוספת משלוח'),
      row('מספר מעקב', num, found), row('שם', name),
      h('div', {}, h('button', { class: 'btn primary', onclick: add }, 'הוספה')),
      list,
      section('משלוח שנמסר'),
      ...sw('להסתיר אחרי כמה ימים', s.delivered === 'hide', v => put({ delivered: v ? 'hide' : 'keep' }), 'כבוי: נשאר עד שמוחקים', [
        row('אחרי', number(s.hideDays, 'ימים', v => put({ hideDays: Math.max(1, v || 7) }), { min: 1, max: 90 }))]),
      more(row('שפת העדכונים', choice([['he-IL', 'עברית'], ['en-US', 'אנגלית']], s.lang === 'en-US' ? 'en-US' : 'he-IL', v => put({ lang: v })))),
    );
  },
};

export const css = `
.sh-it { cursor: pointer; border-radius: var(--radius-s); }
.sh-it:hover .val { color: var(--accent); }
.sh-it > div { min-width: 0; }
.sh-it > .end { font-size: 12px; }
.sh-wide { width: min(60%, 220px); }
`;
