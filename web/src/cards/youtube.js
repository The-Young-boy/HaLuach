// "ערוצי יוטיוב": the new videos of followed YouTube channels (the approach of a NetFree subscriptions browser extension: RSS per channel, an open check per video).
// Sources: only the channel's video feed (youtube.com/feeds/videos.xml, open in NetFree) and the thumbnails
// (i.ytimg.com, open). Never a Google sign-in or the YouTube API (both blocked in NetFree). Every video is checked
// against NetFree as the podcasts' episodes are (HEAD watch?v=, 418 = blocked). src/youtube.rs is the background port.
// A channel: { id (UC...), name, accounts: [labels] (none = []), notify }. A channel in two accounts is followed once.
import { h, proxied, BROWSER_UA, openLayer, openExternal, cardSettings, saveCard, log, hm, saving, undoBar } from '../core.js';
import { row, choice, select, section, more, toggle } from '../ui.js';
import { parseFeed, merge, epOpen, ago, ytGets } from './podcasts.js';

const MAX = 15;
const NEW_MS = 48 * 3_600_000; // a video older than this is never "new" (no alert), as src/youtube.rs
const DEFAULTS = { channels: [], everyMin: 60, show: 'open', reopen: false, shorts: false };
const s0 = ctx => ({ ...DEFAULTS, ...(ctx?.s || {}) });
const isId = x => /^UC[\w-]{22}$/.test(x);
const watch = id => `https://www.youtube.com/watch?v=${id}`;
const thumb = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const cut = (t, n = 40) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ---------- adding: a link, Google's export file, a saved page (pure) ----------
/** A pasted link or id -> { id } | { handle: true } (an @name link: its page is blocked in NetFree) | null. */
export function channelOf(raw) {
  const u = String(raw || '').trim();
  if (isId(u)) return { id: u };
  const m = u.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  if (m) return { id: m[1] };
  return /youtube\.com\/(@|c\/|user\/)|^@/.test(u) ? { handle: true } : null;
}
const csvLine = l => {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
};
/** Google Takeout's subscriptions.csv (Channel Id, Channel Url, Channel Title; the header may be translated) -> [{ id, name }]. */
export function parseTakeout(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const cols = csvLine(line), id = line.match(/UC[\w-]{22}/)?.[0];
    if (id && !out.has(id)) out.set(id, cols.filter(c => !c.includes(id)).pop()?.trim() || '');
  }
  return [...out].map(([id, name]) => ({ id, name }));
}
/** A saved youtube.com/feed/channels page -> [{ id, name }]: the channel renderers in its ytInitialData (as the
 *  that extension's page reader), else every "channelId" in it. */
export function parseSavedPage(html) {
  html = String(html);
  if (!html.includes('"channelId":"UC')) html = html.replace(/\\x([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
  const str = x => { try { return JSON.parse(`"${x}"`); } catch { return x; } };
  const out = new Map(), re = /"(?:gridChannelRenderer|channelRenderer)":\{/g;
  for (let m; (m = re.exec(html));) {
    const sl = html.slice(m.index, m.index + 6000);
    const id = sl.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
    if (!id) continue;
    const name = sl.match(/"title":\{"simpleText":"((?:\\.|[^"\\])+)"/)?.[1] ?? sl.match(/"title":\{"runs":\[\{"text":"((?:\\.|[^"\\])+)"/)?.[1];
    // The channel's picture (yt3.ggpht.com / yt3.googleusercontent.com, open in NetFree): the first thumbnail.
    const pic = sl.match(/"thumbnails":\[\{"url":"((?:https:)?\/\/yt3\.[^"]+)"/)?.[1];
    if (!out.get(id)?.name) out.set(id, { name: name ? str(name) : '', avatar: pic ? (pic.startsWith('//') ? 'https:' + pic : pic) : '' });
  }
  if (!out.size) for (const m of html.matchAll(/"channelId":"(UC[\w-]{22})"/g)) if (!out.has(m[1])) out.set(m[1], { name: '', avatar: '' });
  return [...out].map(([id, x]) => ({ id, ...x }));
}

// ---------- the last good data (localStorage) ----------
// { [channel id]: { at, tried, failed, name, eps: [{ id, title, t, first, open, short, unread, wait }] },
//   _at, _pending: [{ ch, id, at, reopen }] }
const DK = 'haluach.youtube.data';
export const loadData = () => { try { return JSON.parse(localStorage.getItem(DK) || '{}'); } catch { return {}; } };
const saveData = d => { try { localStorage.setItem(DK, JSON.stringify(d)); } catch {} };
const nameOf = (c, data) => (c.name && c.name !== c.id ? c.name : data[c.id]?.name) || c.id;
/** Marks videos read (pred(channel id, video)). bulk ("סימון הכל"): the ones still waiting for their alert stay. */
function markRead(pred, bulk = false) {
  const d = loadData(), wait = new Set(bulk ? (d._pending || []).filter(p => !p.reopen).map(p => p.id) : []);
  for (const k in d) if (!k.startsWith('_')) for (const v of d[k].eps || []) if (v.unread && !wait.has(v.id) && pred(k, v)) v.unread = false;
  saveData(d);
}

// ---------- fetching ----------
async function fetchChannel(id) {
  // The extra parameter makes the provider fetch again instead of answering from its cache (as podcasts.js).
  const f = parseFeed(await proxied(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}&r=${Date.now() % 1e6}`, { as: 'text', headers: [BROWSER_UA] }));
  return { name: f.name, eps: f.eps.sort((a, b) => b.t - a.t).slice(0, MAX).map(e => ({ id: e.id, title: e.title, t: e.t })) };
}
/** shorts/<id>: a regular video redirects to /watch. 200 = a short; no answer = unknown (asked again). */
async function isShort(id) {
  try {
    const [st] = (await proxied(`https://www.youtube.com/shorts/${id}`, { method: 'HEAD', cache: false, as: 'text', headers: [BROWSER_UA], follow: false })).split(' ');
    return +st === 200;
  } catch { return null; }
}
const YT = { kind: 'ytp' };
/** Checks the newest unchecked videos (open in NetFree; a short, when filtered) and re-checks blocked ones waiting for "נפתח",
 *  at most 30 per poll, newest first. Returns the ones that opened since the last check: [{ c, v }]. */
async function check(chs, data, s) {
  const todo = [];
  for (const c of chs) {
    for (const v of (data[c.id]?.eps || []).slice(0, 10)) {
      const open = v.open == null || (v.open === false && v.wait), short = s.shorts && v.short == null;
      if (open || short) todo.push({ c, v, open, short });
    }
  }
  todo.sort((a, b) => (a.v.open === false) - (b.v.open === false) || b.v.t - a.v.t);
  const reopened = [];
  let gets = 0; // whole watch pages (no HEAD through the provider): at most a few per round
  await Promise.all([0, 1, 2, 3].map(async w => {
    for (let i = w; i < Math.min(todo.length, 30); i += 4) {
      const x = todo[i];
      if (x.short) { const sh = await isShort(x.v.id); if (sh != null) x.v.short = sh; }
      if (!x.open) continue;
      if (ytGets() && ++gets > 4) continue;
      const was = x.v.open, now = await epOpen(YT, x.v, true);
      if (now == null) continue;
      x.v.open = now;
      x.v.checked = Date.now();
      if (was === false && now) reopened.push(x);
    }
  }));
  return reopened;
}

let busy = null;
/** Fetches every channel whose data is older than the interval (force = all), 6 at a time. One run at a time.
 *  step(): called about once a second while it runs, after the data so far is saved (the card draws it meanwhile:
 *  a first import of many channels takes a while). */
let stepNow = null;
function refresh(chs, s, force = false, step = null) {
  if (step) stepNow = step;
  return busy ||= (async () => {
    const data = loadData(), now = Date.now();
    const due = chs.filter(c => force || !data[c.id] || now - (data[c.id].tried || 0) > s.everyMin * 60_000 - 30_000);
    let i = 0, last = Date.now(), batch = [];
    const reopen = [];
    await Promise.all([0, 1, 2, 3, 4, 5].map(async () => {
      while (i < due.length) {
        const c = due[i++];
        try {
          // Not seen for 48 hours (the app was off): a silent seed, as a first fetch.
          const t0 = Date.now(), seed = t0 - Math.max(data[c.id]?.tried || 0, data[c.id]?.at || 0) >= NEW_MS;
          const { entry, added } = merge(data[c.id], await fetchChannel(c.id), t0);
          entry.eps = entry.eps.slice(0, MAX);
          const fresh = seed ? [] : entry.eps.filter(v => added.includes(v.id) && t0 - v.t < NEW_MS);
          for (const v of fresh) v.unread = true;
          data[c.id] = entry;
          if (c.notify) data._pending = [...(data._pending || []), ...fresh.map(v => ({ ch: c.id, id: v.id, at: t0 }))].slice(-100);
        } catch (e) {
          data[c.id] = { eps: [], ...(data[c.id] || {}), tried: Date.now(), failed: true };
          log(`youtube ${c.id}: ${e.message}`);
        }
        // While the card waits (a first import of many channels): every 12 channels, check those for NetFree at once,
        // so open videos show before the last feed is in.
        if (stepNow) batch.push(c);
        if (stepNow && batch.length >= 12) { const b = batch; batch = []; try { reopen.push(...await check(b, data, s)); } catch {} }
        if (stepNow && Date.now() - last > 1000) { last = Date.now(); saveData(data); try { stepNow(i, due.length); } catch {} }
      }
    }));
    if (stepNow && due.length) { saveData(data); try { stepNow(due.length, due.length); } catch {} }
    if (due.length || chs.some(c => (data[c.id]?.eps || []).slice(0, 10).some(v => v.open == null))) {
      try { for (const x of [...reopen, ...await check(chs, data, s)]) if (x.v.wait) data._pending = [...(data._pending || []), { ch: x.c.id, id: x.v.id, at: Date.now(), reopen: true }]; } catch (e) { log('youtube open check: ' + e.message); }
    }
    // Read meanwhile (a click while this ran) stays read; removed channels go.
    const cur = loadData(), ids = new Set(chs.map(c => c.id));
    for (const k of Object.keys(data)) {
      if (k.startsWith('_')) continue;
      if (!ids.has(k)) { delete data[k]; continue; }
      for (const v of data[k].eps || []) if (cur[k]?.eps?.find(x => x.id === v.id)?.unread === false) v.unread = false;
    }
    data._at = now;
    saveData(data);
    return chs.some(c => data[c.id]?.failed);
  })().finally(() => { busy = null; stepNow = null; });
}

/** For app.js liveChecks: fetches what is due and returns the alerts to send once: [{ id, title, body, url }].
 *  Only channels with their switch on; on shabbat the provider drops them. */
export async function checkAll() {
  // Once a day: each signed-in account's subscriptions again (a channel subscribed on YouTube since comes in).
  const bg = { get s() { return cardSettings('youtube', DEFAULTS); }, set: p => saveCard('youtube', p), rerender() {} };
  for (const g of google(bg)) {
    if (Date.now() - (g.at || 0) < 864e5) continue;
    // Marked first: signed out or no answer is tried again tomorrow, not on every round.
    bg.set({ google: google(bg).map(x => x.n === g.n ? { ...x, at: Date.now() } : x) });
    try { await importAccount(bg, g.n); } catch (e) { log('youtube subs: ' + e.message); }
  }
  const s = { ...DEFAULTS, ...cardSettings('youtube', DEFAULTS) }, chs = s.channels || [];
  if (!chs.length) return [];
  await refresh(chs, s);
  const data = loadData(), out = [], keep = [];
  for (const p of data._pending || []) {
    const c = chs.find(x => x.id === p.ch), v = data[p.ch]?.eps?.find(e => e.id === p.id);
    if (!c?.notify || !v || !v.unread) continue;
    const young = Date.now() - p.at < 2 * 864e5;
    if (s.shorts && v.short !== false) { if (v.short == null && young) keep.push(p); continue; }
    if (s.show !== 'all' && !p.reopen) {
      if (v.open == null) { if (young) keep.push(p); continue; }
      if (v.open === false) { if (s.reopen) v.wait = true; continue; }
    }
    if (p.reopen && !s.reopen) continue;
    if (p.reopen) v.wait = false;
    else if (Date.now() - v.t >= NEW_MS) continue;
    // The same ids as src/youtube.rs (yt-<video id>, yt-<video id>-o): the page and the background never send one twice.
    const name = nameOf(c, data);
    out.push({ id: `yt-${p.id}${p.reopen ? '-o' : ''}`, title: p.reopen ? `נפתח: ${v.title}` : name, body: p.reopen ? name : v.title, url: watch(p.id) });
  }
  data._pending = keep;
  saveData(data);
  return out;
}

// ---------- the card ----------
/** Shown: by default only videos found open; shorts hidden when filtered. */
const visible = (v, s) => (s.show === 'all' || v.open === true) && !(s.shorts && v.short === true);
function videos(chs, data, s) {
  return chs.flatMap(c => (data[c.id]?.eps || []).filter(v => visible(v, s)).map(v => ({ c, v }))).sort((a, b) => b.v.t - a.v.t);
}
const svg = d => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">${d}</svg>`;
const X = svg('<path d="M4 4l8 8M12 4l-8 8"/>');

function vidRow({ c, v }, data, after, showName = true) {
  const dot = v.unread ? h('span', { class: 'pod-dot', title: 'חדש' }) : '';
  const open = () => {
    markRead((_, x) => x.id === v.id);
    if (dot) dot.remove();
    openExternal(watch(v.id));
    after?.();
  };
  return h('div', { class: 'item pod-it yt-it', role: 'button', tabindex: 0, title: v.title, onclick: open, onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } } },
    saving() ? '' : h('img', { class: 'yt-th lazyfade', src: thumb(v.id), alt: '', width: 64, height: 36, loading: 'lazy', onload: e => e.target.classList.add('in') }),
    h('div', {},
      h('div', { class: 'lab' }, dot, showName ? nameOf(c, data) : '', v.open === false ? h('span', { class: 'faint' }, showName ? ' · חסום' : 'חסום') : ''),
      h('div', { class: 'val', dir: 'auto' }, v.title || 'סרטון')),
    h('span', { class: 'end faint' }, ago(v.t)));
}

function allLayer(ctx) {
  openLayer(body => {
    const paint = () => {
      const s = s0(ctx), data = loadData();
      const per = s.channels.map(c => ({ c, list: (data[c.id]?.eps || []).filter(v => visible(v, s)).map(v => ({ c, v })) }))
        .map(x => ({ ...x, n: x.list.filter(y => y.v.unread).length, t: x.list[0]?.v.t || 0 }))
        .sort((a, b) => (b.n > 0) - (a.n > 0) || b.t - a.t);
      const shown = per.filter(x => x.list.length), n = per.reduce((a, x) => a + x.n, 0);
      const markAll = pred => { markRead(pred, true); paint(); ctx.rerender(); };
      body.replaceChildren(h('h2', {}, 'כל הסרטונים'),
        n ? h('button', { class: 'link yt-mark', onclick: () => markAll(() => true) }, 'סימון הכל כנקרא') : '',
        ...shown.map(({ c, list, n: k }) => h('details', {},
          h('summary', {}, nameOf(c, data), ' ', h('span', { class: 'faint num' }, k ? `${k} חדשים` : list.length), data[c.id]?.failed ? h('span', { class: 'faint' }, ' · לא ענה', data[c.id].at ? `, מעודכן ל-${hm(new Date(data[c.id].at))}` : '') : ''),
          h('div', { class: 'list' }, ...list.map(x => vidRow(x, data, () => ctx.rerender(), false)),
            k ? h('button', { class: 'link yt-mark', onclick: () => markAll(id => id === c.id) }, 'סימון כנקרא') : ''))),
        shown.length < per.length ? h('div', { class: 'faint yt-tip' }, `${per.length - shown.length} ערוצים בלי סרטונים ${s.show === 'all' ? '' : 'פתוחים '}עדיין`) : '',
        h('hr', { class: 'sep' }), h('button', { class: 'more', onclick: () => addLayer(ctx) }, 'הוספת ערוצים'));
    };
    paint();
  });
}

const accs = c => c.accounts || [];
/** Adds channels to the followed list; an existing one keeps its name and switch, and gets the account too. */
function addChannels(ctx, list, account, notify) {
  const chs = [...s0(ctx).channels];
  let added = 0;
  for (const x of list) {
    const i = chs.findIndex(c => c.id === x.id);
    if (i < 0) { chs.push({ id: x.id, name: x.name || x.id, ...(x.avatar ? { avatar: x.avatar } : {}), accounts: account ? [account] : [], notify }); added++; }
    else {
      if (account && !accs(chs[i]).includes(account)) chs[i] = { ...chs[i], accounts: [...accs(chs[i]), account] };
      if (x.avatar && chs[i].avatar !== x.avatar) chs[i] = { ...chs[i], avatar: x.avatar };
    }
  }
  ctx.set({ channels: chs });
  ctx.rerender();
  return { added, had: list.length - added };
}

// ---------- Google accounts (ytlogin.rs): s.google = [{ n, label }]; a channel's accounts hold the label ----------
const google = ctx => s0(ctx).google || [];
/** The subscriptions of a signed-in account, added under its label. false = signed out. */
async function importAccount(ctx, n) {
  const r = await fetch(`ytlogin?do=subs&acc=${n}`);
  if (r.status === 401) return false;
  if (!r.ok) throw new Error('subs ' + r.status); // no answer: not signed out
  const list = parseSavedPage(await r.text());
  const g = { ...(google(ctx).find(x => x.n === n) || { n, label: `חשבון ${n}` }), at: Date.now() };
  ctx.set({ google: [...google(ctx).filter(x => x.n !== n), g] });
  // A new subscription gets alerts when every channel of this account already has them.
  const mine = s0(ctx).channels.filter(c => accs(c).includes(g.label));
  return addChannels(ctx, list, g.label, mine.length > 0 && mine.every(c => c.notify));
}
/** Sign in to account n in an Edge window (a new account when n is empty), then import its subscriptions. */
async function signIn(ctx, out, n) {
  n = n || String(Math.max(0, ...google(ctx).map(x => +x.n)) + 1);
  await fetch(`ytlogin?do=start&acc=${n}`);
  out.textContent = 'מתחברים בחלון שנפתח, ובסוף סוגרים אותו.';
  const until = Date.now() + 16 * 60_000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 2000));
    let st; try { st = await fetch('ytlogin?do=status').then(r => r.json()); } catch { continue; }
    if (st.pending.includes(n)) continue;
    if (st.failed[n]) { out.textContent = st.failed[n]; return; }
    if (!st.signed.includes(n)) { out.textContent = 'ההתחברות לא הושלמה.'; return; }
    out.textContent = 'טוען את המינויים...';
    const r = await importAccount(ctx, n).catch(() => null);
    out.textContent = !r ? 'לא הצלחנו לטעון את המינויים.' : `נוספו ${r.added} ערוצים` + (r.had ? `, ${r.had} כבר היו במעקב` : '') + '.';
    return;
  }
  out.textContent = 'עבר הזמן להתחברות.';
}
const avatar = c => c.avatar && !saving() ? h('img', { class: 'yt-av lazyfade', src: c.avatar, alt: '', width: 24, height: 24, loading: 'lazy', referrerpolicy: 'no-referrer', onload: e => e.target.classList.add('in'), onerror: e => e.target.remove() }) : '';

function addLayer(ctx) {
  openLayer(body => {
    // 1. A link or an id.
    const input = h('input', { type: 'url', placeholder: 'קישור לערוץ', 'aria-label': 'קישור לערוץ' });
    const status = h('div', { class: 'sub pod-status' });
    const add = async () => {
      const r = channelOf(input.value);
      if (!r) { status.textContent = 'זה לא קישור לערוץ.'; return; }
      if (r.handle) { status.textContent = 'קישור עם @ לא נפתח בנטפרי. בדף הערוץ: "שיתוף ערוץ" > "העתקת מזהה הערוץ", והדביקו כאן.'; return; }
      if (s0(ctx).channels.some(c => c.id === r.id)) { status.textContent = 'כבר במעקב.'; return; }
      status.textContent = 'בודק...';
      let f;
      try { f = await fetchChannel(r.id); } catch { status.textContent = 'הערוץ לא נמצא.'; return; }
      const d = loadData();
      d[r.id] = merge(null, f).entry;
      saveData(d);
      addChannels(ctx, [{ id: r.id, name: f.name }], '', true);
      input.value = '';
      status.textContent = `נוסף: ${f.name || r.id}`;
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });

    // 2 + 3. Google's export file, or the saved subscriptions page; both under an account name.
    const acct = h('input', { type: 'text', placeholder: 'שם החשבון (לא חובה)', 'aria-label': 'שם החשבון' });
    const done = h('div', { class: 'sub pod-status' });
    const picker = (accept, parse) => {
      const i = h('input', { type: 'file', accept, hidden: true });
      i.addEventListener('change', async () => {
        const f = i.files?.[0];
        i.value = '';
        if (!f) return;
        let list = [];
        try { list = parse(await f.text()); } catch {}
        if (!list.length) { done.textContent = 'לא נמצאו ערוצים בקובץ הזה.'; return; }
        const r = addChannels(ctx, list, acct.value.trim(), false);
        done.textContent = `נוספו ${r.added} ערוצים` + (r.had ? `, ${r.had} כבר היו במעקב` : '') + '.';
      });
      return i;
    };
    const csv = picker('.csv,text/csv', parseTakeout), page = picker('.html,.htm,text/html', parseSavedPage);
    const gOut = h('div', { class: 'sub pod-status' });
    body.append(h('h2', {}, 'הוספת ערוצים'),
      h('div', { class: 'yt-btns' }, h('button', { class: 'btn primary', onclick: () => signIn(ctx, gOut) }, google(ctx).length ? 'הוספת חשבון גוגל' : 'התחברות לחשבון גוגל')),
      h('div', { class: 'faint yt-tip' }, 'המינויים של החשבון נכנסים לכאן. אפשר לחבר כמה חשבונות.'), gOut,
      section('ערוץ אחד'),
      h('div', { class: 'pod-add' }, input, h('button', { class: 'btn primary', onclick: add }, 'הוספה')), status,
      section('עוד דרכים לייבא'), acct,
      h('div', { class: 'faint yt-tip' }, 'מהורדת הנתונים של גוגל: קובץ המינויים (subscriptions.csv).'),
      h('div', { class: 'yt-btns' }, h('button', { class: 'btn', onclick: () => csv.click() }, 'בחירת קובץ'), csv),
      h('div', { class: 'faint yt-tip' }, '1. פתחו את דף המינויים בדפדפן, מחוברים לחשבון.', h('br'), '2. שמרו אותו (Ctrl+S, "דף אינטרנט, HTML בלבד") ובחרו אותו כאן.'),
      h('div', { class: 'yt-btns' }, h('button', { class: 'btn', onclick: () => openExternal('https://www.youtube.com/feed/channels') }, 'פתיחת דף המינויים'),
        h('button', { class: 'btn', onclick: () => page.click() }, 'בחירת הדף השמור'), page),
      done);
  });
}

export default {
  id: 'youtube',
  title: 'ערוצי יוטיוב',
  size: [1, 3],
  defaults: DEFAULTS,
  every: ctx => Math.max(15, ctx.s.everyMin || 60) * 60_000,
  async render(el, ctx) {
    const s = s0(ctx), chs = s.channels;
    if (!chs.length) {
      el.replaceChildren(h('div', { class: 'sub' }, 'אין ערוצים במעקב.'), h('button', { class: 'btn pod-empty', onclick: () => addLayer(ctx) }, 'הוספת ערוצים'));
      return;
    }
    const draw = (failed, done, prog = '') => {
      const data = loadData(), list = videos(chs, data, s), n = list.filter(x => x.v.unread).length;
      const empty = !done ? 'טוען' + (prog ? ` ערוצים: ${prog}` : '') + '...' : failed && !list.length ? 'הערוצים לא ענו.' : 'אין סרטונים פתוחים עדיין.';
      el.replaceChildren(
        n ? h('div', { class: 'yt-head' }, h('span', { class: 'sub' }, h('span', { class: 'num' }, n), ' חדשים'),
          h('button', { class: 'link', onclick: () => { markRead(() => true, true); ctx.rerender(); } }, 'סימון הכל כנקרא')) : '',
        ...(list.length ? list.slice(0, 5).map(x => vidRow(x, data, () => ctx.rerender())) : [h('div', { class: 'sub' }, empty)]),
        h('button', { class: 'more', onclick: () => allLayer(ctx) }, 'כל הסרטונים'));
      const oks = chs.map(c => data[c.id]?.at).filter(Boolean);
      ctx.stale(oks.length ? new Date(Math.min(...oks)) : null, failed);
    };
    draw(false, false);
    let failed = false;
    try { failed = await refresh(chs, s, false, (i, n) => draw(false, false, `${i} מתוך ${n}`)); } catch (e) { failed = true; log('youtube: ' + e.message); }
    draw(failed, true);
  },
  compact(ctx) { return s0(ctx).channels.length ? this.widget(ctx) : null; },
  async widget(ctx) {
    try {
      const s = s0(ctx), chs = s.channels;
      if (!chs.length) return { big: '', sub: 'אין ערוצים במעקב', rows: [] };
      let data = loadData();
      // Nothing fetched yet (a first import of many channels takes a while): say so now, fetch meanwhile, draw after.
      if (!data._at && ctx?.rerender) {
        if (!busy) refresh(chs, s, false, () => ctx.rerender()).catch(() => {}).finally(() => ctx.rerender());
        const k = chs.filter(c => data[c.id]).length;
        if (!videos(chs, data, s).length) return { big: '', sub: k >= chs.length ? 'בודק אילו סרטונים פתוחים...' : k ? `טוען ערוצים: ${k} מתוך ${chs.length}...` : 'טוען את הערוצים...', rows: [] };
      } else if (!data._at || Date.now() - data._at > s.everyMin * 60_000) { try { await refresh(chs, s); } catch {} data = loadData(); }
      const list = videos(chs, data, s), n = list.filter(x => x.v.unread).length;
      return {
        big: n ? `${n} חדשים` : '',
        sub: list[0] ? cut(`${nameOf(list[0].c, data)}: ${list[0].v.title}`, 60) : 'אין סרטונים עדיין',
        // The first one is the sub line already.
        rows: list.slice(1, 5).map(x => [nameOf(x.c, data), cut(x.v.title), !!x.v.unread]),
        // One summary per channel, for a widget set (התאמה אישית) to one of them.
        per: Object.fromEntries(chs.map(c => {
          const vs = list.filter(x => x.c.id === c.id), k = vs.filter(x => x.v.unread).length;
          return [c.id, { name: nameOf(c, data), big: k ? `${k} חדשים` : '', sub: vs[0] ? cut(vs[0].v.title, 60) : 'אין סרטונים עדיין',
            rows: vs.slice(1, 4).map(x => [cut(x.v.title), '', !!x.v.unread]) }];
        })),
      };
    } catch { return { big: '', sub: 'אין נתוני יוטיוב', rows: [] }; }
  },
  settings(box, ctx) {
    const data = loadData();
    const chans = h('div', { class: 'form' }), accts = h('div', { class: 'form' });
    const setChs = chs => { ctx.set({ channels: chs }); ctx.rerender(); draw(); };
    const draw = () => {
      const chs = s0(ctx).channels;
      const names = [...new Set(chs.flatMap(c => accs(c).length ? accs(c) : ['']))].sort((a, b) => !a - !b || a.localeCompare(b, 'he'));
      const inAcc = a => chs.filter(c => a ? accs(c).includes(a) : !accs(c).length), count = a => inAcc(a).length;
      // The channels, by account: a switch for "a new video" alerts, and removal.
      // A group open before a redraw stays open (its summary's first text = the account).
      const wasOpen = new Set([...chans.querySelectorAll('details[open] > summary')].map(x => x.firstChild?.textContent));
      chans.replaceChildren(...(chs.length ? names.map(a => h('details', { open: wasOpen.has(a || 'בלי חשבון') },
        h('summary', {}, a || 'בלי חשבון', ' ', h('span', { class: 'faint num' }, count(a))),
        h('div', { class: 'form' },
          // An import arrives with alerts off (no flood): one switch turns them on for the whole group.
          ...(count(a) > 1 ? toggle('התראות מכל הערוצים כאן', inAcc(a).every(c => c.notify), v => {
            const ids = new Set(inAcc(a).map(c => c.id));
            setChs(s0(ctx).channels.map(c => ids.has(c.id) ? { ...c, notify: v } : c));
          }) : []),
          ...inAcc(a).map(c => h('div', { class: 'srow' },
          h('span', { class: 'pod-show-name yt-ch' }, avatar(c), nameOf(c, data)),
          h('span', { class: 'pod-show-ctl' },
            h('input', { type: 'checkbox', checked: !!c.notify, title: 'התראה על סרטון חדש', 'aria-label': 'התראה על סרטון חדש: ' + nameOf(c, data),
              onchange: e => ctx.set({ channels: s0(ctx).channels.map(x => x.id === c.id ? { ...x, notify: e.target.checked } : x) }) }),
            h('button', { class: 'icon', title: 'הסרה מהמעקב', 'aria-label': 'הסרה מהמעקב', html: X, onclick: () => setChs(s0(ctx).channels.filter(x => x.id !== c.id)) })))))))
        : [h('div', { class: 'sub' }, 'אין ערוצים במעקב.')]));
      // The accounts: rename, or remove with its channels (one that is in another account too stays), with "ביטול".
      const named = names.filter(Boolean);
      accts.replaceChildren(...(named.length ? named.map(a => h('div', { class: 'srow' },
        h('input', { type: 'text', value: a, 'aria-label': 'שם החשבון', class: 'yt-acct',
          onchange: e => { const v = e.target.value.trim(); if (!v) { e.target.value = a; return; } if (v !== a) ctx.set({ google: google(ctx).map(g => g.label === a ? { ...g, label: v } : g) }); if (v !== a) setChs(s0(ctx).channels.map(c => accs(c).includes(a) ? { ...c, accounts: [...new Set(accs(c).map(x => x === a ? v : x).filter(Boolean))] } : c)); } }),
        h('span', { class: 'pod-show-ctl' }, h('span', { class: 'faint' }, h('span', { class: 'num' }, count(a)), ' ערוצים'),
          ...gButtons(a),
          h('button', { class: 'icon', title: 'הסרת החשבון וערוציו', 'aria-label': 'הסרת החשבון ' + a, html: X, onclick: () => {
            const before = new Map(s0(ctx).channels.filter(c => accs(c).includes(a)).map(c => [c.id, c]));
            setChs(s0(ctx).channels.map(c => before.has(c.id) ? { ...c, accounts: accs(c).filter(x => x !== a) } : c).filter(c => !before.has(c.id) || accs(c).length));
            undoBar(`החשבון "${a}" הוסר`, () => { const now = s0(ctx).channels.filter(c => !before.has(c.id)); setChs([...now, ...before.values()]); });
          } }))))
        : [h('div', { class: 'sub' }, 'אין חשבונות. מחברים חשבון גוגל ב"הוספת ערוצים".')]));
      acctBox.querySelector('summary .num').textContent = named.length;
    };
    // A Google account: re-read its subscriptions, or sign out (its channels go as with removal, with "ביטול").
    const gOut = h('div', { class: 'sub pod-status' });
    const gButtons = a => {
      const g = google(ctx).find(x => x.label === a);
      if (!g) return [];
      return [h('button', { class: 'link', onclick: async () => {
          gOut.textContent = 'טוען את המינויים...';
          const r = await importAccount(ctx, g.n).catch(() => null);
          if (r === false) return signIn(ctx, gOut, g.n);
          gOut.textContent = !r ? 'לא הצלחנו לטעון את המינויים.' : `נוספו ${r.added} ערוצים.`; draw();
        } }, 'רענון'),
        h('button', { class: 'link', onclick: async () => {
          await fetch(`ytlogin?do=logout&acc=${g.n}`).catch(() => {});
          ctx.set({ google: google(ctx).filter(x => x.n !== g.n) });
          const before = new Map(s0(ctx).channels.filter(c => accs(c).includes(a)).map(c => [c.id, c]));
          setChs(s0(ctx).channels.map(c => before.has(c.id) ? { ...c, accounts: accs(c).filter(x => x !== a) } : c).filter(c => !before.has(c.id) || accs(c).length));
          undoBar(`התנתקת מ"${a}"`, () => { const now = s0(ctx).channels.filter(c => !before.has(c.id)); setChs([...now, ...before.values()]); });
        } }, 'התנתקות')];
    };
    const acctBox = h('details', {}, h('summary', {}, 'חשבונות', ' ', h('span', { class: 'faint num' })), accts);
    draw();
    const s = s0(ctx);
    // "התראה כשסרטון נפתח" matters only while blocked videos are hidden ("רק פתוחים").
    const reo = toggle('התראה כשסרטון נפתח', s.reopen, v => ctx.set({ reopen: v }), 'סרטון שהיה חסום ונפתח אחר כך');
    reo.forEach(d => { d.classList.add('dep'); d.hidden = s.show !== 'open'; });
    box.append(section('במעקב'), chans,
      h('div', { class: 'hint' }, 'המתג ליד ערוץ: התראה על סרטון חדש. בשבת ובחג לא יוצאת'),
      acctBox, gOut,
      h('button', { class: 'btn', onclick: () => addLayer(ctx) }, 'הוספת ערוצים'),
      section('הצגה'),
      row('אילו סרטונים', choice([['open', 'רק פתוחים'], ['all', 'הכל']], s.show, v => { ctx.set({ show: v }); reo.forEach(d => { d.hidden = v !== 'open'; }); ctx.rerender(); }), 'הכל = גם חסומים בנטפרי'),
      ...reo,
      ...toggle('בלי סרטונים קצרים', s.shorts, v => { ctx.set({ shorts: v }); ctx.rerender(); }),
      more(row('בדיקת סרטונים חדשים', select([[30, 'כל חצי שעה'], [60, 'כל שעה'], [180, 'כל 3 שעות'], [360, 'כל 6 שעות'], [720, 'פעמיים ביום']], s.everyMin, v => ctx.set({ everyMin: +v })))));
  },
};

export const css = `
.yt-it { align-items: center; gap: 8px; }
.yt-ch { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.yt-av { width: 24px; height: 24px; flex: none; border-radius: 50%; object-fit: cover; background: var(--fill); }
.yt-th { width: 64px; height: 36px; flex: none; border-radius: var(--radius-s); object-fit: cover; background: var(--fill); }
.yt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.yt-mark { display: block; margin: 4px 0; }
.yt-tip { font-size: 12.5px; margin: 8px 0 4px; }
.yt-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.yt-acct { flex: 1; min-width: 0; }
.expand-body > input[type=text] { width: 100%; }
`;
