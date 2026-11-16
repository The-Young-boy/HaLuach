// "תחבורה ציבורית": buses in real time by stop code (curlbus.app, SIRI), nearby stops (Hasadna Stride),
// a saved rail route (Israel Railways API, Transitous when it fails), disruptions, and route planning (Transitous).
import { h, hm, proxied, settings, cardSettings, openLayer, openExternal, log, notify, noPlace, liveDrag, growFrom, whileVisible } from '../core.js';
import { search as placeSearch } from '../location.js';
import { row, number, section, choice, more, debounce } from '../ui.js';

// The public subscription key that rail.co.il ships in its own website JS. better-rail's app uses the same key
// (apps/mobile/src/config/api-config.ts, RAIL_WEBSITE_API). If Israel Railways changes it, change it here only.
const RAIL_KEY = '5e64d66cf03f4547bcac5de2de06b566';
const RAIL = 'https://rail-api.rail.co.il';
const RAIL_HEADERS = ['Ocp-Apim-Subscription-Key: ' + RAIL_KEY, 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach', 'Accept: application/json'];
const TRANSITOUS = 'https://api.transitous.org/api/v1/plan';
const STRIDE = 'https://open-bus-stride-api.hasadna.org.il';
const IL = 'Asia/Jerusalem';

// ---------- time (the rail API answers Israel local time without an offset) ----------
function tzOffset(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60000;
}
/** "2026-11-15T08:20:00" (Israel time) -> Date. */
export function ilParse(s) {
  const [y, m, d, H = 0, M = 0, S = 0] = String(s).match(/\d+/g).map(Number);
  const guess = Date.UTC(y, m - 1, d, H, M, S);
  return new Date(guess - tzOffset(IL, new Date(guess)) * 60000);
}
function ilNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: IL, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: `${p.hour}:${p.minute}` };
}
const mins = (t, now = Date.now()) => Math.round((t - now) / 60000);
const inMin = m => m <= 0 ? 'עכשיו' : m === 1 ? 'דקה' : `${m} דק'`;

// ---------- cache (the last good answer, shown when a source fails) ----------
const CK = 'haluach.transit.';
const keep = (k, v) => { try { localStorage.setItem(CK + k, JSON.stringify({ at: Date.now(), v })); } catch {} };
const kept = k => { try { return JSON.parse(localStorage.getItem(CK + k)); } catch { return null; } };

// ---------- buses: curlbus.app ----------
/** curlbus JSON -> [{ line, dest, operator, eta (ms), vehicle }] sorted by eta, and the stop's name. */
export function parseCurlbus(d, code) {
  const visits = d?.visits?.[code] || d?.visits?.[String(code)] || [];
  const list = visits.map(v => ({
    line: v.line_name,
    dest: v.static_info?.route?.destination?.name?.HE || '',
    operator: v.static_info?.route?.agency?.name?.HE || '',
    eta: Date.parse(String(v.eta).replace(' ', 'T')),
    vehicle: v.vehicle_ref || '',
  })).filter(v => v.line && !isNaN(v.eta)).sort((a, b) => a.eta - b.eta);
  return { name: d?.stop_info?.name?.HE || '', city: d?.stop_info?.address?.city_multilingual?.HE || '', list };
}
// ---------- planned times: Hasadna Stride GTFS (curlbus has no real time for light-rail stops) ----------
const LR_AGENCY = /תבל|כפיר/;
const COLOURS = ['אדום', 'ירוק', 'סגול', 'כחול', 'צהוב', 'כתום', 'חום', 'ורוד'];
/** "A-city<->B-city-10" -> "B". */
const gtfsDest = n => { const b = String(n || '').split('<->').pop().replace(/-\d+$/, ''); const i = b.lastIndexOf('-'); return (i > 0 ? b.slice(0, i) : b).trim(); };
/** Stride gtfs_ride_stops rows -> the curlbus list shape, planned: true. */
export function parseStride(rows) {
  const seen = new Set();
  return (rows || []).filter(r => !seen.has(r.gtfs_ride_id) && seen.add(r.gtfs_ride_id)).map(r => {
    const short = r.gtfs_route__route_short_name || '', long = r.gtfs_route__route_long_name || '', agency = r.gtfs_route__agency_name || '';
    const lr = String(r.gtfs_route__route_type) === '0' || LR_AGENCY.test(agency);
    const colour = lr && COLOURS.find(c => short.includes(c) || long.includes(c));
    return { line: short, label: lr ? 'רכבת קלה' + (colour ? ' · ' + colour : '') : '', dest: gtfsDest(long), operator: agency,
      eta: Date.parse(r.arrival_time || r.departure_time), vehicle: '', planned: true };
  }).filter(v => v.line && !isNaN(v.eta)).sort((a, b) => a.eta - b.eta);
}
/** The next 90 minutes at a stop from the planned timetable: { name, city, list }. The stop ids are kept per code
 * and per date (Stride gives a stop other gtfs ids on other dates). */
async function planned(code) {
  const date = ilNow().date;
  let st = kept('gtfs.' + code)?.v;
  if (!st?.ids?.length || st.date !== date) {
    const rows = await proxied(`${STRIDE}/gtfs_stops/list?code=${encodeURIComponent(code)}&date_from=${date}&date_to=${date}`);
    st = { date, ids: [...new Set((rows || []).map(r => r.id))], name: rows?.[0]?.name || '', city: rows?.[0]?.city || '' };
    if (!st.ids.length) throw new Error('no gtfs stop');
    keep('gtfs.' + code, st);
  }
  const from = new Date(Date.now() - 60000).toISOString(), to = new Date(Date.now() + 90 * 60000).toISOString();
  const rows = await proxied(`${STRIDE}/gtfs_ride_stops/list?gtfs_stop_ids=${st.ids.join(',')}&arrival_time_from=${encodeURIComponent(from)}&arrival_time_to=${encodeURIComponent(to)}&expand_related=true&limit=200`);
  return { name: st.name, city: st.city, list: parseStride(rows) };
}
/** curlbus, then the planned timetable when curlbus fails or has no visits. Throws when both fail. */
async function stopData(code) {
  let p = null, err = null;
  try { p = parseCurlbus(await proxied(`https://curlbus.app/${encodeURIComponent(code)}`, { headers: ['Accept: application/json'] }), code); } catch (e) { err = e; }
  if (!p?.list.length) {
    try { const q = await planned(code); if (q.list.length || !p) p = { ...q, name: p?.name || q.name, city: p?.city || q.city, planned: true }; }
    catch (e) { if (!p) throw err || e; }
  }
  keep('stop.' + code, p);
  return p;
}
/** The next buses at one stop: [{ line, dest, operator, eta: Date, minutes, vehicle, planned? }]. Throws when no source answers. */
export async function arrivals(stopCode) {
  const code = String(stopCode).trim();
  const p = await stopData(code);
  const now = Date.now();
  return p.list.map(v => ({ ...v, eta: new Date(v.eta), minutes: mins(v.eta, now) })).filter(v => v.minutes >= -1);
}
async function stopInfo(code) {
  try {
    const p = await stopData(code);
    return { ...p, ok: true, at: Date.now() };
  } catch (e) {
    const c = kept('stop.' + code);
    return { ...(c?.v || { name: '', list: [] }), ok: false, at: c?.at || 0 };
  }
}

// ---------- nearby stops: Hasadna Stride ----------
// gtfs_stops/list has no lat/lng filter. siri_ride_stops/list does (gtfs_stop__lat/lon bounds): one recent
// ride-stop per visit, so the stops are the distinct gtfs_stop__code values in the box. Slow (several seconds).
export function parseNearby(rows, lat, lng) {
  const m = new Map();
  for (const r of rows || []) {
    if (r.gtfs_stop__code == null || m.has(r.gtfs_stop__code)) continue;
    const dy = (r.gtfs_stop__lat - lat) * 111320, dx = (r.gtfs_stop__lon - lng) * 111320 * Math.cos(lat * Math.PI / 180);
    m.set(r.gtfs_stop__code, { code: String(r.gtfs_stop__code), name: r.gtfs_stop__name, city: r.gtfs_stop__city, dist: Math.round(Math.hypot(dx, dy)) });
  }
  return [...m.values()].sort((a, b) => a.dist - b.dist);
}
async function nearby(loc, box = 0.006) {
  const k = `near.${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;
  const c = kept(k);
  if (c && Date.now() - c.at < 7 * 864e5) return c.v;
  const q = `limit=500&gtfs_stop__lat__greater_or_equal=${loc.lat - box}&gtfs_stop__lat__lower_or_equal=${loc.lat + box}&gtfs_stop__lon__greater_or_equal=${loc.lng - box}&gtfs_stop__lon__lower_or_equal=${loc.lng + box}`;
  const list = parseNearby(await proxied(`${STRIDE}/siri_ride_stops/list?${q}`), loc.lat, loc.lng);
  keep(k, list);
  return list;
}

// ---------- rail: Israel Railways ----------
export async function railStations() {
  const c = kept('rail.stations');
  if (c && Date.now() - c.at < 7 * 864e5) return c.v;
  try {
    const d = await proxied(`${RAIL}/common/api/v1/stations?languageId=Hebrew&systemType=1`, { headers: RAIL_HEADERS });
    const list = (d.result || []).map(s => ({ id: String(s.stationId), name: s.stationName, lat: s.location?.latitude, lng: s.location?.lontitude ?? s.location?.longitude }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
    if (list.length) keep('rail.stations', list);
    return list;
  } catch (e) { log('rail stations: ' + e.message); return c?.v || []; }
}
/** searchTrainForMobile `result.travels` -> trips. */
export function parseRail(d) {
  return (d?.result?.travels || []).map(t => {
    const tr = t.trains || [];
    const f = tr[0] || {};
    const loads = tr.map(x => x.predictedPctLoad).filter(x => x != null);
    return {
      dep: ilParse(t.departureTime).getTime(), arr: ilParse(t.arrivalTime).getTime(),
      delay: f.trainPosition?.calcDiffMinutes ?? 0,
      platform: f.originPlatform ?? null, train: f.trainNumber ?? '',
      load: loads.length ? Math.max(...loads) : null,
      changes: Math.max(0, tr.length - 1),
      cancelled: tr.some(x => x.isCancelled),
      msgs: (t.travelMessages || []).map(m => m.title || m.message || m.text || '').filter(Boolean),
    };
  });
}
/** Transitous itineraries (rail only) -> the same trip shape. */
export function parseTransitousRail(d) {
  return (d?.itineraries || []).map(it => {
    const rides = it.legs.filter(l => l.mode !== 'WALK');
    const f = rides[0] || it.legs[0];
    return {
      dep: Date.parse(f.startTime), arr: Date.parse(rides.at(-1)?.endTime || it.endTime),
      delay: f.realTime ? Math.round((Date.parse(f.startTime) - Date.parse(f.scheduledStartTime)) / 60000) : 0,
      platform: f.from?.track || null, train: f.tripShortName || '', load: null,
      changes: Math.max(0, rides.length - 1), cancelled: rides.some(l => l.cancelled), msgs: [],
    };
  });
}
async function railTrips(route) {
  const { date, hour } = ilNow();
  const now = Date.now();
  const fresh = list => list.filter(t => t.dep + t.delay * 60000 >= now - 60000);
  try {
    const body = JSON.stringify({ methodName: 'searchTrainLuzForDateTime', fromStation: +route.from.id, toStation: +route.to.id, date, hour, systemType: '2', scheduleType: 'ByDeparture', languageId: 'Hebrew' });
    const d = await proxied(`${RAIL}/rjpa/api/v1/timetable/searchTrainForMobile`, { method: 'POST', body, type: 'application/json', headers: RAIL_HEADERS, cache: false });
    const trips = fresh(parseRail(d));
    if (!d?.result) throw new Error('no result');
    return { src: 'rail', trips };
  } catch (e) {
    log('rail api: ' + e.message);
    if (route.from.lat == null || route.to.lat == null) throw e;
    const d = await proxied(`${TRANSITOUS}?fromPlace=${route.from.lat},${route.from.lng}&toPlace=${route.to.lat},${route.to.lng}&transitModes=RAIL&numItineraries=5`);
    return { src: 'transitous', trips: fresh(parseTransitousRail(d)) };
  }
}
/** railupdates, the ones that name a station of the route first. */
async function railUpdates(ids = []) {
  try {
    const d = await proxied(`${RAIL}/common/api/v1/railupdates/?LanguageId=Hebrew&SystemType=1`, { headers: RAIL_HEADERS });
    const all = (d.result || []).map(u => ({ head: u.updateHeader, body: u.updateContent, link: u.updateLink, stations: (u.stations || []).map(String) }));
    keep('rail.updates', all);
    return all;
  } catch { return kept('rail.updates')?.v || []; }
}
const relevant = (u, ids) => u.stations.some(s => ids.includes(s));

// ---------- route planning: Transitous ----------
export function parsePlan(d) {
  return (d?.itineraries || []).map(it => ({
    start: Date.parse(it.startTime), end: Date.parse(it.endTime), transfers: it.transfers ?? 0,
    legs: it.legs.filter(l => !(l.mode === 'WALK' && l.duration < 60)).map(l => ({
      mode: l.mode, line: l.routeShortName || l.displayName || '', head: l.headsign || '',
      from: l.from?.name === 'START' ? '' : l.from?.name || '', to: l.to?.name === 'END' ? '' : l.to?.name || '',
      start: Date.parse(l.startTime), end: Date.parse(l.endTime), real: !!l.realTime, agency: l.agencyName || '', mins: Math.round((l.duration || 0) / 60),
    })),
  }));
}
const coords = s => { const m = String(s).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/); return m ? { name: `${m[1]}, ${m[2]}`, lat: +m[1], lng: +m[2] } : null; };

function placeField(label, initial) {
  let place = initial;
  const input = h('input', { type: 'search', placeholder: 'עיר או רחוב', value: initial?.name || '' });
  const res = h('div', { class: 'list' });
  let t = 0;
  input.addEventListener('input', () => {
    place = coords(input.value);
    clearTimeout(t);
    if (place || !input.value.trim()) { res.replaceChildren(); return; }
    t = setTimeout(async () => {
      const list = await placeSearch(input.value).catch(() => []);
      res.replaceChildren(...list.map(p => h('button', { onclick: () => { place = p; input.value = p.name; res.replaceChildren(); } }, p.name)));
    }, 350);
  });
  return { el: h('label', {}, label, input, res), get: () => place };
}
const X_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
// The ride's kind in words.
const MODE_NAME = { BUS: 'אוטובוס', COACH: 'אוטובוס', TRAM: 'רכבת קלה', SUBWAY: 'מטרו', METRO: 'מטרו', WALK: 'הליכה', FERRY: 'מעבורת', CABLE_CAR: 'רכבל' };
const modeName = m => MODE_NAME[m] || (/RAIL|SUBURBAN|LONG_DISTANCE/.test(m) ? 'רכבת' : '');
function planLayer() {
  openLayer(body => {
    const loc = settings().loc;
    const from = placeField('מוצא', loc ? { ...loc, name: 'המיקום שלי (' + loc.name + ')' } : null);
    const to = placeField('יעד', null);
    const when = h('input', { type: 'datetime-local' });
    const out = h('div', {});
    // A new content grows or shrinks the box, not a jump.
    const swap = (...kids) => { const h0 = out.offsetHeight; out.replaceChildren(...kids); growFrom(out, h0); };
    const go = async () => {
      const a = from.get(), b = to.get();
      if (!a || !b) { swap(h('div', { class: 'sub' }, 'בחרו מוצא ויעד מהרשימה.')); return; }
      swap(h('div', { class: 'sub' }, 'מחפש...'));
      let q = `${TRANSITOUS}?fromPlace=${a.lat},${a.lng}&toPlace=${b.lat},${b.lng}&numItineraries=5`;
      if (when.value) q += '&time=' + encodeURIComponent(new Date(when.value).toISOString());
      try {
        const its = parsePlan(await proxied(q));
        if (!its.length) { swap(h('div', { class: 'sub' }, 'לא נמצא מסלול.')); return; }
        swap(...its.map(it => h('details', {},
          h('summary', {}, h('b', { class: 'num' }, `${hm(new Date(it.start))} - ${hm(new Date(it.end))}`), ' ',
            h('span', { class: 'sub' }, `${Math.round((it.end - it.start) / 60000)} דק', ${it.transfers ? it.transfers + ' החלפות' : 'ישיר'}`),
            h('span', { class: 'faint' }, ' · ' + it.legs.filter(l => l.mode !== 'WALK').map(l => l.line || modeName(l.mode)).join(', '))),
          ...it.legs.map(l => h('div', { class: 'row' },
            h('span', {}, l.mode === 'WALK' ? `הליכה ${l.mins} דק'` + (l.to ? ' אל ' + l.to : '') : `${modeName(l.mode)} ${l.line}${l.head ? ' ל' + l.head : ''}: ${l.from} > ${l.to}`, l.agency ? h('span', { class: 'faint' }, ' (' + l.agency + ')') : ''),
            h('b', { class: 'num' + (l.real ? ' up' : ''), title: l.real ? 'זמן אמת' : 'לפי לוח הזמנים' }, hm(new Date(l.start))))),
          h('hr', { class: 'sep' }))));
      } catch (e) { swap(h('div', { class: 'sub' }, 'המקור לא ענה. נסו שוב.')); }
    };
    body.append(h('h2', {}, 'תכנון מסלול'), h('div', { class: 'form' }, from.el, to.el, h('label', {}, 'יציאה (ריק = עכשיו)', when),
      h('button', { class: 'btn primary', onclick: go }, 'חיפוש מסלול')), h('hr', { class: 'sep' }), out,
      h('div', { class: 'faint' }, 'זמן אמת בירוק.'));
  });
}

// ---------- layers ----------
function nearbyLayer(ctx) {
  openLayer(async body => {
    const loc = settings().loc;
    body.append(h('h2', {}, 'תחנות קרובות'));
    if (!loc) { body.append(noPlace()); return; }
    const list = h('div', {}, h('div', { class: 'sub' }, 'טוען תחנות (זה לוקח כמה שניות)...'));
    body.append(h('div', { class: 'sub' }, 'סביב ' + loc.name), list);
    try {
      const stops = (await nearby(loc)).slice(0, 15);
      if (!stops.length) { list.replaceChildren(h('div', { class: 'sub' }, 'לא נמצאו תחנות קרובות.')); return; }
      list.replaceChildren(...stops.map(st => {
        const more = h('div', {});
        const swap = (...kids) => { const h0 = more.offsetHeight; more.replaceChildren(...kids); growFrom(more, h0); };
        const saved = () => (ctx.s.stops || []).some(x => x.code === st.code);
        const save = h('button', { class: 'btn', disabled: saved(), onclick: () => { ctx.set({ stops: [...(ctx.s.stops || []), { code: st.code, name: st.name }] }); save.disabled = true; save.textContent = 'נוספה'; ctx.rerender(); } }, saved() ? 'נוספה' : 'הוספה');
        const times = async () => {
          swap(h('div', { class: 'sub' }, '...'));
          const a = await arrivals(st.code).catch(() => null);
          swap(...(a == null ? [h('div', { class: 'sub' }, 'המקור לא ענה.')] : a.length ? a.slice(0, 6).map(v => busRow(v, st.code, st.name)) : [h('div', { class: 'sub' }, 'אין אוטובוסים בקרוב.')]));
        };
        return h('div', {},
          h('div', { class: 'item' },
            h('div', {}, h('div', { class: 'val' }, st.name), h('div', { class: 'lab' }, h('span', { class: 'num' }, st.code), ' · ', h('span', { class: 'num' }, st.dist), ' מ׳')),
            h('span', { class: 'end chips' }, h('button', { class: 'chip', onclick: times }, 'זמנים'), save)),
          more, h('hr', { class: 'sep' }));
      }));
    } catch (e) { list.replaceChildren(h('div', { class: 'sub' }, 'המקור לא ענה. נסו שוב מאוחר יותר.')); }
  });
}
function updatesLayer(all, ids) {
  openLayer(body => {
    const rel = all.filter(u => relevant(u, ids)), rest = all.filter(u => !relevant(u, ids));
    body.append(h('h2', {}, 'הודעות רכבת ישראל'));
    for (const [title, list] of [['במסלול שלכם', rel], ['כלליות', rest]]) {
      if (!list.length) continue;
      body.append(h('div', { class: 'item' }, h('div', { class: 'val' }, title)), ...list.map(u => h('details', {}, h('summary', {}, u.head),
        h('div', { class: 'sub' }, String(u.body || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')),
        u.link ? h('button', { class: 'link', onclick: () => openExternal(u.link) }, 'לפרטים') : '')), h('hr', { class: 'sep' }));
    }
    if (!all.length) body.append(h('div', { class: 'sub' }, 'אין הודעות.'));
  });
}
/** The card's settings in the layer (the empty card's "הוספת תחנה"), as core.js draws them from the head. */
function settingsLayer(ctx) {
  openLayer((body, close) => {
    body.append(h('h2', {}, 'הגדרות: ' + card.title));
    const box = h('div', { class: 'form' });
    body.append(box);
    card.settings(box, Object.assign(Object.create(ctx), { done: () => { close(); ctx.rerender(); } }));
  });
}

// ---------- the card ----------
const minText = m => m <= 0 ? 'עכשיו' : m === 1 ? 'דקה' : h('span', {}, h('span', { class: 'num' }, m), " דק'");
// ---------- "the bus arrives in X minutes": a bell on a bus row watches that line at that stop, once ----------
// While the board runs (it keeps the page alive), every 30 seconds; a watch ends after the alert or after 2 hours.
const WK = 'haluach.transit.watch';
const watches = () => { try { return JSON.parse(localStorage.getItem(WK) || '[]').filter(w => w.until > Date.now()); } catch { return []; } };
const saveWatches = l => { try { localStorage.setItem(WK, JSON.stringify(l)); } catch {} };
const watching = (code, line) => watches().some(w => w.code === code && w.line === line);
let watchTimer = 0, checking = false;
async function checkWatches() {
  if (checking) return; // a slow round (the APIs) must not overlap the next one
  checking = true;
  try { await checkRound(); } finally { checking = false; }
}
async function checkRound() {
  const list = watches();
  if (!list.length) { clearInterval(watchTimer); watchTimer = 0; saveWatches([]); return; }
  const left = [];
  for (const code of [...new Set(list.map(w => w.code))]) {
    const a = await arrivals(code).catch(() => null);
    for (const w of list.filter(x => x.code === code)) {
      const next = a?.filter(v => !v.planned).map(v => ({ ...v, m: mins(v.eta, new Date()) })).filter(v => v.line === w.line && v.m >= 0).sort((x, y) => x.m - y.m)[0];
      if (next && next.m <= w.min) notify({ id: `bus${code}${w.line}${+next.eta}`, title: `קו ${w.line} מגיע ${next.m <= 0 ? 'עכשיו' : `בעוד ${next.m} דק'`}`, body: w.stop || '' });
      else left.push(w);
    }
  }
  saveWatches(left);
}
function startWatching() { if (!watchTimer && watches().length) { watchTimer = setInterval(checkWatches, 30_000); checkWatches(); } }
startWatching();
// Fixed alerts (SPEC: "בשעות קבועות"): settings.fixed = [{ code, stop, line, time 'HH:MM', days [0-6] }]. From that time,
// on those days, a watch as the bell's for an hour. Armed once a day (localStorage).
const ARMED = 'haluach.transit.armed';
function armFixed() {
  const now = new Date(), today = now.toDateString();
  let armed = {}; try { armed = JSON.parse(localStorage.getItem(ARMED) || '{}'); } catch {}
  const s = cardSettings('transit');
  let added = false;
  for (const f of s.fixed || []) {
    const key = `${f.code}|${f.line}|${f.time}`;
    if (!(f.days || []).includes(now.getDay()) || armed[key] === today) continue;
    const [hh, mm] = String(f.time || '').split(':').map(Number), at = new Date(now); at.setHours(hh, mm, 0, 0);
    if (now < at || now - at > 3600_000) continue;
    armed[key] = today;
    const l = watches().filter(w => !(w.code === f.code && w.line === f.line));
    l.push({ code: f.code, line: f.line, stop: f.stop, min: s.alertMin || 5, until: +at + 3600_000 });
    saveWatches(l); added = true;
  }
  try { localStorage.setItem(ARMED, JSON.stringify(armed)); } catch {}
  if (added) startWatching();
}
whileVisible(armFixed, 60_000); armFixed();
const BELL = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3"/></svg>';
const BELL_ON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3" stroke="currentColor" stroke-width="1.3"/></svg>';
function bell(v, code, stop) {
  const b = h('button', { class: 'icon tr-bell' });
  const paint = () => { const on = watching(code, v.line); b.innerHTML = on ? BELL_ON : BELL; b.title = on ? 'ביטול ההתראה' : `התראה כשקו ${v.line} בעוד ${cardSettings('transit').alertMin || 5} דק'`; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); };
  b.addEventListener('click', e => {
    e.stopPropagation();
    const l = watches();
    if (watching(code, v.line)) saveWatches(l.filter(w => !(w.code === code && w.line === v.line)));
    else { l.push({ code, line: v.line, stop, min: cardSettings('transit').alertMin || 5, until: Date.now() + 2 * 3600_000 }); saveWatches(l); startWatching(); }
    paint();
  });
  paint();
  return b;
}
const busRow = (v, code, stop) => h('div', { class: 'row' + (v.minutes <= 2 ? ' next' : '') },
  h('span', {}, h('b', { class: v.label ? '' : 'num' }, v.label || v.line), ' ', v.dest),
  h('span', { class: 'tr-end' }, h('b', {}, minText(v.minutes)), code && !v.planned ? bell(v, code, stop) : ''));
const loadText = p => p == null ? '' : p >= 80 ? 'עמוס מאוד' : p >= 50 ? 'עמוס' : 'פנוי';
/** One stop: its name, then up to n buses. */
function stopBlock(st, inf, n, now) {
  const list = inf.list.map(v => ({ ...v, minutes: mins(v.eta, now) })).filter(v => v.minutes >= -1).slice(0, n);
  return [h('div', { class: 'item' }, h('div', { class: 'val' }, st.name || inf.name || st.code), h('span', { class: 'end lab num' }, st.code)),
    ...(inf.planned && list.length ? [h('div', { class: 'sub faint' }, 'לפי לוח הזמנים')] : []),
    ...(list.length ? list.map(v => busRow(v, st.code, st.name || inf.name)) : [h('div', { class: 'sub' }, inf.ok ? 'אין אוטובוסים בקרוב.' : 'המקור לא ענה.')])];
}
/** The saved rail route: its name, then up to n trains (full = changes and load too). */
function railBlock(s, r, n, full) {
  const row = t => h('div', { class: 'row' + (t.cancelled ? ' past' : ''), title: t.load != null ? `תפוסה צפויה ${t.load}%` : '' },
    h('span', {}, t.cancelled ? 'בוטלה' : t.delay > 0 ? h('span', { class: 'down' }, h('span', { class: 'num' }, '+' + t.delay), " דק'") : 'בזמן',
      t.platform != null ? ` · רציף ${t.platform}` : '',
      full && t.changes ? h('span', { class: 'faint' }, ` · ${t.changes} החלפות`) : '',
      full && t.load != null ? h('span', { class: 'faint' }, ' · ' + loadText(t.load)) : ''),
    h('b', { class: 'num' }, hm(new Date(t.dep)), ' > ', hm(new Date(t.arr))));
  return [h('div', { class: 'item' }, h('div', { class: 'val' }, s.rail.from.name, ' > ', s.rail.to.name),
    r?.src === 'transitous' ? h('span', { class: 'end lab', title: 'רכבת ישראל לא ענתה' }, 'לוח זמנים משוער') : null),
    ...(r?.trips?.length ? r.trips.slice(0, n).map(row) : [h('div', { class: 'sub' }, r ? 'אין רכבות בהמשך היום.' : 'המקור לא ענה.')])];
}
/** Everything that is not on the card: every stop, the rail route, nearby stops, route planning. */
function moreLayer(ctx, infos, rail, now) {
  const s = ctx.s;
  openLayer(body => {
    body.append(h('h2', {}, card.title));
    (s.stops || []).forEach((st, i) => body.append(...stopBlock(st, infos[i], s.perStop, now), h('hr', { class: 'sep' })));
    if (rail) body.append(...railBlock(s, rail.r, s.railCount, true),
      h('button', { class: 'link', onclick: () => updatesLayer(rail.ups, rail.ids) }, rail.rel.length ? `${rail.rel.length} הודעות במסלול` : 'הודעות רכבת'), h('hr', { class: 'sep' }));
    body.append(h('div', { class: 'chips' },
      h('button', { class: 'btn', onclick: () => nearbyLayer(ctx) }, 'תחנות קרובות'),
      h('button', { class: 'btn', onclick: planLayer }, 'תכנון מסלול'),
      h('button', { class: 'btn', onclick: () => settingsLayer(ctx) }, 'עריכת תחנות')));
  });
}

const card = {
  id: 'transit',
  title: 'תחבורה ציבורית',
  size: [1, 4],
  defaults: { stops: [], perStop: 4, rail: null, railCount: 3, alertMin: 5 },
  every: ctx => (ctx.s.everySec || 60) * 1000,
  async render(el, ctx) {
    const s = ctx.s;
    const stops = s.stops || [];
    let failed = false, lastOk = 0;
    const now = Date.now();
    const infos = await Promise.all(stops.map(st => stopInfo(st.code)));
    for (const inf of infos) { if (!inf.ok) failed = true; else lastOk = Math.max(lastOk, inf.at); }
    let rail = null;
    if (s.rail?.from && s.rail?.to) {
      const ids = [s.rail.from.id, s.rail.to.id];
      let r = null;
      try { r = await railTrips(s.rail); keep('rail.trips', r); lastOk = Math.max(lastOk, Date.now()); }
      catch { failed = true; const c = kept('rail.trips'); r = c ? { ...c.v, trips: c.v.trips.filter(t => t.dep >= now - 60000) } : null; }
      const ups = await railUpdates(ids);
      rail = { r, ups, ids, rel: ups.filter(u => relevant(u, ids)) };
    }
    if (!stops.length && !rail) {
      el.replaceChildren(h('div', { class: 'sub' }, 'אין תחנה שמורה. בוחרים מהתחנות הקרובות, או לפי מספר התחנה (כתוב על השלט).'),
        h('div', { class: 'chips' }, h('button', { class: 'btn primary', onclick: () => nearbyLayer(ctx) }, 'תחנות קרובות'),
          h('button', { class: 'btn', onclick: () => settingsLayer(ctx) }, 'לפי מספר'), h('button', { class: 'btn', onclick: () => planLayer() }, 'תכנון מסלול')));
      ctx.stale(null, false);
      return;
    }
    // On the card: the first stop (or the rail route when there is no stop). Everything else: "עוד".
    const parts = stops.length ? stopBlock(stops[0], infos[0], Math.min(s.perStop, 5), now) : railBlock(s, rail.r, Math.min(s.railCount, 5), false);
    if (rail?.rel.length) parts.push(h('div', {}, h('button', { class: 'link', onclick: () => updatesLayer(rail.ups, rail.ids) }, `${rail.rel.length} הודעות רכבת במסלול`)));
    parts.push(h('button', { class: 'more', onclick: () => moreLayer(ctx, infos, rail, now) }, 'עוד'));
    el.replaceChildren(...parts);
    ctx.stale(lastOk ? new Date(lastOk) : null, failed);
  },
  // The card's last answers when they are under 2 minutes old (it renders every minute); else a fresh fetch.
  async widget(ctx) {
    try {
      const s = ctx?.s || {}, now = Date.now(), FRESH = 2 * 60_000;
      const stops = s.stops || [];
      const infos = await Promise.all(stops.map(async st => {
        const c = kept('stop.' + st.code);
        return c && now - c.at < FRESH ? { ...c.v, ok: true } : stopInfo(st.code);
      }));
      const buses = [];
      stops.forEach((st, i) => {
        for (const v of infos[i].list || []) { const m = mins(v.eta, now); if (m >= -1) buses.push({ ...v, m, si: i, stop: st.name || infos[i].name || st.code }); }
      });
      buses.sort((a, b) => a.m - b.m);
      let trips = [];
      if (s.rail?.from && s.rail?.to) {
        const c = kept('rail.trips');
        let r = c && now - c.at < FRESH ? c.v : null;
        if (!r) { try { r = await railTrips(s.rail); keep('rail.trips', r); } catch { r = c?.v || null; } }
        trips = (r?.trips || []).filter(t => t.dep + (t.delay || 0) * 60000 >= now - 60000);
      }
      const many = stops.length > 1;
      const rows = buses.slice(0, 8).map(v => [(v.label || `קו ${v.line}`) + ' ' + (many ? v.stop : v.dest ? 'ל' + v.dest : ''), inMin(v.m), v.m <= 2]);
      for (const t of trips.slice(0, 4)) rows.push([`רכבת ${hm(new Date(t.dep))} > ${hm(new Date(t.arr))}`, t.cancelled ? 'בוטלה' : t.delay > 0 ? `+${t.delay} דק'` : 'בזמן', t.cancelled || t.delay > 0]);
      // One summary per stop too, for a widget set to one stop (its "התאמה אישית", src/widgets.rs).
      const one = i => {
        const mine = buses.filter(v => v.si === i), first = mine[0];
        return { big: first ? `${first.line} · ${inMin(first.m)}` : 'אין אוטובוסים', sub: stops[i].name || infos[i].name || stops[i].code,
          rows: mine.slice(0, 8).map(v => [(v.label || `קו ${v.line}`) + ' ' + (v.dest ? 'ל' + v.dest : ''), inMin(v.m), v.m <= 2]), at: now };
      };
      const per = Object.fromEntries(stops.map((st, i) => [String(st.code), one(i)]));
      // The rail route alone, for a widget set to it ("rail").
      const rail = s.rail?.from && s.rail?.to ? (() => {
        const t = trips[0];
        return { big: t ? hm(new Date(t.dep)) : 'אין רכבות', sub: `${s.rail.from.name} > ${s.rail.to.name}`, at: now,
          rows: trips.slice(0, 6).map(t => [`${hm(new Date(t.dep))} > ${hm(new Date(t.arr))}`, t.cancelled ? 'בוטלה' : t.delay > 0 ? `+${t.delay} דק'` : 'בזמן', t.cancelled || t.delay > 0]) };
      })() : null;
      if (rail) per.rail = rail;
      if (stops.length) return { ...one(0), rows, per };
      if (rail) return { ...rail, rows, per };
      return { big: '', sub: 'הוסיפו תחנה בלוח', rows: [], empty: true };
    } catch { return { big: '', sub: 'אין נתוני תחבורה', rows: [] }; }
  },
  async settings(box, ctx) {
    const s = ctx.s;
    const stops = [...(s.stops || [])];
    const put = (patch, redraw = true) => { ctx.set(patch); if (redraw) ctx.rerender(); };
    const saveStops = debounce(() => put({ stops: [...stops] }));
    // The saved stops: the name can be changed, the number stays.
    const list = h('div', { class: 'form' });
    // The order matters (the first stop leads the widget): a row is dragged to reorder (liveDrag), not from the
    // name field or the x.
    // A row's place is read at the event (not kept in a closure), so after a drop the rows stay as liveDrag left them.
    const at = el => [...list.querySelectorAll('.tr-row')].indexOf(el.closest('.tr-row'));
    const drag = e => {
      if (e.button || e.target.closest('input, button')) return;
      const rows = [...list.querySelectorAll('.tr-row')], i = at(e.currentTarget);
      liveDrag(e, rows[i], rows, to => { if (to < 0) return; stops.splice(to, 0, ...stops.splice(i, 1)); put({ stops: [...stops] }); });
    };
    const draw = () => list.replaceChildren(...stops.map(st => h('div', { class: 'srow tr-row', title: stops.length > 1 ? 'גרירה לשינוי הסדר' : '', onpointerdown: drag },
      h('span', { class: 'tr-stop' }, h('input', { type: 'text', value: st.name, 'aria-label': 'שם התחנה', oninput: e => { const i = at(e.target); stops[i] = { ...stops[i], name: e.target.value }; saveStops(); } }),
        h('span', { class: 'hint' }, 'תחנה ', h('span', { class: 'num' }, st.code))),
      h('button', { class: 'icon', title: 'הסרה', 'aria-label': 'הסרה', html: X_ICON, onclick: e => { stops.splice(at(e.currentTarget), 1); put({ stops: [...stops] }); draw(); } }))),
      stops.length ? '' : h('div', { class: 'sub' }, 'אין תחנה שמורה.'));
    draw();
    // Adding by the number on the stop's sign.
    const code = h('input', { type: 'text', class: 'n', inputmode: 'numeric', placeholder: 'מספר', 'aria-label': 'מספר תחנה' });
    code.style.width = '96px';
    const name = h('input', { type: 'text', class: 'tr-name', placeholder: 'לא חובה', 'aria-label': 'שם' });
    const msg = h('span', { class: 'hint' }, 'כתוב על השלט בתחנה');
    const add = async () => {
      const c = code.value.trim();
      if (!/^\d{1,6}$/.test(c)) { msg.textContent = 'ספרות בלבד, כמו על השלט.'; return; }
      msg.textContent = 'בודק...';
      const inf = await stopInfo(c);
      stops.push({ code: c, name: name.value.trim() || inf.name || c });
      code.value = name.value = '';
      msg.textContent = inf.ok && !inf.name ? 'התחנה לא נמצאה, נשמרה בכל זאת.' : 'כתוב על השלט בתחנה';
      put({ stops: [...stops] }); draw();
    };
    code.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    box.append(section('תחנות אוטובוס'), list,
      section('הוספת תחנה'), row('מספר תחנה', code, msg), row('שם', name),
      h('div', { class: 'chips tr-add' }, h('button', { class: 'btn primary', onclick: add }, 'הוספה'), h('button', { class: 'btn', onclick: () => nearbyLayer(ctx) }, 'מהתחנות הקרובות')));
    // Rare settings, at the end of the menu (appended after the rail route).
    const extra = more(
      row('לכל תחנה', number(s.perStop, 'אוטובוסים', v => put({ perStop: Math.max(1, v || 4) }), { min: 1, max: 10 })),
      row('פעמון: התראה לפני', number(s.alertMin || 5, 'דק׳', v => put({ alertMin: Math.min(30, Math.max(1, v || 5)) }, false), { min: 1, max: 30 }), 'כשלוחצים על הפעמון ליד אוטובוס'),
      row('רענון', choice([[30, '30 שנ׳'], [60, 'דקה'], [120, '2 דק׳'], [300, '5 דק׳']], +s.everySec || 60, v => put({ everySec: +v }, false)), 'כשהלוח פתוח'));

    // Fixed alerts: a line at a saved stop, from a time, on chosen days.
    if (stops.length) {
      const fixed = [...(s.fixed || [])];
      const DAYS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
      const dayText = ds => ds.length === 5 && [0, 1, 2, 3, 4].every(d => ds.includes(d)) ? 'א׳-ה׳' : ds.map(d => DAYS[d] + '׳').join(' ');
      const flist = h('div', { class: 'form' });
      const fcount = h('span', { class: 'faint' });
      const drawFixed = () => { fcount.textContent = fixed.length ? String(fixed.length) : ''; flist.replaceChildren(...(fixed.length ? fixed.map((f, i) => h('div', { class: 'srow' },
        h('span', {}, `קו ${f.line} · ${f.stop || f.code}`, h('span', { class: 'hint' }, `${f.time} · ${dayText(f.days)}`)),
        h('button', { class: 'icon', title: 'הסרה', 'aria-label': 'הסרה', html: X_ICON, onclick: () => { fixed.splice(i, 1); put({ fixed: [...fixed] }, false); drawFixed(); } })))
        : [h('div', { class: 'sub' }, 'אין התראות קבועות.')])); };
      drawFixed();
      const fStop = h('select', { 'aria-label': 'תחנה' }, ...stops.map(st => h('option', { value: st.code }, st.name || st.code)));
      const fLine = h('input', { type: 'text', class: 'n', placeholder: 'קו', 'aria-label': 'מספר קו', style: 'width:64px' });
      const fTime = h('input', { type: 'time', value: '07:30', 'aria-label': 'משעה' });
      let fDays = [0, 1, 2, 3, 4];
      const dayBox = h('span', { class: 'chips' });
      const drawDays = () => dayBox.replaceChildren(...DAYS.map((d, k) => h('button', { type: 'button', class: 'chip' + (fDays.includes(k) ? ' on' : ''), onclick: () => { fDays = fDays.includes(k) ? fDays.filter(x => x !== k) : [...fDays, k].sort(); drawDays(); } }, d)));
      drawDays();
      const addFixed = () => {
        const line = fLine.value.trim(), st = stops.find(x => String(x.code) === fStop.value);
        if (!line || !st || !fDays.length) return;
        fixed.push({ code: st.code, stop: st.name || '', line, time: fTime.value || '07:30', days: fDays });
        fLine.value = ''; put({ fixed: [...fixed] }, false); drawFixed();
      };
      // Folded (DESIGN.md "Inner menus" rule 4: at most about 8 rows in view), with how many there are.
      box.append(h('details', {}, h('summary', {}, 'התראות קבועות', fcount), h('div', { class: 'form' }, flist,
        row('תחנה', fStop, 'התראה כשהקו קרוב, בשעה שבחרתם, עד שעה.'), row('קו ומשעה', h('span', { class: 'unit' }, fLine, fTime)), row('ימים', dayBox),
        h('div', { class: 'chips tr-add' }, h('button', { class: 'btn', onclick: addFixed }, 'הוספת התראה')))));
    }

    // A saved rail route: two stations; how many trains only once there is a route.
    box.append(section('מסלול רכבת'));
    const stations = await railStations();
    if (!stations.length) { box.append(h('div', { class: 'sub' }, 'רשימת התחנות של רכבת ישראל לא נטענה. נסו שוב מאוחר יותר.'), extra); return; }
    const pick = id => { const st = stations.find(x => x.id === id); return st ? { id: st.id, name: st.name, lat: st.lat, lng: st.lng } : null; };
    const sel = cur => h('select', { onchange: saveRail }, h('option', { value: '' }, 'בחירה...'), ...stations.map(st => h('option', { value: st.id, selected: cur?.id === st.id }, st.name)));
    const from = sel(s.rail?.from), to = sel(s.rail?.to);
    const count = row('כמה להציג', number(s.railCount, 'רכבות', v => put({ railCount: Math.max(1, v || 3) }), { min: 1, max: 8 }));
    count.classList.add('fold');
    count.hidden = !(s.rail?.from && s.rail?.to);
    function saveRail() {
      const f = pick(from.value), t = pick(to.value);
      const rail = f && t && f.id !== t.id ? { from: f, to: t } : null;
      count.hidden = !rail;
      put({ rail });
    }
    box.append(row('מתחנה', from), row('לתחנה', to), count, extra);
  },
};
export default card;

export const css = `
.tr-row { cursor: grab; touch-action: none; }
.tr-row.shift { transition: transform .18s var(--ease); }
.tr-row.dragging { position: relative; z-index: 2; background: var(--sheet); box-shadow: var(--shadow-drag); border-radius: var(--radius); }
.tr-end { display: inline-flex; align-items: center; gap: 2px; }
.tr-bell { width: 24px; height: 24px; opacity: .55; }
.tr-bell.on { opacity: 1; color: var(--accent); }
.tr-stop { display: grid; gap: 2px; flex: 1; min-width: 0; }
.tr-stop input, .tr-name { width: min(100%, 220px); }
.tr-add { padding: 8px 0; }
`;
