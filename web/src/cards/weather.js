// "מזג אוויר": Open-Meteo for now, hours, wind and air; in Israel the IMS city forecast wins for the daily max/min
// (SPEC: "בארץ IMS גובר לתחזית הימים"). Outside Israel Open-Meteo only. Units fixed: °C, km/h.
// alerts(data, s) computes the user's chosen alerts; the owner wires them to notify().
import { h, proxied, BROWSER_UA, settings, log, openLayer, noPlace } from '../core.js';
import { icon, wmo, imsCode, iconCss } from './weather-icons.js';
import { row, toggle, number, choice, section, more } from '../ui.js';

// A switch whose grey hint sits under its label (not between the label and the switch).
const sw = (label, value, on, hint, deps) => toggle(hint ? h('span', {}, label, h('span', { class: 'hint' }, hint)) : label, value, on, '', deps);

const IMS_CITIES = 'https://ims.gov.il/sites/default/files/ims_data/xml_files/isr_cities.xml';
const IMS_ALERTS = 'https://ims.gov.il/sites/default/files/ims_data/rss/alert/rssAlert_general_country_he.xml';
const CACHE = 'haluach.c.weather';

// ---------- pure parsing ----------
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)); return m ? m[1].trim() : ''; };
const unent = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = s => unent(unent(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** isr_cities.xml (already decoded text) -> [{ id, name, lat, lng, days: { 'YYYY-MM-DD': { max, min, code, wind } } }]. */
export function parseImsCities(xml) {
  return [...xml.matchAll(/<Location>([\s\S]*?)<\/Location>/g)].map(([, loc]) => {
    const days = {};
    for (const [, tu] of loc.matchAll(/<TimeUnitData>([\s\S]*?)<\/TimeUnitData>/g)) {
      const d = {};
      for (const [, el] of tu.matchAll(/<Element>([\s\S]*?)<\/Element>/g)) d[tag(el, 'ElementName')] = tag(el, 'ElementValue');
      days[tag(tu, 'Date')] = {
        max: d['Maximum temperature'] != null ? +d['Maximum temperature'] : null,
        min: d['Minimum temperature'] != null ? +d['Minimum temperature'] : null,
        code: d['Weather code'] ? +d['Weather code'] : null,
        wind: d['Wind direction and speed'] || null,
      };
    }
    return { id: tag(loc, 'LocationId'), name: tag(loc, 'LocationNameHeb'), lat: +tag(loc, 'DisplayLat'), lng: +tag(loc, 'DisplayLon'), days };
  });
}

/** The IMS warnings RSS -> [{ id, title, body, at }]. Empty when there are no warnings. */
export function parseImsAlerts(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    id: strip(tag(it, 'guid')) || strip(tag(it, 'link')) + strip(tag(it, 'pubDate')),
    title: strip(tag(it, 'title')),
    body: strip(tag(it, 'description')),
    at: strip(tag(it, 'pubDate')),
  }));
}

function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
export function nearestCity(cities, loc) {
  let best = null, d = Infinity;
  for (const c of cities) { const k = km(c, loc); if (k < d) { d = k; best = c; } }
  return best && { ...best, km: Math.round(d) };
}

/** Local "YYYY-MM-DDTHH:MM" + minutes, as the same kind of string (no time zone math: the strings are already local). */
const plus = (t, min) => new Date(Date.parse(t + 'Z') + min * 60_000).toISOString().slice(0, 16);

/** The card's model from the raw answers: { now, hours[], days[], air, warnings[], city, il }. */
export function model({ om, aq, cities, warnings }, loc) {
  const c = om.current, cur = c.time;
  const H = om.hourly, D = om.daily;
  const start = H.time.findIndex(t => t >= cur.slice(0, 13) + ':00');
  const hours = [];
  for (let i = Math.max(0, start); i < H.time.length && hours.length < 24; i++) {
    hours.push({ t: H.time[i], temp: H.temperature_2m[i], code: H.weather_code[i], rain: H.precipitation_probability?.[i] ?? null, day: H.is_day?.[i] !== 0 });
  }
  const city = loc?.il && cities?.length ? nearestCity(cities, loc) : null;
  const days = D.time.map((t, i) => {
    const ims = city?.days[t];
    const omDay = { t, max: D.temperature_2m_max[i], min: D.temperature_2m_min[i], code: D.weather_code[i], rain: D.precipitation_probability_max?.[i] ?? null, uv: D.uv_index_max?.[i] ?? null, src: 'om' };
    if (ims && ims.max != null && ims.min != null) return { ...omDay, max: ims.max, min: ims.min, ims: ims.code, src: 'ims' };
    return omDay;
  });
  // Rain in the next hour: the 15-minute precipitation after "now", up to an hour.
  const M = om.minutely_15;
  let rainNext = 0;
  if (M) for (let i = 0; i < M.time.length; i++) if (M.time[i] > cur && M.time[i] <= plus(cur, 60)) rainNext += M.precipitation[i] || 0;
  return {
    now: { t: cur, temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, code: c.weather_code, day: c.is_day !== 0, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, dir: c.wind_direction_10m, uv: c.uv_index, rainNext: Math.round(rainNext * 10) / 10 },
    hours, days, city, il: !!loc?.il,
    air: aq?.current ? { aqi: aq.current.us_aqi, pm10: aq.current.pm10, pm25: aq.current.pm2_5, dust: aq.current.dust } : null,
    warnings: warnings || [],
  };
}

/** The alerts the user turned on, from the card's data. [{ id, title, body }]; id is stable, for de-duplication. */
export function alerts(data, s = DEFAULTS) {
  if (!data?.om) return [];
  const m = model(data, data.loc || settings().loc);
  const a = { ...DEFAULTS.alerts, ...(s.alerts || {}) }, out = [];
  const place = data.loc?.name || '';
  if (a.rain && m.now.rainNext >= a.rainMm) {
    out.push({ id: 'weather-rain-' + m.now.t.slice(0, 13), title: 'גשם בשעה הקרובה', body: `צפויים ${m.now.rainNext} מ"מ${place ? ' ב' + place : ''}.` });
  }
  if (a.ims && m.il) for (const w of m.warnings) out.push({ id: 'weather-ims-' + w.id, title: w.title || 'אזהרת השירות המטאורולוגי', body: w.body });
  if (a.air && m.air) {
    const bad = m.air.aqi >= a.aqi, dusty = m.air.dust != null && m.air.dust >= a.dust;
    if (bad || dusty) {
      out.push({ id: 'weather-air-' + m.now.t.slice(0, 10), title: dusty ? 'אובך ואבק' : 'איכות אוויר ירודה',
        body: `מדד איכות אוויר ${m.air.aqi} (${aqiText(m.air.aqi)})${m.air.dust != null ? `, אבק ${Math.round(m.air.dust)} מק"ג/מ"ק` : ''}.` });
    }
  }
  return out;
}

export function aqiText(v) {
  if (v == null) return '';
  return v <= 50 ? 'טובה' : v <= 100 ? 'סבירה' : v <= 150 ? 'לא בריאה לרגישים' : v <= 200 ? 'לא בריאה' : 'מסוכנת';
}
const DIRS = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
export const dirText = deg => DIRS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dayName = (t, today) => t === today ? 'היום' : t === plus(today + 'T00:00', 1440).slice(0, 10) ? 'מחר' : DAYS[new Date(t + 'T12:00Z').getUTCDay()];
const deg = v => v == null ? '-' : Math.round(v) + '°';

// ---------- fetching ----------
async function fetchAll(loc) {
  const q = `latitude=${loc.lat}&longitude=${loc.lng}&timezone=auto`;
  const om = proxied(`https://api.open-meteo.com/v1/forecast?${q}&forecast_days=7&wind_speed_unit=kmh`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index'
    + '&minutely_15=precipitation&hourly=temperature_2m,weather_code,precipitation_probability,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max');
  const aq = proxied(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,pm10,pm2_5,dust`);
  const ims = loc.il ? proxied(IMS_CITIES, { headers: [BROWSER_UA], as: 'buffer' }).then(b => parseImsCities(new TextDecoder('iso-8859-8').decode(b))) : null;
  const warn = loc.il ? proxied(IMS_ALERTS, { headers: [BROWSER_UA], as: 'text' }).then(parseImsAlerts) : null;
  const [r1, r2, r3, r4] = await Promise.allSettled([om, aq, ims, warn]);
  if (r1.status !== 'fulfilled') throw r1.reason;
  for (const r of [r2, r3, r4]) if (r.status === 'rejected') log('weather: ' + r.reason?.message);
  return { om: r1.value, aq: r2.value ?? null, cities: r3.value ?? null, warnings: r4.value ?? null, loc };
}
const locKey = l => `${l.lat},${l.lng}`;
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch { return null; } }
/** The last good data (for the owner's alert loop): { om, aq, cities, warnings, loc } or null. */
export function lastData() { return readCache()?.data || null; }

// ---------- the card ----------
const DEFAULTS = {
  parts: { now: true, details: true, hourly: true, daily: true, warn: true },
  hours: 12,
  days: 7,
  refreshMin: 30,
  alerts: { rain: false, rainMm: 0.2, ims: false, air: false, aqi: 101, dust: 150 },
};

const num = (v, unit = '') => h('span', {}, h('span', { class: 'num' }, v), unit ? ' ' + unit : '');
const WARN = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M8 2 1.5 13.5h13z"/><path d="M8 6.5v3.5M8 11.6v.4"/></svg>';
// The wind arrow points where the wind blows to (the direction is where it comes from).
const arrow = dir => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" style="transform: rotate(${(dir ?? 0) + 180}deg)" aria-hidden="true"><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5"/></svg>`;

/** The card: warnings (one line), now, five next hours. Everything else in the layer. */
function view(m, s) {
  const p = { ...DEFAULTS.parts, ...(s.parts || {}) };
  const out = [];
  const open = () => layer(m, s);
  if (p.warn && m.il && m.warnings.length) {
    const w = m.warnings[0];
    out.push(h('button', { class: 'item wx-warn down', title: w.body, onclick: open },
      h('span', { html: WARN }), h('span', { class: 'val' }, w.title || 'אזהרה'),
      m.warnings.length > 1 ? h('span', { class: 'end faint num' }, '+' + (m.warnings.length - 1)) : null));
  }
  if (p.now) {
    const [kind, text] = wmo(m.now.code);
    const d0 = m.days[0];
    out.push(h('button', { class: 'wx-now', onclick: open, title: 'פירוט' },
      h('span', { html: icon(kind, !m.now.day, 44) }),
      h('div', {},
        h('div', { class: 'wx-temp' }, h('span', { class: 'big num' }, deg(m.now.temp)), m.now.feels != null && Math.round(m.now.feels) !== Math.round(m.now.temp) ? h('span', { class: 'sub wx-feels' }, 'מרגיש כמו ', h('span', { class: 'num' }, deg(m.now.feels))) : ''),
        h('div', { class: 'sub wx-desc' }, text, d0 ? [text ? ' · ' : '', h('span', { class: 'num', title: d0.src === 'ims' ? 'השירות המטאורולוגי' : 'תחזית עולמית' }, `${deg(d0.max)}/${deg(d0.min)}`)] : null))));
  }
  if (p.hourly) {
    // Five points across the hours the user chose (12 hours = every 2 hours).
    const step = Math.max(1, Math.round((s.hours || 12) / 5));
    const pts = [1, 2, 3, 4, 5].map(k => m.hours[k * step]).filter(Boolean);
    const rain = pts.some(x => x.rain >= 20);
    if (pts.length) out.push(h('div', { class: 'wx-hours' }, ...pts.map(x => h('div', { title: wmo(x.code)[1] },
      h('span', { class: 'num' }, x.t.slice(11, 16)),
      h('span', { html: icon(wmo(x.code)[0], !x.day, 22) }),
      h('b', { class: 'num' }, deg(x.temp)),
      rain ? h('span', { class: 'faint num' }, x.rain >= 20 ? x.rain + '%' : '') : null))));
  }
  if (p.details || p.daily || p.hourly) out.push(h('button', { class: 'more', onclick: open }, p.daily ? 'תחזית לימים' : 'פירוט'));
  return out;
}

/** The layer: warnings in full, details, every hour, the days. */
function layer(m, s) {
  const p = { ...DEFAULTS.parts, ...(s.parts || {}) };
  const today = m.now.t.slice(0, 10);
  const place = settings().loc?.name;
  openLayer(body => {
    body.append(h('h2', {}, 'מזג אוויר' + (place ? ' ב' + place : '')));
    if (m.il && m.warnings.length) for (const w of m.warnings) body.append(h('div', { class: 'item' }, h('span', { class: 'down', html: WARN }), h('div', {}, h('div', { class: 'val down' }, w.title), h('div', { class: 'sub' }, w.body))));
    if (p.details) {
      const n = m.now;
      const row = (k, v, title) => h('div', { class: 'row', title: title || '' }, h('span', {}, k), h('b', {}, v));
      body.append(...[
        row('מרגיש כמו', num(deg(n.feels))),
        n.wind != null ? row('רוח', h('span', { class: 'wx-wind-v' }, h('span', { html: arrow(n.dir) }), num(Math.round(n.wind), 'קמ״ש'), ' ' + dirText(n.dir ?? 0))) : null,
        n.gust ? row('משבים', num(Math.round(n.gust), 'קמ״ש')) : null,
        row('לחות', num(Math.round(n.hum) + '%')),
        n.uv != null ? row('קרינת שמש (UV)', num(Math.round(n.uv))) : null,
        n.rainNext > 0 ? row('גשם בשעה הקרובה', num(n.rainNext, 'מ״מ')) : null,
        m.air ? row('איכות אוויר', [num(m.air.aqi), ' ' + aqiText(m.air.aqi)]) : null,
        m.air?.dust != null ? row('אבק', num(Math.round(m.air.dust), 'מק״ג/מ״ק')) : null,
        h('hr', { class: 'sep' }),
      ].filter(Boolean));
    }
    if (p.hourly) {
      body.append(h('div', { class: 'wx-hours wrap' }, ...m.hours.slice(0, s.hours || 12).map((x, i) => h('div', { title: wmo(x.code)[1] },
        h('span', { class: 'num' }, i === 0 ? 'עכשיו' : x.t.slice(11, 16)),
        h('span', { html: icon(wmo(x.code)[0], !x.day, 22) }),
        h('b', { class: 'num' }, deg(x.temp)),
        h('span', { class: 'faint num' }, x.rain >= 20 ? x.rain + '%' : '')))), h('hr', { class: 'sep' }));
    }
    if (p.daily) {
      for (const d of m.days.slice(0, s.days || 7)) {
        const [kind, text] = (d.ims && imsCode(d.ims)) || wmo(d.code);
        body.append(h('div', { class: 'row wx-day', title: text + (d.src === 'ims' ? ' (השירות המטאורולוגי)' : '') },
          h('span', {}, dayName(d.t, today)),
          h('span', { html: icon(kind, false, 22) }),
          h('span', { class: 'faint num' }, d.rain >= 20 ? d.rain + '%' : ''),
          h('span', { class: 'num' }, h('b', {}, deg(d.max)), ' ', h('span', { class: 'sub' }, deg(d.min)))));
      }
    }
    if (m.city) body.append(h('div', { class: 'faint wx-src' }, `תחזית הימים: השירות המטאורולוגי, ${m.city.name}`));
  });
}

export default {
  id: 'weather',
  needsLoc: true,
  title: 'מזג אוויר',
  size: [2, 4],
  defaults: DEFAULTS,
  every: ctx => Math.max(10, +ctx.s.refreshMin || 30) * 60_000,
  css: iconCss + `
.wx-temp { display: flex; align-items: baseline; gap: 8px; }
.wx-feels { font-size: 12px; }
.wx-now { display: flex; align-items: center; gap: 10px; width: 100%; background: none; border: 0; padding: 0; text-align: start; cursor: pointer; }
.wx-desc { font-size: 13px; }
.wx-warn { width: 100%; background: none; border: 0; padding: 0 0 6px; text-align: start; cursor: pointer; }
.wx-warn .val { color: inherit; white-space: nowrap; }
.wx-hours { display: grid; grid-template-columns: repeat(5, 1fr); margin-top: 10px; font-size: 12px; text-align: center; color: var(--fg2); }
.wx-hours > div { display: grid; justify-items: center; gap: 1px; min-width: 0; }
.wx-hours b { color: var(--fg); font-size: 13px; font-weight: 600; }
.wx-hours.wrap { grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); row-gap: 8px; margin-top: 0; }
.wx-day { display: grid; grid-template-columns: 1fr 22px 40px 64px; align-items: center; }
.wx-day > :last-child { text-align: end; }
.wx-wind-v { display: inline-flex; align-items: center; gap: 4px; }
.wx-src { font-size: 11px; padding-top: 6px; }
`,
  async render(el, ctx) {
    const loc = settings().loc;
    if (!loc) { el.replaceChildren(noPlace()); return; }
    let c = readCache();
    if (c && c.key !== locKey(loc)) c = null;
    try {
      const data = await fetchAll(loc);
      c = { at: Date.now(), key: locKey(loc), data };
      try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch {}
      ctx.stale(new Date(c.at), false);
    } catch (e) {
      log('weather: ' + e.message);
      ctx.stale(c ? new Date(c.at) : null, true);
      if (!c) { el.replaceChildren(h('div', { class: 'sub' }, 'אין חיבור למקור מזג האוויר.')); return; }
    }
    el.replaceChildren(...view(model(c.data, loc), ctx.s));
  },
  // From the card's cache; fetches only when the card is hidden and the cache is older than the refresh interval.
  // The compact card: the summary, and on its left the current conditions as a moving picture.
  async compact(ctx) {
    const w = await this.widget(ctx);
    try {
      const loc = settings().loc, c = readCache();
      if (loc && c?.key === locKey(loc)) { const n = model(c.data, loc).now; w.art = icon(wmo(n.code)[0], !n.day, 56); }
    } catch {}
    return w;
  },
  async widget(ctx) {
    try {
      const loc = settings().loc;
      if (!loc) return { big: '', sub: 'בחרו מיקום בלוח', rows: [] };
      let c = readCache();
      if (c && c.key !== locKey(loc)) c = null;
      const maxAge = Math.max(10, +ctx?.s?.refreshMin || 30) * 60_000;
      if (!c || Date.now() - c.at > maxAge) {
        try {
          c = { at: Date.now(), key: locKey(loc), data: await fetchAll(loc) };
          try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch {}
        } catch (e) { log('weather widget: ' + e.message); }
      }
      if (!c) return { big: '', sub: 'אין נתוני מזג אוויר', rows: [] };
      const m = model(c.data, loc), n = m.now, d0 = m.days[0];
      const rows = [];
      if (d0) rows.push(['היום', `${deg(d0.max)} / ${deg(d0.min)}`, true]);
      for (const i of [3, 6, 9, 12]) { const x = m.hours[i]; if (x) rows.push([x.t.slice(11, 16), deg(x.temp) + (x.rain >= 20 ? ` · ${x.rain}%` : '')]); }
      if (d0?.rain != null) rows.push(['סיכוי לגשם', d0.rain + '%' + (n.rainNext > 0 ? ` (${n.rainNext} מ"מ בשעה)` : '')]);
      if (n.wind != null) rows.push(['רוח', `${Math.round(n.wind)} קמ"ש ${dirText(n.dir ?? 0)}`]);
      if (m.air?.aqi != null) rows.push(['איכות אוויר', `${m.air.aqi} (${aqiText(m.air.aqi)})`]);
      if (m.il) for (const w of m.warnings.slice(0, 1)) rows.push(['אזהרה', w.title, true]);
      return { big: deg(n.temp), sub: `${wmo(n.code)[1]} · ${loc.name || ''}`.replace(/ · $/, ''), rows };
    } catch { return { big: '', sub: 'אין נתוני מזג אוויר', rows: [] }; }
  },
  settings(box, ctx) {
    const s = ctx.s;
    const parts = { ...DEFAULTS.parts, ...(s.parts || {}) };
    const al = { ...DEFAULTS.alerts, ...(s.alerts || {}) };
    const put = (patch, redraw = true) => { ctx.set(patch); if (redraw) ctx.rerender(); };
    const part = (k, label, deps = []) => sw(label, parts[k], v => { parts[k] = v; put({ parts: { ...parts } }); }, '', deps);
    const alert = (k, label, hint, deps = []) => sw(label, al[k], v => { al[k] = v; put({ alerts: { ...al } }, false); }, hint, deps);
    const alNum = (k, unit, o) => number(al[k], unit, v => { al[k] = v || DEFAULTS.alerts[k]; put({ alerts: { ...al } }, false); }, o);
    box.append(
      section('מה מופיע'),
      ...part('now', 'עכשיו ומרגיש כמו'),
      ...part('details', 'רוח, לחות ואוויר'),
      ...part('hourly', 'לפי שעות', [row('כמה שעות קדימה', number(s.hours, 'שעות', v => put({ hours: v || 12 }), { min: 3, max: 24 }))]),
      ...part('daily', 'לפי ימים', [row('כמה ימים', number(s.days, 'ימים', v => put({ days: v || 7 }), { min: 2, max: 7 }))]),
      ...part('warn', 'אזהרות (בארץ)'),
      section('התראות'),
      ...alert('rain', 'גשם בשעה הקרובה', '', [row('מכמה גשם', alNum('rainMm', 'מ״מ', { min: 0.1, max: 50, step: 0.1 }))]),
      ...alert('ims', 'אזהרות מזג אוויר', 'מהשירות המטאורולוגי, בארץ'),
      ...alert('air', 'אוויר מזוהם ואבק', '', [
        row('ממדד זיהום', alNum('aqi', '', { min: 1, max: 500 }), '100 ומעלה: לא בריא לרגישים'),
        row('מכמות אבק', alNum('dust', 'מק״ג/מ״ק', { min: 1, max: 5000 }))]),
      more(row('רענון', choice([[15, '15 דק׳'], [30, '30 דק׳'], [60, 'שעה'], [120, 'שעתיים']], +s.refreshMin, v => put({ refreshMin: v }, false)))),
    );
  },
};
