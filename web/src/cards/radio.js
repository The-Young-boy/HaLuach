// "רדיו": the stations (research/sources.md, section 8: only those that work, minus those NetFree blocks),
// in groups, favourites on top (drag to reorder), a sleep timer, an alarm. The sound plays in the provider
// (src/radio.rs), so it goes on with the board closed and shows in Windows' media panel.
import { h, proxied, log, zmanim, openLayer, hm, openCardSettings, cardSettings, liveDrag } from '../core.js';
import { chosen } from './zmanim.js';
import { row, toggle, number, choice, select, section, debounce } from '../ui.js';
import KCM from '../../../research/kcm-channels.json';

const fav = u => `https://www.google.com/s2/favicons?sz=64&domain=${u}`;
// Station logos from their sites, in the package (Images/stations/<id>.png, 128px). The page gets them from the
// provider (/board/station?id=); radio.rs gives the media flyout ms-appx:///Images/stations/<id>.png for the same art.
// The rest: the site's favicon from Google.
const LOGOS = new Set(['kcm', 'toker', 'kolplay', 'jms', 'jrn', 'lakewood', 'nsn', 'yiddish24', 'kolbarama', 'breslev', 'chabad']);
const logo = (id, site) => LOGOS.has(id) ? `station?id=${id}` : fav(site);
const KCM_ART = logo('kcm', 'kcm.fm');
const kcm = (key, name, group) => ({ id: 'kcm' + key, name, group, url: `https://live.kcm.fm/${String(key).padStart(2, '0')}`, art: KCM_ART,
  now: `https://kcm.fm/Home/LiveJ/${key}`, parse: d => d?.item?.playing });

export const STATIONS = [
  { id: 'kcm', name: 'קול חי מיוזיק', group: 'מוזיקה', url: 'https://live.kcm.fm/livemusic', art: KCM_ART, now: 'https://kcm.fm/Home/LiveJ/1', parse: d => d?.item?.playing },
  { id: 'toker', name: 'טוקר FM', group: 'מוזיקה', url: 'https://broadcast.adpronet.com/radio/6060/radio.mp3', art: logo('toker', 'toker.fm'), now: 'https://scraper2.onlineradiobox.com/il.toker', parse: d => d?.title },
  // קול שמחה: no art. Its old domain shows another site's (non-Jewish) icon now, and the stream has no logo of its own.
  { id: 'kolsimcha', name: 'קול שמחה', group: 'מוזיקה', url: 'https://broadcast.adpronet.com/radio/8000/radio.mp3', art: '', now: 'https://broadcast.adpronet.com/api/nowplaying/17', parse: d => d?.now_playing?.song?.text },
  { id: 'kolsimcha-hits', name: 'קול שמחה - להיטים', group: 'מוזיקה', url: 'https://broadcast.adpronet.com/radio/8030/radio.mp3', art: '', now: 'https://broadcast.adpronet.com/api/nowplaying/41', parse: d => d?.now_playing?.song?.text },
  { id: 'kolsimcha-quiet', name: 'קול שמחה - שקטים', group: 'מוזיקה', url: 'https://broadcast.adpronet.com/radio/8020/radio.mp3', art: '', now: 'https://broadcast.adpronet.com/api/nowplaying/49', parse: d => d?.now_playing?.song?.text },
  { id: 'kolplay', name: 'קול פליי', group: 'מוזיקה', url: 'https://cdn.cybercdn.live/Kol_Barama/Music/icecast.audio', art: logo('kolplay', 'kol-play.co.il') },
  { id: 'jms', name: 'JewishMusicStream', group: 'מחו"ל', url: 'https://stream.jewishmusicstream.com:8000/stream', art: logo('jms', 'jewishmusicstream.com'), now: 'https://jewishmusicstream.com/system/web/song.json', parse: d => [d?.ARTIST, d?.TITLE].filter(Boolean).join(' - ') },
  { id: 'jrn', name: 'Jewish Radio Network', group: 'מחו"ל', url: 'https://stream.jewishradionetwork.com:8000/stream', art: logo('jrn', 'jewishradionetwork.com'), now: 'https://jewishradionetwork.com/system/web/song.json', parse: d => [d?.ARTIST, d?.TITLE].filter(Boolean).join(' - ') },
  { id: 'lakewood', name: 'Lakewood Scoop Radio', group: 'מחו"ל', url: 'http://janus.shoutca.st:8869/index.html/live', art: logo('lakewood', 'thelakewoodscoop.com'), now: 'http://janus.shoutca.st:8869/currentsong', text: true, parse: t => String(t || '').replace(/\s*\[[^\]]*\]\s*$/, '') },
  { id: 'nsn', name: 'NSN (Nachum Segal)', group: 'מחו"ל', url: 'https://nsn.streamguys1.com/nsnstream', art: logo('nsn', 'jmintheam.com') },
  // shira24: the site gives key 7 two names (רוגע and ימים נוראים); it is one stream.
  ...[['10', 'Shira Mix'], ['2', 'פריילך'], ['7', 'רוגע'], ['3', 'שבת'], ['8', 'ווקאלי'], ['13', 'פסח']].map(([k, n]) => ({ id: 'shira' + k, name: 'שירה 24 - ' + n, group: 'שירה 24', url: `https://music.shira24.com:5001/${k}`, art: fav('shira24.com'),
    now: 'https://shira24.com/playing.txt', parse: d => [d?.[k]?.artist, d?.[k]?.title].map(x => (x || '').trim()).filter(Boolean).join(' - ') })),
  // אידיש 24 (yiddish24.com/streams): 60 channels; every stream was checked open on NetFree from the Pi (15.11.26).
  ...[["1", "אלגעמיינע קאלעקשאן"], ["7", "אידישע ניגונים קאלעקשאן"], ["9", "קומזיץ קאלעקשאן"], ["2:37", "לעבעדיג קאלעקשאן"], ["8", "חתונה פרייליך קאלעקשאן"], ["10", "חתונה צווייטע טאנץ קאלעקשאן"], ["2:55", "טאנץ קאלעקשאן"], ["2:54", "מארש קאלעקשאן"], ["11", "רואיגע/שטייטע מוזיק"], ["2", "שבת קאלעקשאן"], ["6", "מוצאי שבת קאלעקשאן"], ["3", "נגינה אן מוזיק"], ["2:38", "פיאנע"], ["2:39", "מעדיטעשאן"], ["5", "חזנות קאלעקשאן"], ["16", "ימים נוראים"], ["17", "סוכות"], ["4", "חנוכה קאלעקשאן"], ["12", "פורים קאלעקשאן"], ["13", "פסח קאלעקשאן"], ["14", "ל״ג בעומר"], ["19", "שבועות"], ["2:31", "באבוב"], ["2:28", "בעלזא"], ["2:29", "וויזניץ"], ["2:40", "חב״ד"], ["2:33", "מוד׳זיץ"], ["2:35", "סאטמאר"], ["2:30", "סקולען"], ["2:27", "לחיים"], ["26", "קינדער קווייער"], ["2:41", "אביש בראדט"], ["21", "אברהם פריעד"], ["2:47", "אהר'לה סאמעט"], ["25", "אייזיק האניג"], ["2:32", "בנציון שענקער"], ["2:42", "בערי וועבער"], ["2:43", "ברוך לוין"], ["2:48", "דודי קאליש"], ["2:53", "זאנוויל וויינברגר"], ["2:49", "יהודה גרין"], ["2:56", "יואלי קליין"], ["2:50", "יעקב דאסקאל"], ["1054", "יעקב שוואקי"], ["2:44", "ישראל ווערדיגער"], ["2:57", "לוי פאלקאוויטש"], ["22", "ליפא שמעלצער"], ["2:34", "מאטי אילאוויטש"], ["2:51", "מוטי שטיינמץ"], ["23", "מיכאל שניצלער"], ["20", "מרדכי בן דוד"], ["24", "משה גאלדמאן"], ["2:45", "שלומי גרטנר"], ["2:52", "שלומי דאסקאל"], ["2:46", "שמחה ליינר"], ["2:58", "שמילי אונגר"], ["1058", "וואקאליש"], ["1057", "מארש וואלס"], ["1056", "ווארעם"], ["1055", "לעבעדיג"]].map(([k, n]) => ({ id: 'y24-' + k.replace(':', '-'), name: n, group: 'אידיש 24', url: k.startsWith('2:') ? `https://music2.y24.app/${k.slice(2)}` : `https://music.y24.app/${k}`, art: logo('yiddish24', 'yiddish24.com') })),
  { id: 'kolchai', name: 'קול חי', group: 'דיבור וחדשות', url: 'https://media2.93fm.co.il/live-new', art: fav('93fm.co.il') },
  { id: 'kolbarama', name: 'קול ברמה', group: 'דיבור וחדשות', url: 'https://cdn.cybercdn.live/Kol_Barama/Live_Audio/icecast.audio', art: logo('kolbarama', 'kol-barama.co.il'),
    now: 'https://kol-barama.co.il/wp-admin/admin-ajax.php?action=get_list_broadcast', parse: d => Array.isArray(d) ? [d[0]?.title, d[0]?.broadcaster].filter(Boolean).join(' - ') : '' },
  { id: 'breslev-halachot', name: 'ברסלב - הלכות', group: 'שיעורים', url: 'https://cast.breslevforyou.co.il/listen/halachot/radio.mp3', art: logo('breslev', 'breslevforyou.co.il') },
  { id: 'breslev-books', name: 'ברסלב - ספרים', group: 'שיעורים', url: 'https://cast.breslevforyou.co.il/listen/books/radio.mp3', art: logo('breslev', 'breslevforyou.co.il') },
  // Kol Chai Music's channels (names from the dafhabayit bundle). The holiday channels are separate: only the keys no other channel uses.
  ...KCM.slice(0, 73).map(([k, n]) => kcm(k, n, 'קול חי מיוזיק - ערוצים')),
  ...[['100', 'חנוכה'], ['83', 'פורים'], ['85', 'פסח'], ['106', 'ל״ג בעומר חסידי'], ['84', 'ל״ג בעומר מזרחי']].map(([k, n]) => kcm(k, n, 'קול חי מיוזיק - חגים')),
  { id: 'chabad', name: 'Chabad.org Music', group: 'מחו"ל', url: 'https://stream.radio.co/sdfd68a101/listen', art: logo('chabad', 'chabad.org'), now: 'https://public.radio.co/stations/sdfd68a101/status', parse: d => d?.current_track?.title },
];
const byId = id => STATIONS.find(s => s.id === id);
// The groups in the order the picker shows them (any group not named here goes at the end).
const GROUP_ORDER = ['מוזיקה', 'דיבור וחדשות', 'קול חי מיוזיק - ערוצים', 'שירה 24', 'אידיש 24', 'קול חי מיוזיק - חגים', 'שיעורים', 'מחו"ל'];
const GROUPS = [...new Set([...GROUP_ORDER, ...STATIONS.map(s => s.group)])].filter(g => STATIONS.some(s => s.group === g));
// Search: case, gershayim/geresh and quotes do not count ("חבד" finds "חב״ד").
const norm = t => String(t || '').toLowerCase().replace(/["'׳״’]/g, '').replace(/\s+/g, ' ').trim();
const matches = (st, q) => norm(st.name + ' ' + st.group).includes(q);

// The station picker in the layer: a search box, then the groups (the current station's group is open).
// With text in the box, one flat list of the stations that match.
/** The station list: groups and a search; a star on each station adds it to the card's favourites (`fav`). */
function picker(cur, onPick, fav) {
  const box = h('div', { class: 'radio-pick' });
  const star = st => {
    const b = h('button', { class: 'icon radio-star', onclick: () => { fav.toggle(st.id); paint(); } });
    const paint = () => { const on = fav.has(st.id); b.innerHTML = on ? I.starOn : I.star; b.title = on ? 'הסרה מהכרטיס' : 'הוספה לכרטיס'; b.setAttribute('aria-label', `${b.title}: ${st.name}`); b.setAttribute('aria-pressed', String(on)); };
    paint();
    return b;
  };
  const item = (st, withGroup) => h('div', { class: 'radio-pick-row' },
    h('button', { 'aria-current': st.id === cur?.id ? 'true' : null, onclick: () => onPick(st) },
      h('span', { class: 'radio-pick-name' }, st.name), withGroup ? h('span', { class: 'faint radio-pick-grp' }, st.group) : ''),
    fav ? star(st) : '');
  const draw = q => {
    q = norm(q);
    if (q) {
      const found = STATIONS.filter(st => matches(st, q));
      box.replaceChildren(found.length ? h('div', { class: 'list' }, ...found.map(st => item(st, true))) : h('div', { class: 'sub' }, 'לא נמצאה תחנה.'));
      return;
    }
    box.replaceChildren(...GROUPS.map(g => {
      const list = STATIONS.filter(st => st.group === g);
      return h('details', { open: g === cur?.group ? true : null }, h('summary', {}, g, ' ', h('span', { class: 'faint num' }, list.length)),
        h('div', { class: 'list' }, ...list.map(st => item(st, false))));
    }));
  };
  const search = h('input', { type: 'search', placeholder: 'חיפוש תחנה', 'aria-label': 'חיפוש תחנה', oninput: e => draw(e.target.value) });
  draw('');
  return { search, box };
}

// A `d=` (a list) goes in the POST body: the provider reads the body as `d` (main.rs handle).
async function cmd(q, d) { return fetch('radio?' + q, d === undefined ? {} : { method: 'POST', body: JSON.stringify(d) }).then(r => r.json()).catch(() => ({})); }
async function nowPlaying(st) {
  if (!st?.now) return '';
  try {
    const d = await proxied(st.now, { as: st.text ? 'text' : 'json' });
    return String(st.parse(d) || '').trim();
  } catch (e) { return ''; }
}

// ---------- alarms ----------
// An alarm: { on, station, days: [0..6] (0 = Sunday), mode: 'fixed' | 'zman', time: 'HH:MM', zman: engine id, min: before }.
// The next week's occurrences go to the provider (radio.rs plays them and wakes the computer).
const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
// The times by the zmanim card's ids: each one by the method the user chose there (zmanim.js chosen).
const ZMAN_OPTS = [['alot', 'עלות השחר'], ['misheyakir', 'זמן ציצית ותפילין'], ['netz', 'הנץ'], ['shma_mga', 'סוזק"ש מג"א'], ['shma_gra', 'סוזק"ש גר"א']];
// Alarms saved before: a fixed method id.
const OLD_ZMAN = { alot_72deg: 'alot', misheyakir_11_5: 'misheyakir', sunrise: 'netz' };
const zmanId = id => OLD_ZMAN[id] || id;
const zmanAt = (z, id) => { id = zmanId(id); const m = chosen(cardSettings('zmanim')).find(t => t.id === id)?.method; return z?.[m] || z?.[id]; };
async function nextAlarms(alarms) {
  const out = [];
  for (let d = 0; d < 7; d++) {
    const day = new Date(); day.setDate(day.getDate() + d);
    for (const [i, a] of alarms.entries()) {
      if (!a.on || !(a.days || []).includes(day.getDay())) continue;
      let at;
      if (a.mode === 'zman') { const t = zmanAt(await zmanim(day), a.zman); if (!t) continue; at = new Date(+t - (a.min || 0) * 60_000); }
      else { const [hh, mm] = (a.time || '06:30').split(':').map(Number); at = new Date(day); at.setHours(hh, mm, 0, 0); }
      if (at <= new Date()) continue;
      const st = byId(a.station) || STATIONS[0];
      out.push({ id: `a${i}d${d}`, at: +at, url: st.url, name: st.name, art: st.art, ramp: a.ramp ?? 60 });
    }
  }
  return out;
}
let alarmsSynced = 0;
export async function syncAlarms(alarms) {
  const list = await nextAlarms(alarms || []);
  await cmd('do=alarms', list);
  // The process must run from sign-in for an alarm to sound: the StartupTask goes on while any alarm is on.
  if (list.length) fetch('startup?on=1').catch(() => {});
  return list;
}

// Icons: 16px, currentColor. The play triangle points right, as everywhere (media icons do not mirror in RTL).
const svg = (d, fill) => `<svg viewBox="0 0 16 16" width="16" height="16" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.3"'} aria-hidden="true">${d}</svg>`;
const I = {
  play: svg('<path d="M5 3l8 5-8 5z"/>', true),
  pause: svg('<path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z"/>', true),
  prev: svg('<path d="M3 3h1.5v10H3zM13 3 5.5 8 13 13z"/>', true),
  next: svg('<path d="M11.5 3H13v10h-1.5zM3 3l7.5 5L3 13z"/>', true),
  up: svg('<path d="M4 10l4-4 4 4"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  star: svg('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" stroke-linejoin="round"/>'),
  vol: svg('<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" stroke-linejoin="round"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>'),
  muted: svg('<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" stroke-linejoin="round"/><path d="M11 6l3 4M14 6l-3 4"/>'),
  starOn: svg('<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>', true),
};
const ib = (icon, title, onclick) => h('button', { class: 'icon', title, 'aria-label': title, onclick, html: icon });

// The open card's panel: the player on top (next/previous, volume, sleep timer), then every station (search, groups,
// a star adds it to the card). The alarms are set in the card's settings; here only the next one shows.
let handles = null; // the last render's player (the settings' "בחירת תחנות" opens this panel with it)
const SLEEP = [[0, 'כבוי'], [15, '15 דק׳'], [30, '30 דק׳'], [45, '45 דק׳'], [60, 'שעה'], [90, 'שעה וחצי']];
const DAYS_FULL = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function controls(ctx, { st0, step, cur, play }) {
  openLayer(async (body, close) => {
    const s = ctx.s;
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: st0.volume ?? s.volume, 'aria-label': 'עוצמה',
      oninput: e => { cmd('do=volume&v=' + e.target.value); ctx.set({ volume: +e.target.value }); paintMute(); } });
    // Mute: the speaker toggles between silence and the last volume.
    const mute = h('button', { class: 'icon radio-vol', onclick: () => {
      const v = +vol.value ? 0 : (ctx.s.unmute || 0.8);
      if (+vol.value) ctx.set({ unmute: +vol.value });
      vol.value = v; cmd('do=volume&v=' + v); ctx.set({ volume: v }); paintMute();
    } });
    const paintMute = () => { const m = !+vol.value; mute.innerHTML = m ? I.muted : I.vol; mute.title = mute.ariaLabel = m ? 'ביטול השתקה' : 'השתקה'; };
    paintMute();
    const left = h('span', { class: 'hint' }, st0.sleepLeft ? ['כיבוי בעוד ', h('span', { class: 'num' }, Math.ceil(st0.sleepLeft / 60)), ' דק׳'] : '');
    // "בסוף" depends on the sleep timer: shown only while it runs (DESIGN.md "Inner menus" rule 2).
    const end = row('בסוף', choice([['', 'רק עצירה'], ['screen', 'כיבוי מסך'], ['sleep', 'שינה']], ctx.s.sleepEnd || '', v => ctx.set({ sleepEnd: v })));
    end.classList.add('dep');
    end.hidden = !st0.sleepLeft;
    const sleep = select(SLEEP, 0, v => { cmd('do=sleep&min=' + v).then(() => ctx.rerender()); left.replaceChildren(+v ? `כיבוי בעוד ${v} דק׳` : ''); end.hidden = !+v; });
    sleep.setAttribute('aria-label', 'שעון שינה');
    body.append(h('h2', {}, 'רדיו'),
      h('div', { class: 'radio-ctl' }, ib(I.next, 'הבאה', () => step(1)), ib(I.prev, 'הקודמת', () => step(-1)), mute, vol),
      h('div', { class: 'form' }, h('div', { class: 'srow' }, h('span', {}, 'שעון שינה', left), sleep), end));
    const fav = { has: id => ctx.s.favs.includes(id), toggle: id => { const f = ctx.s.favs; ctx.set({ favs: f.includes(id) ? f.filter(x => x !== id) : [...f, id] }); ctx.rerender(); } };
    const pick = picker(cur, st => { close(); play(st); }, fav);
    body.append(section(['תחנות ', h('span', { class: 'faint num' }, STATIONS.length)]),
      h('div', { class: 'faint radio-tip' }, 'הכוכב מוסיף תחנה לכרטיס.'), pick.search, pick.box);
    // The next alarm, and a way to set them.
    const next = h('span', { class: 'hint' }, 'טוען...');
    body.append(h('div', { class: 'form radio-next' }, h('div', { class: 'srow' }, h('span', {}, 'שעון מעורר', next),
      h('button', { class: 'btn', onclick: () => openCardSettings('radio') }, 'הגדרה'))));
    const list = await nextAlarms(s.alarms || []);
    const d = list[0] && new Date(list[0].at);
    next.replaceChildren(...(d ? [`הקרוב: ${DAYS_FULL[d.getDay()]} `, h('span', { class: 'num' }, hm(d)), ` · ${list[0].name}`] : ['אין שעון מעורר פעיל']));
  });
}

// ---------- the settings: the favourites' order, stopping at candle lighting, the alarms ----------
const fmtDays = days => {
  const d = [...(days || [])].sort();
  if (!d.length) return 'בלי ימים';
  if (d.length === 7) return 'כל יום';
  // A run of days ("א׳-ה׳") or a list ("א׳, ג׳").
  const run = d.every((x, i) => !i || x === d[i - 1] + 1);
  return run && d.length > 2 ? `${DAYS[d[0]]}-${DAYS[d[d.length - 1]]}` : d.map(x => DAYS[x]).join(', ');
};
const zmanName = id => ZMAN_OPTS.find(z => z[0] === zmanId(id))?.[1] || '';
function alarmText(a) {
  const when = a.mode === 'zman' ? `${a.min ? a.min + ' דק׳ לפני ' : ''}${zmanName(a.zman) || 'זמן'}` : (a.time || '06:30');
  return `${when} · ${fmtDays(a.days)}`;
}
function alarmsForm(ctx) {
  const alarms = structuredClone(ctx.s.alarms || []);
  const sync = debounce(() => syncAlarms(alarms), 800);
  const keep = () => { ctx.set({ alarms }); sync(); };
  const box = h('div', {});
  let openAt = -1;
  const draw = () => box.replaceChildren(...alarms.map((a, i) => {
    const sum = h('span', { class: 'radio-al-sum' });
    const paint = () => sum.replaceChildren(h('span', {}, alarmText(a)), h('span', { class: 'faint' }, a.on ? ' · ' + (byId(a.station) || STATIONS[0]).name : ' · כבוי'));
    const save = patch => { Object.assign(a, patch); paint(); keep(); };
    paint();
    const when = h('div', { class: 'form' });
    const drawWhen = () => when.replaceChildren(...(a.mode === 'zman'
      ? [row('זמן', select(ZMAN_OPTS, zmanId(a.zman || ZMAN_OPTS[0][0]), v => save({ zman: v }))), row('כמה לפני', number(a.min || 0, 'דק׳', v => save({ min: v }), { max: 180 }))]
      : [row('שעה', h('input', { type: 'time', value: a.time || '06:30', onchange: e => save({ time: e.target.value || '06:30' }) }))]));
    drawWhen();
    const days = h('span', { class: 'chips radio-days' });
    const drawDays = () => days.replaceChildren(...DAYS.map((d, k) => h('button', { type: 'button', class: 'chip' + ((a.days || []).includes(k) ? ' on' : ''), 'aria-pressed': String((a.days || []).includes(k)), title: DAYS_FULL[k],
      onclick: () => { const has = (a.days || []).includes(k); save({ days: has ? a.days.filter(x => x !== k) : [...new Set([...(a.days || []), k])].sort() }); drawDays(); } }, d)));
    drawDays();
    const station = h('select', { 'aria-label': 'תחנה', onchange: e => save({ station: e.target.value }) },
      ...GROUPS.map(g => h('optgroup', { label: g }, ...STATIONS.filter(st => st.group === g).map(st => h('option', { value: st.id, selected: (a.station || 'kcm') === st.id }, st.name)))));
    // The alarm's details show only while it is on (DESIGN.md "Inner menus" rule 2); its delete link always.
    return h('details', { class: 'radio-al', open: i === openAt ? true : null }, h('summary', {}, sum),
      h('div', { class: 'form' },
        ...toggle('פעיל', a.on, v => save({ on: v }), '', [
          row('מתי', choice([['fixed', 'בשעה'], ['zman', 'לפי זמן']], a.mode === 'zman' ? 'zman' : 'fixed', v => { save({ mode: v, ...(v === 'zman' && !a.zman ? { zman: ZMAN_OPTS[0][0] } : {}) }); drawWhen(); })),
          when,
          row('ימים', days),
          row('תחנה', station),
          row('עלייה הדרגתית', number(a.ramp ?? 60, 'שנ׳', v => save({ ramp: v }), { max: 600 }), 'העוצמה עולה לאט')]),
        h('div', { class: 'srow' }, h('span', {}), h('button', { class: 'link radio-del', onclick: () => { alarms.splice(i, 1); openAt = -1; keep(); draw(); } }, 'מחיקת השעון'))));
  }));
  draw();
  const add = h('button', { class: 'btn', onclick: () => {
    alarms.push({ on: true, mode: 'fixed', time: '06:30', days: [0, 1, 2, 3, 4], station: ctx.s.last || 'kcm', ramp: 60 });
    openAt = alarms.length - 1; keep(); draw();
  } }, 'הוספת שעון מעורר');
  return [box, add];
}

export default {
  id: 'radio',
  title: 'רדיו',
  size: [1, 3],
  defaults: { favs: [], last: 'kcm', volume: 0.8, stopOnCandles: true, alarms: [], resumeMin: 5 },
  every: 20_000,
  async render(el, ctx) {
    const s = ctx.s;
    if (Date.now() - alarmsSynced > 10 * 60_000) { alarmsSynced = Date.now(); syncAlarms(s.alarms); }
    // Tell the provider which stations the media keys walk: favourites, in the user's order.
    const list = s.favs.map(byId).filter(Boolean).map(x => [x.url, x.name, x.art]);
    const st0 = await cmd('do=list', list);
    const cur = STATIONS.find(x => x.url === st0.url) || byId(s.last);
    if (st0.want) { const m = STATIONS.find(x => x.url === st0.url); if (m) ctx.set({ last: m.id }); }
    const title = st0.playing ? await nowPlaying(cur) : '';
    if (st0.playing && title) cmd('do=nowplaying&title=' + encodeURIComponent(title));

    const play = st => { ctx.set({ last: st.id }); cmd(`do=play&url=${encodeURIComponent(st.url)}&name=${encodeURIComponent(st.name)}&art=${encodeURIComponent(st.art || '')}`).then(() => ctx.rerender()); };
    const toggle = () => st0.playing ? cmd('do=stop').then(() => ctx.rerender()) : play(cur);
    const step = d => { const f = ctx.s.favs.map(byId).filter(Boolean); const i = f.findIndex(x => x.id === cur?.id); if (f.length) play(f[(i + d + f.length) % f.length]); };
    handles = { st0, step, cur, play };
    el.replaceChildren(
      h('div', { class: 'radio-now' },
        // Fades in once loaded (HaFeed's lazyfade): an insert animation would be over before a slow logo arrives.
        cur?.art ? h('img', { class: 'radio-art lazyfade', src: cur.art, alt: '', width: 40, height: 40, onload: e => e.target.classList.add('in') }) : h('span', { class: 'radio-art' }),
        h('div', { class: 'radio-txt' },
          h('div', { class: 'radio-name' }, cur?.name || 'בחרו תחנה'),
          h('div', { class: 'sub radio-song', dir: 'auto', title: title || '' }, st0.playing ? (title || 'משדר') : 'עצור')),
        // The current station into the card's favourites, or out (the same star as in the list).
        cur ? (() => {
          const on = s.favs.includes(cur.id), label = (on ? 'הסרה מהמועדפים: ' : 'הוספה למועדפים: ') + cur.name;
          return h('button', { class: 'icon radio-star', title: label, 'aria-label': label, 'aria-pressed': String(on), html: on ? I.starOn : I.star,
            onclick: () => { ctx.set({ favs: on ? s.favs.filter(x => x !== cur.id) : [...s.favs, cur.id] }); ctx.rerender(); } });
        })() : '',
        h('button', { class: 'radio-play', title: st0.playing ? 'עצירה' : 'ניגון', 'aria-label': st0.playing ? 'עצירה' : 'ניגון', onclick: toggle, html: st0.playing ? I.pause : I.play })),
      st0.quiet ? h('div', { class: 'sub' }, 'שבת או חג: הרדיו לא מנגן עד צאת.') : '',
      st0.sleepLeft ? h('div', { class: 'faint radio-sleep' }, 'כיבוי בעוד ', h('span', { class: 'num' }, Math.ceil(st0.sleepLeft / 60)), ' דק׳') : '',
      h('div', { class: 'chips radio-favs' },
        ...s.favs.map(byId).filter(Boolean).map(x => h('button', { class: 'chip' + (x.id === cur?.id ? ' on' : ''), onclick: () => play(x) }, x.name)),

        h('button', { class: 'chip', title: 'כל התחנות, עוצמה ושעון שינה', onclick: () => controls(ctx, handles) }, 'כל התחנות')),
    );
  },
  settings(box, ctx) {
    // Favourites: the card's chips and the order of next/previous. They are picked with the star in the card's list.
    const favBox = h('div', { class: 'form' });
    // Save and redraw the card (its chips follow the order). `list` false: the rows are already in place (a drop).
    const setFavs = (favs, list = true) => { ctx.set({ favs }); ctx.rerender(); if (list) drawFavs(); };
    // The "up" button on the first row only: kept in step with the order without a redraw.
    const syncUp = () => favBox.querySelectorAll('.radio-fav-row').forEach((r, i) => { r.dataset.i = i; r.querySelector('.radio-up').style.display = i ? '' : 'none'; });
    const drawFavs = () => {
      const favs = ctx.s.favs;
      // The index is read from the row at the event (data-i), so a drop needs no redraw.
      const idx = e => +e.currentTarget.closest('.radio-fav-row').dataset.i;
      favBox.replaceChildren(...(favs.length ? favs.map(id => h('div', { class: 'srow radio-fav-row', title: 'גרירה לשינוי הסדר', onpointerdown: dragFav }, h('span', {}, byId(id)?.name || id),
        h('span', { class: 'radio-fav-btns' },
          (() => { const b = ib(I.up, 'למעלה', e => { const i = idx(e), f = [...ctx.s.favs]; [f[i - 1], f[i]] = [f[i], f[i - 1]]; setFavs(f); }); b.classList.add('radio-up'); return b; })(),
          ib(I.x, 'הסרה מהכרטיס', () => setFavs(ctx.s.favs.filter(x => x !== id))))))
        : [h('div', { class: 'sub' }, 'אין תחנות בכרטיס עדיין.')]));
      syncUp();
    };
    // Drag a row to reorder (the buttons still work: a press on a button is not a drag).
    const dragFav = e => {
      if (e.button || e.target.closest('button')) return;
      const rows = [...favBox.querySelectorAll('.radio-fav-row')], from = +e.currentTarget.dataset.i;
      liveDrag(e, rows[from], rows, to => {
        if (to < 0) return;
        const f = [...ctx.s.favs]; f.splice(to, 0, ...f.splice(from, 1)); setFavs(f, false); syncUp();
      });
    };

    drawFavs();
    // The minutes are kept while the switch is off (0 is saved), so turning it on again brings back the last value.
    function resume() {
      let last = ctx.s.resumeMin > 0 ? ctx.s.resumeMin : 5;
      const min = row('תוך', number(last, 'דק׳', v => { last = Math.max(1, v); ctx.set({ resumeMin: last }); }, { min: 1, max: 120 }));
      return toggle('להמשיך כשהאוזניות חוזרות', (ctx.s.resumeMin ?? 5) > 0, on => ctx.set({ resumeMin: on ? last : 0 }), '', [min]);
    }
    box.append(
      section('תחנות בכרטיס'), h('div', { class: 'hint radio-tip' }, 'גוררים שורה לשינוי הסדר. זה גם הסדר של הבאה והקודמת.'), favBox,
      handles ? h('button', { class: 'btn', onclick: () => controls(ctx, handles) }, 'בחירת תחנות') : '',
      ...toggle('עצירה בהדלקת נרות', ctx.s.stopOnCandles, v => ctx.set({ stopOnCandles: v })),
      // radio.rs: stops when the headphones are unplugged; plays again if the same ones come back in time. 0 = never.
      ...resume(),
      section('שעון מעורר'), h('div', { class: 'hint radio-tip' }, 'לא מצלצל בשבת ובחג. תחנה שלא עונה: צליל במקומה.'), ...alarmsForm(ctx));
  },
};

export const css = `
.radio-now { display: flex; align-items: center; gap: 10px; min-width: 0; }
.radio-art { width: 40px; height: 40px; border-radius: var(--radius-s); flex: none; background: var(--fill); object-fit: cover; }
.radio-txt { flex: 1; min-width: 0; }
.radio-name { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.radio-song { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.radio-play { flex: none; width: 32px; height: 32px; border-radius: 50%; border: 0; padding: 0; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; cursor: pointer; }
.radio-play:hover { filter: brightness(1.08); }
.radio-play svg { width: 14px; height: 14px; }
.radio-sleep { font-size: 12px; padding-top: 4px; }
.radio-favs { margin-top: 10px; }
.radio-ctl { display: flex; align-items: center; gap: 2px; margin-bottom: 12px; }
.radio-ctl input[type=range] { flex: 1; }
.radio-pick { display: grid; gap: 2px; margin-top: 8px; }
.radio-pick-row { display: flex; align-items: center; gap: 4px; }
.radio-pick-row > button:first-child { display: flex; align-items: baseline; gap: 8px; flex: 1; min-width: 0; }
.radio-pick .radio-star { width: 28px; height: 28px; padding: 0; flex: none; }
.radio-star[aria-pressed="true"] { color: var(--sun); }
.radio-pick button[aria-current] { color: var(--accent); font-weight: 600; }
.radio-pick-name { flex: 1; min-width: 0; }
.radio-pick-grp { font-size: 12px; flex: none; }
.radio-pick input[type=search], .expand-body > input[type=search] { width: 100%; }
.radio-vol { display: inline-grid; place-items: center; width: 24px; color: var(--fg2); flex: none; }
.radio-tip { font-size: 12.5px; margin-bottom: 4px; }
.radio-next { margin-top: 10px; border-top: 1px solid var(--stroke); }
.radio-al-sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.radio-days .chip { padding: 3px 8px; }
.radio-fav-btns { display: inline-flex; flex: none; }
.radio-fav-row { cursor: grab; touch-action: none; user-select: none; }
.radio-fav-row.shift { transition: transform .18s var(--ease); }
.radio-fav-row.dragging { position: relative; z-index: 2; background: var(--sheet); box-shadow: var(--shadow-drag); border-radius: var(--radius); }
.radio-fav-btns .icon { width: 28px; height: 28px; }
.radio-del { color: var(--bad); }
.form > .srow > select { width: min(55%, 220px); flex: none; }
`;
