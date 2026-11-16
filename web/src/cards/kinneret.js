// "מפלס הכנרת": the latest level from data.gov.il (Water Authority), change from the previous measurement,
// distance to the red lines, a graph (30 days or a year, the user's choice) and the same date last year. No alerts.
import { h, proxied, BROWSER_UA, log, openLayer, growFrom } from '../core.js';
import { row, choice } from '../ui.js';

const URL_ = 'https://data.gov.il/api/3/action/datastore_search?resource_id=2de7b543-e13d-4e7e-b4c8-56071bc4d3c8&limit=420&sort=Survey_Date%20desc';
const CACHE = 'haluach.c.kinneret';
export const UPPER = -208.8, LOWER = -213;

// ---------- pure ----------
/** CKAN answer -> [{ t: 'YYYY-MM-DD', v }] oldest first, one point per date. */
export function parse(j) {
  const m = new Map();
  for (const r of j.result?.records || []) {
    const t = String(r.Survey_Date || '').slice(0, 10), v = +r.Kinneret_Level;
    if (t && Number.isFinite(v) && v < -200 && v > -220) m.set(t, v);
  }
  return [...m].map(([t, v]) => ({ t, v })).sort((a, b) => a.t < b.t ? -1 : 1);
}
const day = t => Date.parse(t + 'T00:00:00Z') / 86400_000;
/** The numbers the card shows. Distances in meters (positive = how far), change in cm. */
export function stats(series) {
  const last = series.at(-1), prev = series.at(-2);
  if (!last) return null;
  // The same date last year: the nearest measurement within a week of it.
  let ly = null, best = 8;
  for (const p of series) { const d = Math.abs(day(p.t) - (day(last.t) - 365)); if (d < best) { best = d; ly = p; } }
  const cm = x => Math.round(x * 1000) / 10;
  return {
    last, prev,
    change: prev ? cm(last.v - prev.v) : null,
    toUpper: Math.round((UPPER - last.v) * 1000) / 1000,
    toLower: Math.round((last.v - LOWER) * 1000) / 1000, // < 0: below the lower red line
    lastYear: ly, vsLastYear: ly ? cm(last.v - ly.v) : null,
  };
}
export function range(series, days) {
  const end = day(series.at(-1).t);
  return series.filter(p => day(p.t) >= end - days);
}

// ---------- view ----------
const dm = t => `${+t.slice(8, 10)}.${+t.slice(5, 7)}`;
const dmy = t => `${dm(t)}.${t.slice(2, 4)}`;
const m2 = v => v.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lvl = v => v.toLocaleString('he-IL', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
/** A signed number with its unit outside the .num span. */
const unit = (v, u) => h('span', {}, h('span', { class: 'num' }, v), ' ' + u);
const cm = c => unit(`${c > 0 ? '+' : ''}${c.toLocaleString('he-IL', { maximumFractionDigits: 1 })}`, 'ס״מ');
const meters = v => unit(m2(v), 'מ׳');
const dir = c => c > 0 ? 'up' : c < 0 ? 'down' : '';
/** Distance to the lower red line: cm under a meter, meters above. */
// A distance with no sign: the label already says above or below.
const lowerDist = d => Math.abs(d) < 1 ? unit((Math.round(Math.abs(d) * 1000) / 10).toLocaleString('he-IL', { maximumFractionDigits: 1 }), 'ס״מ') : meters(Math.abs(d));

/** The lake: water up to the level, gentle waves, the two red lines. Scale -215 .. -208. */
function lake(v) {
  const W = 300, H = 74, lo = -215, hi = -208;
  const y = x => H - ((x - lo) / (hi - lo)) * H;
  const wy = y(v).toFixed(1);
  const wave = amp => `M${-W} ${wy}` + Array.from({ length: 8 }, (_, i) => ` q 37.5 ${i % 2 ? amp : -amp} 75 0`).join('') + ` V ${H} H ${-W} Z`;
  const line = val => `<line class="kn-red" x1="0" x2="${W}" y1="${y(val)}" y2="${y(val)}"/>`;
  return h('svg', { class: 'kn-lake', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', width: '100%', height: H, 'aria-hidden': true,
    html: `<title>הקווים המקווקווים: הקו האדום העליון והתחתון</title><g class="kn-wave back"><path d="${wave(3)}"/></g><g class="kn-wave"><path d="${wave(2.5)}"/></g>
      ${line(UPPER)}${line(LOWER)}` });
}

function graph(points, days) {
  const W = 300, H = 90, P = 4;
  const vs = points.map(p => p.v);
  let lo = Math.min(...vs, LOWER) - 0.05, hi = Math.max(...vs) + 0.05;
  if (UPPER - hi < 1) hi = Math.max(hi, UPPER + 0.05); // show the upper line only when the lake is near it
  const t0 = day(points[0].t), t1 = day(points.at(-1).t) || t0 + 1;
  const x = t => (W - P - ((day(t) - t0) / ((t1 - t0) || 1)) * (W - 2 * P)).toFixed(1); // RTL: newest on the left
  const y = v => (H - P - ((v - lo) / (hi - lo)) * (H - 2 * P)).toFixed(1);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)} ${y(p.v)}`).join('');
  const red = v => v >= lo && v <= hi ? `<line class="kn-red" x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>` : '';
  return h('svg', { class: 'kn-graph', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', width: '100%', height: H,
    html: `<title>${days === 30 ? '30 יום' : 'שנה'}: ${lvl(Math.min(...vs))} עד ${lvl(Math.max(...vs))}</title>${red(UPPER)}${red(LOWER)}
      <path d="${path} L${x(points.at(-1).t)} ${H} L${x(points[0].t)} ${H} Z" class="kn-area"/><path d="${path}" class="kn-line"/>` });
}

/** A small 30-day line for the card (currentColor = the accent). RTL: newest on the left. */
function spark(points) {
  if (points.length < 2) return null;
  const W = 64, H = 22, vs = points.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const xy = vs.map((v, i) => `${(W - (i / (vs.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - lo) / ((hi - lo) || 1)) * (H - 4)).toFixed(1)}`);
  return h('svg', { class: 'kn-spark', viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': true,
    html: `<polyline points="${xy.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>` });
}

function view(series, ctx) {
  const st = stats(series);
  if (!st) return [h('div', { class: 'sub' }, 'אין נתונים.')];
  const open = () => details(series, ctx);
  return [
    h('button', { class: 'kn-head', title: 'גרף ופירוט', onclick: open },
      h('div', {}, h('span', { class: 'big num' }, lvl(st.last.v)), h('span', { class: 'sub' }, ' מ׳'),
        h('div', { class: 'faint kn-when' }, 'נמדד ב-' + dm(st.last.t))),
      spark(range(series, 30))),
    st.change != null ? h('div', { class: 'row' }, h('span', {}, 'שינוי מ-' + dm(st.prev.t)), h('b', { class: dir(st.change) }, cm(st.change))) : null,
    h('div', { class: 'row' }, h('span', {}, st.toLower < 0 ? 'מתחת לקו האדום' : 'מעל הקו האדום'), h('b', { class: st.toLower < 0 ? 'down' : '' }, lowerDist(st.toLower))),
    st.lastYear ? h('div', { class: 'row', title: 'נמדד ב-' + dmy(st.lastYear.t) }, h('span', {}, 'לעומת שנה שעברה'), h('b', { class: dir(st.vsLastYear) }, cm(st.vsLastYear))) : null,
    h('button', { class: 'more', onclick: open }, 'גרף ופירוט'),
  ];
}

/** The layer: the lake, the graph (30 days / a year), the red lines and last year. */
function details(series, ctx) {
  const st = stats(series);
  openLayer(body => {
    const box = h('div', {});
    const chips = h('div', { class: 'chips kn-tabs' });
    const draw = () => {
      const k = ctx.s.range === 'year' ? 'year' : '30', days = k === 'year' ? 365 : 30;
      chips.replaceChildren(...[['30', '30 יום'], ['year', 'שנה']].map(([v, l]) => h('button', { class: 'chip' + (k === v ? ' on' : ''), onclick: () => { ctx.set({ range: v }); draw(); } }, l)));
      const h0 = box.offsetHeight;
      box.replaceChildren(graph(range(series, days), days));
      growFrom(box, h0);
    };
    draw();
    body.append(h('h2', {}, 'מפלס הכנרת'), lake(st.last.v),
      h('div', { class: 'row' }, h('span', {}, 'מפלס, ' + dmy(st.last.t)), h('b', {}, unit(lvl(st.last.v), 'מ׳'))),
      st.change != null ? h('div', { class: 'row' }, h('span', {}, 'שינוי מ-' + dm(st.prev.t)), h('b', { class: dir(st.change) }, cm(st.change))) : null,
      h('div', { class: 'row' }, h('span', {}, 'עד הקו האדום העליון'), h('b', {}, meters(st.toUpper))),
      h('div', { class: 'row' }, h('span', {}, st.toLower < 0 ? 'מתחת לקו האדום התחתון' : 'מעל הקו האדום התחתון'), h('b', { class: st.toLower < 0 ? 'down' : '' }, lowerDist(st.toLower))),
      st.lastYear ? h('div', { class: 'row' }, h('span', {}, 'לפני שנה, ' + dmy(st.lastYear.t)), h('b', {}, unit(lvl(st.lastYear.v), 'מ׳'))) : null,
      st.lastYear ? h('div', { class: 'row' }, h('span', {}, 'לעומת שנה שעברה'), h('b', { class: dir(st.vsLastYear) }, cm(st.vsLastYear))) : null,
      h('hr', { class: 'sep' }), chips, box,
      h('div', { class: 'faint kn-note' }, 'הקווים המקווקווים: הקו האדום העליון והתחתון. המקור: רשות המים.'));
  });
}

const DEFAULTS = { range: '30', refreshMin: 360 };

export default {
  id: 'kinneret',
  title: 'מפלס הכנרת',
  size: [1, 4],
  defaults: DEFAULTS,
  every: ctx => Math.max(60, +ctx.s.refreshMin || 360) * 60_000,
  css: `
.kn-head { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; padding: 0 0 4px; text-align: start; cursor: pointer; }
.kn-when { font-size: 12px; }
.kn-spark { margin-inline-start: auto; flex: none; color: var(--accent); }
.kn-lake { display: block; border-radius: var(--radius-s); background: var(--fill); margin-bottom: 8px; }
.kn-wave path { fill: var(--accent); opacity: .45; }
.kn-wave.back path { opacity: .25; }
.kn-wave { animation: kn-wave 7s linear infinite; }
.kn-wave.back { animation-duration: 11s; animation-direction: reverse; }
@keyframes kn-wave { from { transform: translateX(0); } to { transform: translateX(150px); } }
.kn-red { stroke: var(--bad); stroke-width: 1; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
.kn-tabs { margin-bottom: 8px; }
.kn-graph { display: block; }
.kn-line { fill: none; stroke: var(--accent); stroke-width: 1.3; vector-effect: non-scaling-stroke; }
.kn-area { fill: var(--accent); opacity: .12; }
.kn-note { font-size: 11px; padding-top: 6px; }
`,
  async render(el, ctx) {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch {}
    // The source changes about once a day: a tab switch re-renders from the cache.
    if (!c || Date.now() - c.at > 30 * 60_000) {
      try {
        const series = parse(await proxied(URL_, { headers: [BROWSER_UA] }));
        if (!series.length) throw new Error('kinneret: empty');
        c = { at: Date.now(), series };
        try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch {}
        ctx.stale(new Date(c.at), false);
      } catch (e) {
        log('kinneret: ' + e.message);
        ctx.stale(c ? new Date(c.at) : null, true);
        if (!c) { el.replaceChildren(h('div', { class: 'sub' }, 'אין חיבור למקור הנתונים.')); return; }
      }
    }
    el.replaceChildren(...view(c.series, ctx));
  },
  // The graph's range is chosen in the open card (30 יום / שנה); here only how often to check.
  settings(box, ctx) {
    box.append(row('בדיקת מפלס חדש', choice([[60, 'כל שעה'], [180, '3 שעות'], [360, '6 שעות'], [720, '12 שעות']], +ctx.s.refreshMin, v => ctx.set({ refreshMin: v })),
      'המפלס מתעדכן פעם ביום'));
  },
};
