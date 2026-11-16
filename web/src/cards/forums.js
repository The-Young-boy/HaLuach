// "פורומים": notifications from the user's forums (SPEC "התראות מפורומים", research/forums.md). The provider does
// the work (src/forums.rs): it keeps the login (an Edge window, or a username and password kept encrypted on this
// PC only), checks each forum on the card's interval and shows a Windows toast for each new notification.
// The page only shows the state (forum?do=list) and sends the user's choices.
import { h, openLayer, openExternal, log, openCardSettings } from '../core.js';
import { row, select, section, more } from '../ui.js';

const DEFAULTS = { interval: 5, notify: {} };
const CHAT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>';

async function call(q, init) {
  const r = await fetch('forum?' + q, init);
  if (!r.ok) throw new Error(`${r.status} forum ${q.split('&')[0]}`);
  return r.json();
}
const list = () => call('do=list');

const cut = (t, n) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** "14:05" today, "3.11" before. */
export function when(ms, now = new Date()) {
  if (!ms) return '';
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${d.getDate()}.${d.getMonth() + 1}`;
}
const errOf = f => f.err || '';
const unreadOf = f => (f.unread || 0);

/** The rows the card shows: up to 3 forums, then the newest unread notifications, 6 rows in all. */
export function plan(forums) {
  const on = forums.filter(f => f.connected);
  const ranked = [...on].sort((a, b) => (!!errOf(b) - !!errOf(a)) || unreadOf(b) + (b.chats || 0) - unreadOf(a) - (a.chats || 0));
  const heads = on.length <= 3 ? ranked : ranked.filter(f => errOf(f) || unreadOf(f) || f.chats).slice(0, 3);
  const items = on.flatMap(f => (f.items || []).filter(i => i.unread).map(i => ({ ...i, forum: f })))
    .sort((a, b) => b.at - a.at);
  return { on, heads, items: items.slice(0, Math.max(0, 6 - heads.length)), allItems: items };
}

/** The widget: big = all unread (notifications and chats), sub = the newest one, rows = forum -> unread. */
export function widgetSummary(forums) {
  const { on, allItems } = plan(forums);
  if (!on.length) return { big: '', sub: 'לא מחוברים לפורום', rows: [] };
  const total = on.reduce((n, f) => n + unreadOf(f) + (f.chats || 0), 0);
  const top = allItems[0];
  return {
    big: String(total),
    sub: top ? cut(`${top.forum.name}: ${top.text}`, 80) : total ? '' : 'אין התראות חדשות',
    rows: [...on].sort((a, b) => unreadOf(b) - unreadOf(a)).map(f => [f.name, errOf(f) ? 'צריך להתחבר' : String(unreadOf(f)), !!(unreadOf(f) || errOf(f))]),
  };
}

function count(f) {
  if (errOf(f)) return h('span', { class: 'down' }, cut(errOf(f), 22));
  return h('span', { class: 'fo-n' },
    h('b', { class: 'num' }, String(unreadOf(f))),
    f.chats ? h('span', { class: 'fo-chat', title: 'צ׳אטים שלא נקראו' }, h('span', { html: CHAT }), h('span', { class: 'num' }, String(f.chats))) : '');
}
function forumRow(f, onclick) {
  return h('div', { class: 'row fo-click', role: 'button', tabindex: 0, onclick, onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onclick(); } } },
    h('span', {}, f.name), count(f));
}
function itemRow(i, name) {
  const go = () => openExternal(i.url);
  return h('div', { class: 'item fo-click', role: 'button', tabindex: 0, title: i.text, onclick: go, onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(); } } },
    h('div', { class: 'fo-txt' }, h('div', { class: 'lab' }, name ? `${name} · ${when(i.at)}` : when(i.at)), h('div', { class: 'val' + (i.unread ? '' : ' fo-read') }, i.text)));
}

/** The layer: every connected forum with its last notifications (or one forum). */
function allLayer(forums, only) {
  openLayer(body => {
    body.append(h('h2', {}, only ? only.name : 'התראות מהפורומים'));
    for (const f of only ? [only] : forums.filter(x => x.connected)) {
      const page = f.kind === 'xenforo' ? f.url + '/account/alerts' : f.url + '/notifications';
      if (!only) body.append(h('hr', { class: 'sep' }), h('div', { class: 'row' }, h('b', {}, f.name), count(f)));
      else body.append(h('div', { class: 'row' }, h('span', {}, 'לא נקראו'), count(f)));
      if (f.at) body.append(h('div', { class: 'faint' }, 'נבדק ב-' + when(f.at)));
      const items = f.items || [];
      body.append(...(items.length ? items.map(i => itemRow(i)) : [h('div', { class: 'sub' }, 'אין התראות.')]),
        h('button', { class: 'more', onclick: () => openExternal(page) }, 'לדף ההתראות בפורום'));
    }
  });
}

// ---------- settings ----------
// A row per forum: its name and state, and at the end the alerts switch (connected) or "התחברות" (not connected).
// "התחברות" opens two ways under the row: the forum's own window, or a username and password.
function settingsForm(box, ctx) {
  let forums = [], open = null, msg = {}, timer = 0;
  const minutes = [1, 2, 5, 10, 15, 30, 60];
  const rows = h('div', { class: 'form' }, h('div', { class: 'sub' }, 'טוען...'));
  box.append(section('הפורומים שלי'), rows,
    more(row('בדיקה כל', select(minutes.map(m => [m, m === 1 ? 'דקה' : m === 60 ? 'שעה' : `${m} דק׳`]), ctx.s.interval || 5, v => ctx.set({ interval: +v })))));

  const act = async (q, init) => {
    try { forums = (await call(q, init)).forums; } catch (e) { log('forums: ' + e.message); msg[q.match(/id=(\w+)/)?.[1]] = 'הפעולה נכשלה'; }
    draw();
  };
  const credsForm = f => {
    const user = h('input', { type: 'text', placeholder: 'שם משתמש או מייל', 'aria-label': 'שם משתמש או מייל', autocomplete: 'off', spellcheck: 'false' });
    const pass = h('input', { type: 'password', placeholder: 'סיסמה', 'aria-label': 'סיסמה', autocomplete: 'off' });
    const send = async () => {
      if (!user.value.trim() || !pass.value) return;
      const body = JSON.stringify({ user: user.value.trim(), pass: pass.value });
      user.value = pass.value = '';
      open = null;
      try {
        const r = await fetch(`forum?do=creds&id=${f.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!r.ok) throw new Error(String(r.status));
        forums = (await r.json()).forums;
      } catch (e) { log('forums creds: ' + e.message); msg[f.id] = 'לא נשמר. נסו חלון התחברות.'; }
      draw();
    };
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    setTimeout(() => user.focus(), 0);
    return h('div', { class: 'form dep fo-login' },
      // The reconnect of a password login goes straight to the fields; otherwise the window comes first.
      f.mode === 'creds' && f.connected ? '' : row('חלון התחברות', h('button', { class: 'btn', onclick: () => { msg[f.id] = ''; open = null; act(`do=login&id=${f.id}`); } }, 'פתיחה'), 'נפתח חלון של הפורום. מתחברים בו והוא נסגר לבד'),
      h('div', { class: 'fo-creds' },
        h('span', {}, 'או שם משתמש וסיסמה', h('span', { class: 'hint' }, 'נשמר מוצפן רק במחשב הזה, ונשלח רק לפורום')),
        user, pass,
        h('div', { class: 'fo-btns' }, h('button', { class: 'btn', onclick: () => { open = null; draw(); } }, 'ביטול'), h('button', { class: 'btn primary', onclick: send }, 'התחברות'))));
  };
  const status = f => f.pending ? 'מתחבר...' : f.connected ? (f.err ? f.err : f.mode === 'creds' ? 'מחובר כ-' + (f.user || '') : 'מחובר') : 'לא מחובר';
  function draw() {
    const s = ctx.s;
    if (!forums.length) { rows.replaceChildren(h('div', { class: 'sub' }, 'אין חיבור לרכיב ההתראות.')); return; }
    rows.replaceChildren(...forums.flatMap(f => {
      const logout = f.connected && !f.pending ? [' · ', h('button', { class: 'link', onclick: () => act(`do=logout&id=${f.id}`) }, 'ניתוק')] : [];
      const sw = () => h('input', { type: 'checkbox', checked: s.notify?.[f.id] !== false, title: 'התראות', 'aria-label': 'התראות מ' + f.name,
        onchange: e => ctx.set({ notify: { ...(ctx.s.notify || {}), [f.id]: e.target.checked } }) });
      const login = () => h('button', { class: 'btn' + (f.connected ? '' : ' primary'), 'aria-expanded': String(open === f.id), onclick: () => {
        msg[f.id] = '';
        // A window login that dropped: the window opens again at once (as before).
        if (f.connected && f.mode !== 'creds') { act(`do=login&id=${f.id}`); return; }
        open = open === f.id ? null : f.id; draw();
      } }, f.connected ? 'חיבור מחדש' : 'התחברות');
      const ctl = f.pending ? '' : !f.connected ? login() : f.err ? h('span', { class: 'fo-btns' }, login(), sw()) : sw();
      const note = msg[f.id] || (!f.pending && f.failed) || '';
      return [h('div', { class: 'srow' },
        h('span', { class: 'fo-txt' }, f.name, h('span', { class: 'hint fo-st' + (f.err ? ' down' : '') }, status(f), ...logout)), ctl),
      note ? h('div', { class: 'sub down' }, note) : '',
      open === f.id ? credsForm(f) : ''];
    }));
  }
  const refresh = async () => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (open || !forums.some(f => f.pending) && forums.length) return;
    try { forums = (await list()).forums; draw(); } catch (e) { log('forums: ' + e.message); draw(); }
  };
  refresh();
  timer = setInterval(refresh, 1500);
}

export default {
  id: 'forums',
  title: 'פורומים',
  size: [1, 3],
  defaults: DEFAULTS,
  every: 60_000,
  async render(el, ctx) {
    let d;
    try { d = await list(); } catch (e) {
      log('forums: ' + e.message);
      el.replaceChildren(h('div', { class: 'sub' }, 'אין חיבור לרכיב ההתראות.'));
      return;
    }
    const { on, heads, items, allItems } = plan(d.forums);
    if (!on.length) { el.replaceChildren(h('div', { class: 'sub' }, 'לא מחוברים לפורום.'), h('button', { class: 'more', onclick: () => openCardSettings('forums') }, 'התחברות')); return; }
    const kids = heads.map(f => forumRow(f, () => allLayer(d.forums, f)));
    if (heads.length < on.length) kids.unshift(h('div', { class: 'faint fo-sum' }, `${on.length} פורומים מחוברים`));
    kids.push(...items.map(i => itemRow(i, i.forum.name)));
    if (!allItems.length) kids.push(h('div', { class: 'sub' }, 'אין התראות חדשות.'));
    kids.push(h('button', { class: 'more', onclick: () => allLayer(d.forums) }, allItems.length > items.length ? `עוד ${allItems.length - items.length}` : 'כל ההתראות'));
    el.replaceChildren(...kids);
    const last = Math.max(0, ...on.map(f => f.at || 0));
    ctx.stale(last ? new Date(last) : null, on.some(f => f.err));
  },
  async widget() {
    try { return widgetSummary((await list()).forums); } catch { return { big: '', sub: 'אין נתוני פורומים', rows: [] }; }
  },
  settings(box, ctx) { settingsForm(box, ctx); },
};

export const css = `
.fo-click { cursor: pointer; border-radius: var(--radius-s); }
.fo-click:hover .val, .fo-click:hover > span:first-child { color: var(--accent); }
.fo-txt { min-width: 0; flex: 1; }
.item .fo-txt .val { white-space: nowrap; }
.fo-read { font-weight: 400; color: var(--fg2); }
.fo-n { display: inline-flex; align-items: center; gap: 8px; }
.fo-chat { display: inline-flex; align-items: center; gap: 3px; color: var(--fg2); font-size: 13px; }
.fo-sum { font-size: 12.5px; }
.fo-st { font-size: 12px; }
.fo-btns { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; justify-content: flex-end; }
.fo-creds { display: grid; gap: 6px; padding: 8px 0; border-bottom: 1px solid var(--stroke); font-size: 14px; }
.fo-login > .srow { border-bottom: 1px solid var(--stroke); }
.fo-st .link { font-size: 12px; }
`;
