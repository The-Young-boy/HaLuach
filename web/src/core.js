// The board's core: settings, talking to the provider, the card grid (drag, resize, hide), the layer.
// A card is a module (src/cards/*.js) that exports default { id, title, defaults, render(el, ctx), settings?(el, ctx), every? }.
// Cards never talk to each other; shared things (location, zmanim, calendar) come from ctx.

// ---------- settings ----------
// One object, kept in localStorage (fast) and on the provider's disk (the widgets and the background read it there).
const KEY = 'haluach.settings';
const BASE = {
  v: 1,
  setupDone: false,
  loc: null,              // { name, lat, lng, elev, il, tz }
  theme: 'auto',          // auto | light | dark
  layout: [],             // [{ id, w, h, hidden }] in board order
  cards: {},              // per-card settings, by card id
  quietShabbat: true,
};
let S = load();
function load() {
  try { return { ...BASE, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...BASE }; }
}
let saveTimer = 0;
export function settings() { return S; }
export function save(patch) {
  if (patch) S = { ...S, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {}
  clearTimeout(saveTimer);
  // The provider copy: lat/lng at the top level too, for the Rust side.
  saveTimer = setTimeout(() => { postSettings(false); window.dispatchEvent(new Event('haluach:saved')); }, 300);
}
// A failed save is tried once more after 5 s (with the settings of then: a newer save cancels the retry and sends its own).
function postSettings(retry) {
  const flat = { ...S, lat: S.loc?.lat, lng: S.loc?.lng, elev: S.loc?.elev ?? 0 };
  fetch('settings', { method: 'POST', body: JSON.stringify(flat) })
    .then(r => { if (!r.ok) throw new Error('status ' + r.status); })
    .catch(e => {
      log(`settings save failed (${retry ? 'retry' : 'first'}): ${e.message}`);
      if (!retry) saveTimer = setTimeout(() => postSettings(true), 5000);
    });
}
export function cardSettings(id, defaults = {}) {
  return { ...defaults, ...(S.cards[id] || {}) };
}
export function saveCard(id, patch) {
  S.cards = { ...S.cards, [id]: { ...(S.cards[id] || {}), ...patch } };
  save();
}

// ---------- the provider ----------
export function log(m) { fetch('log?m=' + encodeURIComponent(String(m).slice(0, 300))).catch(() => {}); }
window.addEventListener('error', e => log(`error ${e.message} @${e.lineno}`));
window.addEventListener('unhandledrejection', e => log(`rejection ${e.reason}`));

// ---------- the page idles while the board is closed ----------
// The provider does the background work, so a hidden page runs no timers. whileVisible(fn, ms) = setInterval that
// stops while the page is hidden and, on showing again, runs fn once and starts again. Returns a stop function.
export function whileVisible(fn, ms) {
  let t = 0, stopped = false;
  const run = () => { try { Promise.resolve(fn()).catch(e => log(`whileVisible: ${e?.message || e}`)); } catch (e) { log(`whileVisible: ${e.message}`); } };
  const go = () => { if (!t && !stopped && !document.hidden) t = setInterval(() => { if (document.hidden) { clearInterval(t); t = 0; } else run(); }, ms); };
  const vis = () => { if (document.hidden) { clearInterval(t); t = 0; } else if (!t && !stopped) { run(); go(); } };
  document.addEventListener('visibilitychange', vis);
  go();
  return () => { stopped = true; clearInterval(t); t = 0; document.removeEventListener('visibilitychange', vis); };
}

// Data saver (as in HaFeed): S.saver 'auto' (on a metered connection, /board/metered), 'on' or 'off'. On: every card
// refreshes 4 times less often.
let metered = false;
const askMetered = () => fetch('metered').then(r => r.text()).then(t => { metered = t.trim() === '1'; }).catch(() => {});
askMetered(); whileVisible(askMetered, 10 * 60_000);
export function saving() { const v = S.saver || 'auto'; return v === 'on' || (v === 'auto' && metered); }
export const isMetered = () => metered;
/** One limit of data saving (HaFeed sv): svBg no checks while closed, svPics no pictures, svSlow cards refresh x4. */
export function sv(k) { return saving() && (S[k] ?? true); }

// Each source's last answer, by host, for About ("מצב המקורות"): { name: { ok: ms, fail: ms } }.
const SOURCE_NAMES = { 'api.open-meteo.com': 'מזג אוויר', 'air-quality-api.open-meteo.com': 'איכות אוויר', 'ims.gov.il': 'השירות המטאורולוגי',
  'boi.org.il': 'בנק ישראל', 'edge.boi.gov.il': 'בנק ישראל', 'open.er-api.com': 'שערי מטבע', 'api.coingecko.com': 'ביטקוין',
  'curlbus.app': 'אוטובוסים', 'open-bus-stride-api.hasadna.org.il': 'תחנות קרובות', 'rail-api.rail.co.il': 'רכבת ישראל', 'api.transitous.org': 'תכנון מסלול',
  'global.cainiao.com': 'משלוחים', 'data.gov.il': 'מפלס הכנרת', 'www.tzevaadom.co.il': 'רשימת היישובים' };
// Kept in localStorage: the cards use their cached data at first, so a fresh page would know nothing.
let sources = {};
try { sources = JSON.parse(localStorage.getItem('haluach.sources') || '{}'); } catch {}
function mark(url, ok) {
  let host = ''; try { host = new URL(url).hostname; } catch { return; }
  const k = SOURCE_NAMES[host] || host, x = sources[k] || (sources[k] = {});
  x[ok ? 'ok' : 'fail'] = Date.now();
  try { localStorage.setItem('haluach.sources', JSON.stringify(sources)); } catch {}
}
export function sourceStates() { return sources; }

/** A source that refuses cross-origin reads, through the provider. 425 = the provider is still loading it: ask again. */
export async function proxied(url, { method = 'GET', body, type, headers = [], cache = true, as = 'json', follow = true } = {}) {
  let q = 'proxy?u=' + encodeURIComponent(url);
  if (method !== 'GET') q += '&m=' + method;
  // No redirect followed: the answer is "<status> <Location>" (main.rs).
  if (!follow) q += '&nr=1';
  if (type) q += '&t=' + encodeURIComponent(type);
  if (method !== 'GET' && cache) q += '&c=1';
  for (const h of headers) q += '&h=' + encodeURIComponent(h);
  for (let i = 0; i < 20; i++) {
    // A body goes as the POST's body (an address is too short for a big one); the provider sends it on.
    const r = await (body != null ? fetch(q, { method: 'POST', body: String(body) }) : fetch(q));
    if (r.status === 425) { await new Promise(res => setTimeout(res, 400 + i * 200)); continue; }
    mark(url, r.ok);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return as === 'text' ? r.text() : as === 'buffer' ? r.arrayBuffer() : r.json();
  }
  throw new Error('timeout ' + url);
}
/** The browser-like User-Agent some public sources need (IMS, data.gov.il, Bank of Israel answer a fake 404 without one). */
export const BROWSER_UA = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach';

/** The engine's times for one civil day at the current location: { id: Date }. Cached per day. */
const zcache = new Map();
export async function zmanim(date = new Date(), loc = S.loc) {
  if (!loc) return null;
  const iso = ymd(date);
  // vis = "בניכוי N ק\"מ" for the visible sunrise (set by the zmanim card; omitted = not computed). In the key: a
  // change of it must not keep the old times.
  const vis = S.cards.zmanim?.visKm ?? (S.cards.zmanim?.method && Object.values(S.cards.zmanim.method).some(m => /_vis$/.test(m)) ? 2 : -1);
  const k = `${iso}|${loc.lat}|${loc.lng}|${loc.elev}|${vis}`;
  if (!zcache.has(k)) {
    // Days over a week old go (the page lives for weeks). Not yesterday or last shabbat: the shabbat card asks for
    // them on every drawing, and dropping them each time fetched them again and again.
    const old = new Date(); old.setDate(old.getDate() - 8);
    const cut = ymd(old);
    for (const key of zcache.keys()) if (key.slice(0, 10) < cut) zcache.delete(key);
    const p = fetch(`zmanim?lat=${loc.lat}&lng=${loc.lng}&elev=${loc.elev || 0}&date=${iso}&vis=${vis}`).then(r => r.json()).then(d => {
      if (!d?.t) throw new Error('zmanim: no times');
      const t = {};
      for (const [id, ms] of Object.entries(d.t)) t[id] = ms == null ? null : new Date(ms);
      return t;
    });
    // A failure is not kept: the next call asks again.
    p.catch(() => { if (zcache.get(k) === p) zcache.delete(k); });
    zcache.set(k, p);
  }
  return zcache.get(k);
}
export function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function hm(d, secs = false) {
  if (!d) return '—';
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}), timeZone: S.loc?.tz || undefined });
}
/** A zman as shown (SPEC "עיגול לחומרא"): 'down' a deadline (the seconds dropped), 'up' a start (any seconds: the
 *  next minute), 'sec' both ways (sunrise, sunset: with seconds). The zmanim card's "להציג שניות" shows every time
 *  with seconds. Countdowns use the exact time, not this. */
export function zmanText(d, kind = 'sec', secs = cardSettings('zmanim').secs) {
  if (!d) return '—';
  if (secs || kind === 'sec') return hm(d, true);
  const m = 60_000, t = +d;
  return hm(new Date(kind === 'up' ? Math.ceil(t / m) * m : Math.floor(t / m) * m));
}
/** A card that needs a place and has none: a line and the button that opens the place picker (the header's). */
export function noPlace() {
  return h('div', { class: 'row' }, h('span', { class: 'sub' }, 'צריך מיקום כדי להציג.'),
    h('button', { class: 'btn primary', onclick: () => document.getElementById('place')?.click() }, 'בחירת מיקום'));
}
/** A file into Documents (the provider writes it). name: HaLuach-<letters>.ics|.json. The full path, or null. */
export async function saveDoc(name, text) {
  const r = await fetch('docsave?name=' + encodeURIComponent(name), { method: 'POST', body: text }).catch(() => null);
  return r?.ok ? (await r.text()).trim() : null;
}
export function openExternal(url) { return fetch('open?u=' + encodeURIComponent(url)); }
/** A notification from a card. via: the user's choice in the notifications tab (HaFeed's "איך להתריע"):
 *  toast = a Windows notification, board = quietly on the widgets button, both, off = none. */
export function notify({ title, body = '', url = '', id = '', img = '', icon = '', via = S.notify?.via || 'toast' }) {
  if (via === 'off') return Promise.resolve(new Response('off'));
  return fetch(`notify?via=${via}&id=${encodeURIComponent(id)}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&url=${encodeURIComponent(url)}&img=${encodeURIComponent(img)}&icon=${encodeURIComponent(icon)}`);
}

// ---------- tiny DOM helpers ----------
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- details open in place (the user: no popup windows) ----------
// openLayer(build) keeps its name and contract, but the content opens INSIDE the card that was clicked, under its
// content; a click on the same button, "סגירה" or Escape folds it back. Without a card (a hidden card's settings),
// it opens as a panel at the top of the board. The header's buttons and the wizard use openSheet (below). When the board is closed, everything folds back.
let lastHost = null, lastBtn = null;
document.addEventListener('pointerdown', e => { lastBtn = e.target.closest?.('button, a, [role=button]') || null; lastHost = e.target.closest?.('.card-main') || (e.target.closest?.('.top') ? 'top' : null); }, true);
const CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
export function openLayer(build, host) {
  host = host || lastHost;
  const box = host && host !== 'top' && host.isConnected ? host : document.getElementById('panel');
  // A second click on the button that opened these details folds them back.
  const open = box.querySelector(':scope > .expand');
  if (open && lastBtn && open._by === lastBtn && !open.contains(lastBtn)) { closeLayer(box); return; }
  // Replaced by another one: gone at once (a fold here would push the new one down while it closes).
  closeLayer(box, true);
  const body = h('div', { class: 'expand-body' });
  const wrap = h('div', { class: 'expand' + (box.id === 'panel' ? ' top-panel' : '') },
    h('button', { class: 'icon expand-close', title: 'סגירה', 'aria-label': 'סגירה', html: CLOSE, onclick: () => closeLayer(box) }), body);
  wrap._by = lastBtn;
  box.append(wrap);
  if (box.id === 'panel') box.hidden = false;
  build(body, () => closeLayer(box));
  requestAnimationFrame(() => box.id === 'panel' ? scrollTo({ top: 0, behavior: 'smooth' }) : wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}
// ---------- motion (from HaFeed's feed.html: every change slides or fades, never jumps) ----------
export const calm = matchMedia('(prefers-reduced-motion: reduce)');
/** A change of view in a View Transition: the old picture slides out, the new slides in (dir 1 = to a tab on the
 *  left, -1 = to the right, 0 = a cross-fade). `kind` names the part that moves ("grid" or "set"). */
let vtSeq = 0;
export function vt(fn, dir = 0, kind = '') {
  if (!document.startViewTransition || calm.matches || document.hidden) return fn();
  const root = document.documentElement, my = ++vtSeq;
  root.classList.remove('vt-grid', 'vt-set');
  root.classList.toggle('vt-fwd', dir > 0); root.classList.toggle('vt-back', dir < 0);
  if (kind) root.classList.add('vt-' + kind);
  // Only the last transition clears the classes: an earlier one ending must not strip the newer one's.
  // An aborted one (the board hidden mid-way) rejects ready too: caught, the change itself still happens.
  const t = document.startViewTransition(fn);
  t.ready.catch(() => {});
  t.finished.catch(() => {}).finally(() => { if (my === vtSeq) root.classList.remove('vt-fwd', 'vt-back', 'vt-grid', 'vt-set'); });
}
/** A box that changed height grows (or shrinks) to it instead of jumping. */
export function growFrom(node, h0) {
  if (!node || calm.matches) return;
  // A grow still running (a quick fold-open-fold) gives way to the new one.
  node.getAnimations().forEach(a => { if (a.id === 'grow') a.cancel(); });
  const h1 = node.offsetHeight;
  if (Math.abs(h1 - h0) > 2) node.animate([{ height: h0 + 'px', overflow: 'clip' }, { height: h1 + 'px', overflow: 'clip' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', id: 'grow' });
}
/** A box that leaves folds shut and fades, then is removed. */
function collapse(node) {
  if (calm.matches) return node.remove();
  node.animate([{ height: node.offsetHeight + 'px', opacity: 1, overflow: 'clip' }, { height: '0px', opacity: 0, paddingBlock: '0px', marginBlock: '0px', overflow: 'clip' }], { duration: 200, easing: 'ease-in' })
    .finished.then(() => node.remove(), () => node.remove());
}
export const ink = b => b.append(h('i', { class: 'ink' }));

/** Fold back one card's details (or the top panel), or all of them. */
export function closeLayer(box, now = false) {
  const list = box ? [box] : [...document.querySelectorAll('.card-main'), document.getElementById('panel')];
  for (const b of list) b?.querySelectorAll(':scope > .expand').forEach(x => (box && !now ? collapse(x) : x.remove()));
  const p = document.getElementById('panel');
  if (p && !p.querySelector('.expand')) p.hidden = true;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLayer(); });
// The board closed (the page is hidden): everything folds back, so it opens compact next time.
// Dev only (localhost): 'haluach.keepOpen' keeps things open while the dev pane hides the page.
const keepOpen = () => location.hostname === 'localhost' && localStorage.getItem('haluach.keepOpen');
document.addEventListener('visibilitychange', () => { if (document.hidden && !keepOpen()) { closeLayer(); closeSheets(); } });

// ---------- the popup sheet (as in HaFeed): the header's place, "+" and gear, the wizard ----------
// openSheet(title, build, opts): a panel over the board with a sticky header (title, a search when there are tabs,
// close). build(body, close, api) fills it. With opts.tabs = [[id, label], ...], build adds sections with
// api.section(tabId, title, ...rows): they show by tab, in two columns when wide, and the search looks in all of
// them. Esc, a click outside it, or the board closing close it. opts.over: on top of the open one (else it
// replaces it). opts.sticky: a click outside does not close it (the wizard).
const sheets = [];
const SEARCH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>';
export function openSheet(title, build, opts = {}) {
  // Replacing an open one (the wizard's next step): no fade in between.
  const swap = !opts.over && sheets.length > 0;
  if (!opts.over) closeSheets(true);
  const { tabs } = opts;
  const head = h('header', {}, h('h2', {}, title));
  const body = h('div', { class: 'sheet-body' + (tabs ? ' tabbed' : '') });
  const top = h('div', { class: 'sheet-top' }, head);
  const panel = h('div', { class: 'sheet-panel' + (opts.narrow ? ' narrow' : '') }, top);
  const sh = h('div', { class: 'sheet' + (swap ? ' show no-anim' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, panel);
  const close = now => {
    const i = sheets.indexOf(sh);
    if (i < 0) return;
    sheets.splice(i, 1);
    if (now === true) sh.remove();
    else { sh.classList.remove('show', 'no-anim'); setTimeout(() => sh.remove(), 200); }
    opts.onclose?.();
  };
  sh._close = close;
  let input = null, nav = null, noHit = null;
  const names = Object.fromEntries(tabs || []);
  const setTab = (t, slide = false) => {
    if (!names[t]) t = tabs[0][0];
    const ids = tabs.map(x => x[0]), dir = Math.sign(ids.indexOf(t) - ids.indexOf(body.dataset.tab));
    const run = () => {
      body.dataset.tab = t;
      nav.querySelectorAll('button').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.t === t)); b.querySelector('.ink')?.remove(); if (b.dataset.t === t) ink(b); });
      body.querySelectorAll(':scope > section[data-t]').forEach(s => { s.hidden = s.dataset.t !== t; });
      nav.querySelectorAll('button').forEach(b => { if (opts.hiddenTabs?.includes(b.dataset.t)) b.hidden = b.dataset.t !== t; });
      if (noHit) noHit.hidden = true;
      sh.scrollTop = 0;
      S.setTab = t; save();
    };
    // A tab to the left (later in RTL) slides in from the left (as HaFeed's settings).
    if (slide && body.dataset.tab) vt(run, dir, 'set'); else run();
  };
  // The search: the sections of every tab that have the words; inside one whose title does not match, only the
  // matching rows. Each found section says which tab it is in. Empty: back to the open tab.
  const search = () => {
    const q = input.value.trim().toLowerCase();
    const rows = s => [...s.querySelectorAll(':scope > .form > *, :scope > .seg, :scope > .faces, :scope > .swatches')];
    body.querySelectorAll('.s-miss').forEach(r => r.classList.remove('s-miss'));
    if (!q) { body.classList.remove('searching'); return setTab(S.setTab); }
    body.classList.add('searching'); body.dataset.tab = '';
    nav.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', 'false'));
    const has = x => x.textContent.toLowerCase().includes(q);
    let any = false;
    for (const s of body.querySelectorAll(':scope > section[data-t]')) {
      s.hidden = !has(s);
      if (s.hidden) continue;
      any = true;
      s.dataset.where = names[s.dataset.t] || '';
      if (!has(s.querySelector('h3') || h('i')) && rows(s).some(has)) rows(s).forEach(r => r.classList.toggle('s-miss', !has(r)));
    }
    noHit.hidden = any;
  };
  if (tabs) {
    input = h('input', { type: 'search', placeholder: 'חיפוש בהגדרות', 'aria-label': 'חיפוש בהגדרות', autocomplete: 'off', oninput: search,
      onkeydown: e => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; search(); } } });
    head.append(h('label', { class: 'sheet-search' }, h('span', { html: SEARCH }), input));
    nav = h('nav', { class: 'sheet-tabs', role: 'tablist' }, ...tabs.map(([id, label]) => h('button', { role: 'tab', 'data-t': id, onclick: () => {
      if (input.value) { input.value = ''; body.classList.remove('searching'); body.querySelectorAll('.s-miss').forEach(r => r.classList.remove('s-miss')); }
      setTab(id, true);
    } }, label)));
  }
  head.append(h('button', { class: 'icon', title: 'סגירה', 'aria-label': 'סגירה', html: CLOSE, onclick: () => close() }));
  if (nav) top.append(nav);
  panel.append(body);
  const api = {
    section: (t, title, ...kids) => {
      const s = h('section', { 'data-t': t }, title ? h('h3', {}, title) : '', ...kids.flat());
      body.append(s);
      return s;
    },
    setTab: t => setTab(t),
  };
  sh.addEventListener('pointerdown', e => { sh._downOut = e.target === sh; });
  sh.addEventListener('click', e => { if (e.target === sh && sh._downOut && !opts.sticky) close(); });
  sheets.push(sh);
  document.body.append(sh);
  build(body, close, api);
  if (tabs) {
    noHit = h('div', { class: 'sheet-nohit sub fold', hidden: true }, 'לא נמצאה הגדרה כזאת.');
    body.append(noHit);
    // A saved tab that no longer exists (e.g. the old "גיבוי"): the first tab.
    const want = opts.tab || S.setTab;
    setTab(tabs.some(([id]) => id === want) ? want : tabs[0][0]);
  }
  requestAnimationFrame(() => sh.classList.add('show'));
  head.querySelector('button').focus({ preventScroll: true });
  return close;
}
/** Close every open sheet (the board closed). now: at once, without the fade. */
export function closeSheets(now) { for (const s of [...sheets]) s._close(now); }
// Esc closes the top sheet only (and not the card details under it).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !sheets.length || (e.target.matches?.('.sheet-search input') && e.target.value)) return;
  sheets.at(-1)._close();
}, true);

// ---------- the grid ----------
// Columns of 1 unit; a card spans w columns and h rows (row = 1 unit tall). Order = settings.layout order.
const cards = new Map(); // id -> { mod, el, timer }
export function register(mods) { for (const m of mods) cards.set(m.id, { mod: m, el: null, timer: 0 }); }
export function allCards() { return [...cards.values()].map(c => c.mod); }

export function layoutOf(id) { return S.layout.find(l => l.id === id); }
function ensureLayout() {
  const known = new Set(S.layout.map(l => l.id));
  const add = [...cards.values()].filter(c => !known.has(c.mod.id)).map(c => ({ id: c.mod.id, w: c.mod.size?.[0] || 1, h: c.mod.size?.[1] || 2, hidden: !!c.mod.hiddenByDefault }));
  if (add.length) { S.layout = [...S.layout.filter(l => cards.has(l.id)), ...add]; save(); }
}

let raised = [];
/** Cards that go to the top for now (the shabbat card on erev shabbat/yom tov), without changing the saved order. */
export function raise(ids) { if (ids.join() !== raised.join()) { raised = ids; drawGrid(); } }

// The tabs (as in HaFeed): "all" and a few groups. A card's group is here, not in the card.
export const TABS = [['all', 'הכל'], ['times', 'זמנים'], ['learn', 'לימוד'], ['audio', 'האזנה'], ['info', 'מידע'], ['tools', 'כלים']];
const GROUP = { zmanim: 'times', shabbat: 'times', omer: 'times', calendar: 'times', personal: 'times', learning: 'learn', radio: 'audio', podcasts: 'audio', youtube: 'audio', forums: 'info',
  weather: 'info', rates: 'info', kinneret: 'info', transit: 'info', shipments: 'info', redalert: 'info', tools: 'tools' };
export const groupOf = id => GROUP[id] || 'tools';
// One round icon per card, where HaFeed has the source's logo (24px grid, 1.6 stroke).
const I = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  zmanim: I('<path d="M3 17h18M6 17a6 6 0 0 1 12 0"/><path d="M12 5v2M5.6 8.6l1.4 1.4M18.4 8.6 17 10M3 21h18"/>'),
  shabbat: I('<path d="M8 21V11M16 21V11M6 21h12"/><path d="M8 8c-1-1-1-2.5 0-4 1 1.5 1 3 0 4zM16 8c-1-1-1-2.5 0-4 1 1.5 1 3 0 4z"/>'),
  learning: I('<path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5zM12 6v14"/>'),
  omer: I('<path d="M5 6v12M9 6v12M13 6v12M17 6v12M3 15l16-6"/>'),
  calendar: I('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  personal: I('<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>'),
  weather: I('<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z"/>'),
  radio: I('<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8 17 4"/><circle cx="15.5" cy="14" r="2.5"/><path d="M6.5 12.5h4M6.5 15.5h4"/>'),
  podcasts: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  youtube: I('<rect x="3" y="5.5" width="18" height="13" rx="3.5"/><path d="M10 9.5v5l4.5-2.5z"/>'),
  forums: I('<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  rates: I('<path d="M4 19h16M5 15l4-4 3 3 6-7"/><path d="M15 7h3v3"/>'),
  kinneret: I('<path d="M3 10c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0M3 15c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>'),
  transit: I('<rect x="5" y="3.5" width="14" height="14" rx="2.5"/><path d="M5 11h14M8.5 17.5V20M15.5 17.5V20"/><circle cx="8.5" cy="14.3" r=".6"/><circle cx="15.5" cy="14.3" r=".6"/>'),
  shipments: I('<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>'),
  tools: I('<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h2M12 12h2M16 12h0M8 16h2M12 16h2M16 16h0"/>'),
  redalert: I('<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17v.1"/>'),
};

export function drawGrid() {
  ensureLayout();
  const grid = document.getElementById('grid');
  grid.replaceChildren();
  const tab = S.tab || 'all';
  const order = [...S.layout].sort((a, b) => (raised.includes(b.id) ? 1 : 0) - (raised.includes(a.id) ? 1 : 0));
  for (const l of order) {
    const c = cards.get(l.id);
    if (!c || l.hidden || (c.mod.season && !c.mod.season())) { if (c) c.el = null; continue; }
    if (tab !== 'all' && groupOf(l.id) !== tab) { c.el = null; continue; }
    // A post as in HaFeed: the round icon, then the name (bold) and the card's content under it.
    c.el = h('section', { class: 'card' + (opened.has(l.id) ? ' open' : ''), 'data-id': l.id },
      h('div', { class: 'avatar', html: ICONS[l.id] || ICONS.tools }),
      h('div', { class: 'card-main' },
        h('header', { class: 'card-head', title: 'גרירה לשינוי הסדר' },
          // The keyboard's way to open and fold the card (the mouse taps the whole head, dragToSort).
          h('h2', { tabindex: 0, role: 'button', 'aria-expanded': String(opened.has(l.id)), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(l.id); } } }, c.mod.title),
          c.mod.settings ? h('button', { class: 'icon small', title: 'הגדרות הכרטיס', 'aria-label': 'הגדרות הכרטיס', onclick: () => cardSettingsLayer(c), html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M12.97 6.46L14.69 6.78L14.69 9.22L12.97 9.54L12.60 10.43L13.59 11.87L11.87 13.59L10.43 12.60L9.54 12.97L9.22 14.69L6.78 14.69L6.46 12.97L5.57 12.60L4.13 13.59L2.41 11.87L3.40 10.43L3.03 9.54L1.31 9.22L1.31 6.78L3.03 6.46L3.40 5.57L2.41 4.13L4.13 2.41L5.57 3.40L6.46 3.03L6.78 1.31L9.22 1.31L9.54 3.03L10.43 3.40L11.87 2.41L13.59 4.13L12.60 5.57Z"/><circle cx="8" cy="8" r="2.2"/></svg>' }) : null,
          h('button', { class: 'icon small', title: 'הסתרה', 'aria-label': 'הסתרה', onclick: () => hideWithUndo(l.id), html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4l8 8M12 4l-8 8"/></svg>' })),
        h('div', { class: 'card-body' })));
    grid.append(c.el);
    renderCard(c);
    dragToSort(c.el);
    resizable(c.el, l);
  }
  if (!grid.children.length) grid.append(h('div', { class: 'empty sub' }, 'אין כרטיסים בלשונית הזאת. מוסיפים בכפתור +.'));
}

export function ctxFor(c) {
  return {
    id: c.mod.id,
    get s() { return cardSettings(c.mod.id, c.mod.defaults); },
    set: patch => { saveCard(c.mod.id, patch); },
    loc: S.loc,
    rerender: () => renderCard(c),
    /** Shows "updated HH:MM" in grey and a red dot after a failure, keeping the last data (as in HaFeed). */
    stale: (when, failed) => {
      const head = c.el?.querySelector('.card-head');
      if (!head) return;
      head.querySelector('.stale')?.remove();
      if (failed) head.querySelector('h2').after(h('span', { class: 'stale', title: 'המקור לא ענה' }, '● ', when ? 'מעודכן ל-' + hm(when) : ''));
    },
  };
}
// ---------- widgets ----------
// A card's widget content: its `widget(ctx)` (sync or async) -> { big, sub, rows: [[label, value]] }. The provider
// keeps the last push on disk and draws the Adaptive Card per size (src/widgets.rs).
const wdata = {};
let wtimer = 0;
export async function pushWidget(mod, ctx) {
  if (!mod.widget) return;
  try { wdata[mod.id] = { ...(await mod.widget(ctx)), at: Date.now() }; } catch (e) { log(`widget ${mod.id}: ${e.message}`); return; }
  clearTimeout(wtimer);
  // A POST body: the summaries with a week ahead are too long for an address.
  wtimer = setTimeout(() => fetch('widgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wdata) }).then(r => r.text()).then(widgetTapped).catch(() => {}), 500);
}
/** The coming 7 days' summaries for a date-bound widget (the learning, the calendar): the board may stay closed
 *  for days, and the provider then shows the one for now (src/widgets.rs, `ahead`). `at(moment, sunset)` -> the
 *  summary at that moment. Two moments a day: just after midnight and just after sunset. */
export async function ahead(at, extra = []) {
  const out = [];
  // More moments the card knows (shabbat: candle lighting and its end).
  for (const t of extra) if (t > Date.now() && t < Date.now() + 7 * 86400_000) out.push({ from: +t + 30_000, ...(await at(new Date(+t + 30_000), null)) });
  for (let d = 1; d < 8; d++) {
    const day = new Date(); day.setDate(day.getDate() + d - 1); day.setHours(0, 0, 30, 0);
    const z = S.loc ? await zmanim(day).catch(() => null) : null;
    if (d > 1) out.push({ from: +day, ...(await at(day, z?.sunset)) });
    if (z?.sunset) { const t = new Date(+z.sunset + 30_000); if (t > Date.now()) out.push({ from: +t, ...(await at(t, z.sunset)) }); }
  }
  return out.sort((a, b) => a.from - b.from);
}
/** A tap on a widget: the provider answers /widgets with that card's id, once. Show the card (its tab if needed),
 *  open it and bring it into view. */
function widgetTapped(id) {
  id = String(id || '').trim();
  const c = cards.get(id);
  if (!c) return;
  const l = layoutOf(id);
  if (l?.hidden) return;
  if ((S.tab || 'all') !== 'all' && groupOf(id) !== S.tab) { S.tab = 'all'; save(); window.dispatchEvent(new Event('haluach:tab')); drawGrid(); }
  toggleCard(id, true);
  requestAnimationFrame(() => cards.get(id)?.el?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { for (const c of cards.values()) { clearTimeout(c.timer); c.timer = 0; } return; }
  for (const c of cards.values()) if (c.el?.isConnected) renderCard(c);
  if (!document.hidden) fetch('widgets').then(r => r.text()).then(widgetTapped).catch(() => {});
});
/** Cards hidden from the board still feed their widgets: app.js calls this every few minutes. */
export function refreshWidgets() {
  for (const c of cards.values()) if (c.mod.widget && !c.el) pushWidget(c.mod, ctxFor(c));
}

// Cards are compact (the user: "מצומצמים ויתרחבו בהתאם ללחיצות"): one or two lines from the card's summary
// (`compact(ctx)`, else its widget summary), and a click opens the full card in place. The open ones are kept only
// while the board is open: closing it folds every card back.
const opened = new Set();
export function toggleCard(id, open = !opened.has(id)) {
  if (open) opened.add(id); else opened.delete(id);
  const c = cards.get(id);
  if (c?.el) {
    c.el.classList.toggle('open', open); c.el.querySelector('.card-head h2')?.setAttribute('aria-expanded', String(open));
    renderCard(c);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && opened.size && !keepOpen()) { const ids = [...opened]; opened.clear(); for (const id of ids) toggleCard(id, false); }
});
function compactView(sum, id) {
  // A row of short times ("הנץ 06:09 · ק"ש 07:44 ..."), for the zmanim card.
  if (sum.line) return h('button', { class: 'compact', title: 'פתיחה', onclick: () => toggleCard(id, true) },
    sum.sub ? h('span', { class: 'c-sub' }, sum.sub) : '',
    h('span', { class: 'c-times' }, ...sum.line.map(t => h('span', { class: t.past ? 'past' : '' }, h('small', {}, t.name), h('b', { class: 'num' }, t.at)))));
  // The widget summaries carry the place name and the Hebrew date (a widget stands alone); on the board both are in
  // the header already.
  const place = S.loc?.name || '', hd = document.getElementById('hdate'), hdate = hd && !hd.hidden ? hd.textContent : '';
  const sub = String(sum.sub || '').split(' · ').filter(x => x && x !== place && x !== hdate).join(' · ');
  sum = { ...sum, sub };
  const rows = (sum.rows || []).filter(r => (r?.[0] || r?.[1]) && String(r[1]) !== String(sum.big)).slice(0, 2);
  return h('button', { class: 'compact' + (sum.art ? ' with-art' : ''), title: 'פתיחה', onclick: () => toggleCard(id, true) },
    sum.art ? h('span', { class: 'c-art', html: sum.art }) : '',
    h('span', { class: 'c-line' }, sum.big ? h('span', { class: 'c-big' }, sum.big) : '', sum.sub ? h('span', { class: 'c-sub' }, sum.sub) : ''),
    rows.length ? h('span', { class: 'c-rows' }, ...rows.map(r => h('span', {}, r[0] ? r[0] + ' ' : '', h('b', {}, r[1] || '')))) : '');
}
const failed = c => h('div', { class: 'row' }, h('span', { class: 'sub' }, navigator.onLine ? 'לא הצלחנו לטעון את הכרטיס.' : 'אין חיבור לאינטרנט.'),
  h('button', { class: 'chip', onclick: e => { e.stopPropagation(); renderCard(c); } }, 'נסה שוב'));
export async function renderCard(c) {
  if (!c.el) return;
  // Any change of height (opened, folded, new data) grows to it instead of jumping (growFrom after the drawing).
  const card = c.el, h0 = card.offsetHeight;
  await drawCard(c);
  if (card.isConnected) growFrom(card, h0);
}
async function drawCard(c) {
  // Each drawing gets its own box: a slow one (folded or opened meanwhile) then writes into a box no longer shown.
  // It starts with what was shown, so a refresh does not flash empty.
  const holder = c.el.querySelector('.card-body'), prev = holder.firstElementChild;
  const body = h('div', { class: 'card-draw' }, ...(prev?.classList.contains('card-draw') ? prev.childNodes : holder.childNodes));
  holder.replaceChildren(body);
  clearTimeout(c.timer);
  // A card that needs a place (`needsLoc`) and there is none: only the place button, folded or open.
  if (c.mod.needsLoc && !S.loc) { c.el.classList.remove('compact-card'); body.replaceChildren(noPlace()); return; }
  const summarize = c.mod.compact || c.mod.widget;
  const compact = summarize && !opened.has(c.mod.id);
  c.el.classList.toggle('compact-card', !!compact);
  if (compact) {
    try {
      const sum = await summarize.call(c.mod, ctxFor(c));
      // `empty`: nothing set up yet; the full card has the button that adds the first one.
      if (sum && !sum.empty && (sum.big || sum.sub || sum.line)) body.replaceChildren(compactView(sum, c.mod.id));
      else await c.mod.render(body, ctxFor(c));
    } catch (e) { log(`card ${c.mod.id}: ${e.message}`); body.replaceChildren(failed(c)); }
  } else {
    try { await c.mod.render(body, ctxFor(c)); } catch (e) { log(`card ${c.mod.id}: ${e.message}`); body.replaceChildren(failed(c)); }
  }
  pushWidget(c.mod, ctxFor(c));
  // A hidden page sets no timer: on showing again every shown card draws once and its timer starts again.
  if (c.mod.every && !document.hidden) c.timer = setTimeout(() => renderCard(c), (typeof c.mod.every === 'function' ? c.mod.every(ctxFor(c)) : c.mod.every) * (sv('svSlow') ? 4 : 1));
}
/** A card's settings in the layer, by id (the wizard opens red alert's to pick the towns). */
export function openCardSettings(id) { const c = cards.get(id); if (c?.mod.settings) cardSettingsLayer(c); }
function cardSettingsLayer(c) {
  openLayer((body, close) => {
    body.append(h('h2', {}, 'הגדרות: ' + c.mod.title));
    const box = h('div', { class: 'form' });
    body.append(box);
    // Object.assign, not a spread: a spread would freeze the `s` getter, and the menu would read old settings.
    c.mod.settings(box, Object.assign(ctxFor(c), { done: () => { close(); renderCard(c); } }));
  }, c.el?.querySelector('.card-main'));
}
export function hide(id) {
  S.layout = S.layout.map(l => l.id === id ? { ...l, hidden: true } : l);
  save(); drawGrid();
}
/** The card's x: it folds away (no redraw of the board) and an undo bar shows for a few seconds. */
function hideWithUndo(id) {
  const c = cards.get(id), el = c?.el;
  S.layout = S.layout.map(l => l.id === id ? { ...l, hidden: true } : l);
  save();
  if (c) c.el = null;
  if (el) collapse(el);
  undoBar(`הכרטיס "${c?.mod.title || ''}" הוסתר`, () => vt(() => show(id)));
}
/** The bottom undo bar (decided with HaFeed: a raised surface, an accent "ביטול", --radius, 18px from the bottom). */
let undoEl = null;
/** A short note at the bottom (HaFeed's toast): "עודכן", "הועתק". */
export function note(text) { undoBar(text, null); }
export function undoBar(text, undo) {
  undoEl?.remove();
  clearTimeout(undoBar.t);
  const bar = h('div', { class: 'undo', role: 'status' }, h('span', {}, text),
    undo ? h('button', { class: 'undo-btn', onclick: () => { gone(); undo(); } }, 'ביטול') : '');
  const gone = () => { if (!bar.isConnected) return; if (calm.matches) return bar.remove(); bar.classList.add('out'); setTimeout(() => bar.remove(), 140); };
  document.body.append(bar);
  undoEl = bar;
  undoBar.t = setTimeout(gone, 6000);
}
export function show(id) {
  S.layout = S.layout.map(l => l.id === id ? { ...l, hidden: false } : l);
  save(); drawGrid();
}

/** Drag a card by its head to reorder. The card follows the pointer; a line on the card under it shows where it lands
 *  (no reordering while moving: the two columns would jump). Pointer capture + touch-action:none, so the board
 *  does not take the gesture as a scroll. */
/** A live drag to reorder (as HaFeed's settings): `el` follows the pointer, the other `items` step aside by its
 *  height, so the order shows before the release. The places are measured once (moving items do not change them).
 *  `done(to)` gets the new index among the others (-1: no move); `tap()` runs for a press with no drag. */
export function liveDrag(e, el, items, done, tap) {
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch {}
  const x0 = e.clientX, y0 = e.clientY, from = items.indexOf(el);
  const others = items.filter(x => x !== el), mids = others.map(x => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; });
  const H = el.getBoundingClientRect().height;
  let moved = false, to = -1;
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
    if (!moved) { moved = true; el.classList.add('dragging'); others.forEach(x => x.classList.add('shift')); }
    el.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
    to = mids.filter(m => m < ev.clientY).length;
    others.forEach((x, o) => {
      const j = items.indexOf(x);
      const dy = j > from && o < to ? -H : j < from && o >= to ? H : 0;
      x.style.transform = dy ? `translateY(${dy}px)` : '';
    });
  };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    if (!moved) { tap?.(); return; }
    // Everything is already where it will be: place the item, then drop the shifts with no animation.
    for (const x of items) { x.style.transition = 'none'; x.style.transform = ''; x.classList.remove('shift'); }
    el.classList.remove('dragging');
    if (to >= 0 && to !== from) { if (to < others.length) others[to].before(el); else others[others.length - 1].after(el); }
    void el.offsetHeight;
    for (const x of items) x.style.transition = '';
    done(to >= 0 && to !== from ? to : -1);
  };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
}
/** The height of an open card, by dragging its bottom corner (SPEC "שינוי גודל"); kept in the layout as px.
 *  A double click goes back to the content's own height. ponytail: height only; the board is one column ~400px. */
function resizable(el, l) {
  if (l.px) el.style.setProperty('--ch', l.px + 'px');
  const grip = h('div', { class: 'rsz', title: 'גרירה לשינוי הגובה. לחיצה כפולה: גובה רגיל', 'aria-hidden': 'true' });
  const keep = px => { S.layout = S.layout.map(x => x.id === l.id ? { ...x, px } : x); l.px = px; save(); };
  grip.addEventListener('dblclick', e => { e.stopPropagation(); el.style.removeProperty('--ch'); keep(undefined); });
  grip.addEventListener('pointerdown', e => {
    if (e.button) return;
    e.preventDefault(); e.stopPropagation();
    const body = el.querySelector('.card-body'), y0 = e.clientY, h0 = body.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);
    const move = ev => el.style.setProperty('--ch', Math.max(80, Math.round(h0 + ev.clientY - y0)) + 'px');
    const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); const v = parseInt(el.style.getPropertyValue('--ch')); if (v) keep(v); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
  });
  el.append(grip);
}
function dragToSort(el) {
  const head = el.querySelector('.card-head');
  head.addEventListener('pointerdown', e => {
    if (e.button || e.target.closest('button')) return;
    e.preventDefault();
    // A tap (no drag) opens or folds: the head captures the pointer, so the click lands on it and not on the h2.
    liveDrag(e, el, [...document.querySelectorAll('#grid > .card')], to => {
      if (to < 0) return;
      // The shown cards' new order goes into the slots they held in the saved order; hidden cards and other
      // tabs' cards keep their places. A raised card's place on screen is for now only: its slot stays as saved,
      // so the shown order is applied to the others only.
      const order = [...document.querySelectorAll('#grid > .card')].map(x => x.dataset.id).filter(id => !raised.includes(id));
      const shown = new Set(order), byId = new Map(S.layout.map(l => [l.id, l]));
      let i = 0;
      S.layout = S.layout.map(l => shown.has(l.id) ? byId.get(order[i++]) : l);
      save();
    }, () => toggleCard(el.dataset.id));
  });
}

// ---------- the look (as in HaFeed's "תצוגה"): classes and variables on <html> ----------
// theme: auto | light | dark. accent: 'win' (Windows' own) or a colour; accentShade -3..3. face: a font id.
// font (text size): s | m | l. density: roomy | normal | dense. width: column | wide. dateShow: both | heb | greg.
export function applyTheme() {
  const r = document.documentElement;
  if (S.theme === 'light' || S.theme === 'dark') r.dataset.theme = S.theme; else delete r.dataset.theme;
  for (const f of ['s', 'l']) r.classList.toggle('font-' + f, S.font === f);
  r.classList.toggle('roomy', S.density === 'roomy');
  r.classList.toggle('dense', S.density === 'dense');
  r.classList.toggle('wide', S.width === 'wide');
  applyFace();
  applyAccent();
  window.dispatchEvent(new Event('haluach:look'));
}
// The accent: Windows' colour (the provider reads it from the registry) or one the user chose, shaded per theme as
// Windows does (lighter on dark, darker on light, so text in it stays readable); "בהירות" moves it 8% a step.
export const ACCENTS = [['כחול', '#0078D4'], ['תכלת', '#0099BC'], ['טורקיז', '#00B294'], ['ירוק', '#10893E'], ['צהוב', '#C19C00'],
  ['כתום', '#F7630C'], ['אדום', '#E81123'], ['ורוד', '#E3008C'], ['סגול', '#8764B8'], ['אפור', '#69797E']];
export const isHex = v => /^#[0-9a-f]{6}$/i.test(v || '');
export function hexHsl(hex) {
  const [R, G, B] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, d = mx - mn;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  let hh = !d ? 0 : mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [Math.round(hh * 60 + 360) % 360, Math.round(s * 100), Math.round(l * 100)];
}
export function hslHex(hh, s, l) {
  s /= 100; l /= 100;
  const f = n => { const k = (n + hh / 30) % 12; return Math.round((l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0'); };
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
let winAccent = '';
export const windowsAccent = () => winAccent || '#0078D4';
export const accentBase = () => (isHex(S.accent) ? S.accent : winAccent);
export const isDark = () => S.theme === 'dark' || (S.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyAccent() {
  const r = document.documentElement.style, base = accentBase(), shade = S.accentShade || 0;
  if (!base && !shade) { r.removeProperty('--accent'); r.removeProperty('--on-accent'); return; }
  const [hh, s] = hexHsl(base || '#0078D4');
  const dark = isDark();
  const L = Math.max(15, Math.min(85, (dark ? 72 : 38) + shade * 8));
  r.setProperty('--accent', `hsl(${hh} ${Math.min(s, 90)}% ${L}%)`);
  // White on the accent, light or dark, as HaFeed (the user, 15.11.26, after a mockup: "כמו היום").
  r.setProperty('--on-accent', '#fff');
}
fetch('accent').then(x => x.text()).then(a => { if (isHex(a) && a !== winAccent) { winAccent = a; applyAccent(); window.dispatchEvent(new Event('haluach:look')); } }).catch(() => {});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAccent);
// Fonts: Segoe UI is the system's (never Segoe UI Variable); the others come from Google Fonts the first time they
// are picked (as in HaFeed).
export const FACES = [['segoe', 'Segoe UI', '', 'רגיל'], ['heebo', 'Heebo', 'Heebo:wght@400;600;700', 'היבו'],
  ['assistant', 'Assistant', 'Assistant:wght@400;600;700', 'אסיסטנט'], ['rubik', 'Rubik', 'Rubik:wght@400;600;700', 'רוביק'],
  ['frank', 'Frank Ruhl Libre', 'Frank+Ruhl+Libre:wght@400;600;700', 'פרנק רוהל']];
export function loadFace(id) {
  const f = FACES.find(x => x[0] === id);
  if (!f || !f[2] || document.getElementById('face-' + id)) return;
  document.head.append(h('link', { id: 'face-' + id, rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${f[2]}&display=swap` }));
}
function applyFace() {
  const f = FACES.find(x => x[0] === S.face) || FACES[0], r = document.documentElement.style;
  if (f[0] === 'segoe') { r.removeProperty('--font'); r.removeProperty('--num'); return; }
  loadFace(f[0]);
  r.setProperty('--font', `"${f[1]}", "Segoe UI", system-ui, sans-serif`);
  r.setProperty('--num', `"${f[1]}", "Segoe UI", system-ui, sans-serif`);
}
