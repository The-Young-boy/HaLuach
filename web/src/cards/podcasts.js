// "פודקאסטים": updates only, no player (SPEC 15.11.26). A click on an episode opens it in the default browser.
// The unit is a podcast (one show), never a channel or a platform. A podcast comes from one of:
//   ytp: a YouTube playlist (YouTube podcasts are playlists; a channel's "Podcasts" tab lists them),
//   rss: an RSS feed (kolhalashon.com's own RSS is one of these: the feed and the mp3 open under NetFree).
// (doscast.co.il was tested and dropped: its API opens, but every audio copy is 418.)
// The source never shows in the UI. Every episode is checked against NetFree (418 = blocked); by default only open
// episodes show. The list and the NetFree results: research/podcasts.md.
import { h, proxied, BROWSER_UA, openLayer, openExternal, cardSettings, log, hm } from '../core.js';
import { row, choice, select, section, more } from '../ui.js';

// ---------- the built-in list: only podcasts open on NetFree (research/podcasts.md, "הרשימה המובנית") ----------
// ch = the channel (a listing fallback), seed = an episode found open (the watch page with &list= lists the rest),
// asc = the playlist runs oldest first.
const yt = (name, group, id, ch, seed, asc = false) => ({ key: 'ytp:' + id, kind: 'ytp', src: id, name, group, ch, seed, asc });
const rss = (name, group, url) => ({ key: 'rss:' + url, kind: 'rss', src: url, name, group });
const kh = fid => `https://www.kolhalashon.com/New/RSS/CreateRss.aspx?Lang=Hebrew&FID=${fid}&AudioOnly=True&RavID=-1&Order=1&IsEdge=True&PageNum=1&LangID=1`;
// Categories by content only, in this order.
const CATS = ['תורה ושיעורים', 'דף יומי ולימוד', 'שיחות ואקטואליה', 'משפחה וחינוך', 'ילדים', 'סיפורים', 'בריאות', 'כסף ועסקים', 'מוזיקה'];
export const SUGGESTED = [
  // Pi (NetFree) 15.11.26: the last 3 episodes, open count at the end (research/pi-podcasts-candidates.tsv).
  yt("השתוקקות - תוכן אחד", 'תורה ושיעורים', 'PLx46_EMW9jY0V5r9lPz31_UYhRN25M9CN', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'b7W2s0KJ5Wk'), // 3/3
  yt("עומקה של מחשבה", 'תורה ושיעורים', 'PLPzq69lnQ-jTc76S4OHrfr_bnaIvL7Xi9', 'UC_njrdq5TZ7q1eXYgc5ANSA', 't4PGExuyDr0'), // 3/3
  yt("אוחילה - משפחה", 'תורה ושיעורים', 'PLPzq69lnQ-jSpj7yPtujgIup-wW0Vh1LW', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'Q6pef9cSSIE'), // 3/3
  yt("הרב שניר גואטה - ענפים", 'תורה ושיעורים', 'PLADwDOrxo3EWDSG7jtlDY3O0S5v00sGn5', 'UCP8gwVljbOwSfO-Qs8zR7VA', '5LG20Oa7PWM'), // 3/3
  rss("פרשת השבוע - הרב שלמה לוינשטיין", 'תורה ושיעורים', kh(11229)), // 3/3
  yt("דף יומי, מסכת בכורות - ר' אלי סטפנסקי", 'דף יומי ולימוד', 'PLffOSHQ_-_H0', 'UCKwQa5DB_VR98ac_r-Wyl-g', 'pcqoTqf-ypI'), // 2/3
  yt("מורשת - תוכן אחד", 'שיחות ואקטואליה', 'PLF4m8J7X9yQk', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'YgU6BoXWUTU', true), // 3/3
  yt("העיתונאים - גרשי קלצקין", 'שיחות ואקטואליה', 'PLx46_EMW9jY1PgCrLiJsr_Fy-8-n04zbf', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'q6V23IvbDmA'), // 3/3
  yt("הטוענים - עזרא לוי", 'שיחות ואקטואליה', 'PLRh-mvB9_X_8', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'v7Ga9DwO4Kc'), // 3/3
  yt("המגייסים - פרי לייבוביץ", 'שיחות ואקטואליה', 'PLx46_EMW9jY24TjX3SG8kIm8eA6Xh0ObB', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'Kb5cKcv_IZ0'), // 3/3
  yt("מחוץ לפרוטוקול - משפחה", 'שיחות ואקטואליה', 'PLTWrneKVpoHg', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'lHOiFymd94U'), // 2/3
  yt("קצר על העניין - משפחה", 'שיחות ואקטואליה', 'PLM94ffWyisTg', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'REykEjD05Rk'), // 3/3
  yt("צו השעה - משפחה", 'שיחות ואקטואליה', 'PLPzq69lnQ-jQ5U30EAxOPfEx4FRmi64tQ', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'HriAWhdauEs'), // 3/3
  yt("שיחה אישית - קול חי", 'שיחות ואקטואליה', 'PLzU43ymx7A4-Xk0Q-j4ndAG2AVU2lu48Y', 'UC3OU13AHRN_9YEPB7GO0xyQ', '4jb8tDWI8sI', true), // 3/3
  yt("הקבינט - קול חי", 'שיחות ואקטואליה', 'PLzU43ymx7A486wvlxYhtWb6Tajvl-hPLi', 'UC3OU13AHRN_9YEPB7GO0xyQ', 'YCAHxFYFTsg', true), // 3/3
  yt("מסוגלים - אבי מימרן", 'משפחה וחינוך', 'PLanqvVhUJgo8', 'UCLzUCsjjbaSH9dZlpdRO3rA', '79oBDXIE1hU'), // 3/3
  yt("מותר בפיך - משפחה", 'משפחה וחינוך', 'PLN92AFaeZ6sk', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'eULshTBeriM'), // 3/3
  yt("שניים הפוך - משפחה", 'משפחה וחינוך', 'PLPzq69lnQ-jQJJUoh6WMC5-YdQgovUiiq', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'SQafT-s7C38'), // 3/3
  yt("סנאי וארנב", 'ילדים', 'PLPzq69lnQ-jQqm-2QpCyhGQ4-u_V9hpo0', 'UC_njrdq5TZ7q1eXYgc5ANSA', '9oW2D4W1f4I'), // 3/3
  yt("סיפורי סבתא", 'ילדים', 'PLPzq69lnQ-jTxHiAg1xqU1mRahAxkHI3S', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'h-HfEU4TYJE'), // 3/3
  yt("בון דובון וחברים", 'ילדים', 'PLPzq69lnQ-jTQqX41Ynvm71XrkNFH2eHm', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'H9feE4L8m2k'), // 3/3
  yt("למעיישה - הרב יהודה ראה", 'סיפורים', 'PLx46_EMW9jY1ujYz0t7fXrX9up3fOUiis', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'itXRFf8oo4Y'), // 3/3
  yt("דורות - תוכן אחד", 'סיפורים', 'PLx46_EMW9jY1Aza2xh2ydISLTZ67kmROO', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'WZZTpmRo0WM'), // 3/3
  yt("עתיקות - יהודה ברייער", 'סיפורים', 'PLx46_EMW9jY3c7k8UvSQ1T_2cXmQjkDJ8', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'SrbVr4C2V7M'), // 3/3
  yt("הנתינה - צבי לוין", 'סיפורים', 'PLx46_EMW9jY0lGYeoDvIenYzBeF2yDpES', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'yHtxemEuS84'), // 3/3
  yt("קורת רוח לשבת", 'סיפורים', 'PLPzq69lnQ-jQ-wFGgIwFYrM2Xrpl2Fzap', 'UC_njrdq5TZ7q1eXYgc5ANSA', '1WgQG0dBrJ4'), // 3/3
  yt("לא תשכח - משפחה", 'סיפורים', 'PLPzq69lnQ-jRV3tY48DrFqjkArwVUrU2-', 'UC_njrdq5TZ7q1eXYgc5ANSA', '8a20uEpMJHo'), // 3/3
  yt("בראי ההיסטוריה - משפחה", 'סיפורים', 'PLTCqmEt0Wt9o', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'lbXeQIZwPsU'), // 2/2
  yt("מי האיש - משפחה", 'סיפורים', 'PLPzq69lnQ-jSVpmiTahrhPXhFBeQqtUiY', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'owOFtdX5o5k'), // 2/3
  yt("לאורם - משפחה", 'סיפורים', 'PLPzq69lnQ-jStAbFmNLtjR3nOyXo8-yZr', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'fejRQsfGd-E'), // 3/3
  yt("תזונה - תוכן אחד", 'בריאות', 'PLx46_EMW9jY2K4S9efm5RePNnenOenvVZ', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'sjUqZr4BKcE'), // 2/3
  yt("רפואה - יעקב שקול", 'בריאות', 'PLNkAADMo11FE', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'qqHYnLMZOMs'), // 3/3
  yt("נדל\"ן - תוכן אחד", 'כסף ועסקים', 'PLx46_EMW9jY1IsMvkDVSiOVTOKlmcG5h2', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'tAEMVOQ3OX0'), // 3/3
  yt("הבורסה - תוכן אחד", 'כסף ועסקים', 'PLx46_EMW9jY3DiwHjUK18BwV55nuabwgl', 'UCLzUCsjjbaSH9dZlpdRO3rA', 'kHmEdAw5AyI'), // 3/3
  yt("העצמאיים - תוכן אחד", 'כסף ועסקים', 'PLa4LwA3csFuA', 'UCLzUCsjjbaSH9dZlpdRO3rA', '7n6jQIlmQV4'), // 3/3
  yt("ההיכל - ישראל אוירבך", 'כסף ועסקים', 'PLx46_EMW9jY0ewNPVCFY6aE37rLlYZvPW', 'UCLzUCsjjbaSH9dZlpdRO3rA', 't9Z_IQd1tRU'), // 3/3
  yt("עסק או ביש - משפחה", 'כסף ועסקים', 'PLPzq69lnQ-jSClettt1Tmi0M-CBTrdkv8', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'qfml3En-Y64'), // 3/3
  yt("באות לעבוד - משפחה", 'כסף ועסקים', 'PLPzq69lnQ-jRbHRNreUaDdyTeA_lSeMpn', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'hxm213LmJYc'), // 3/3
  yt("מתיקין - תוכן אחד", 'מוזיקה', 'PLf-0eX4G9zkg', 'UCLzUCsjjbaSH9dZlpdRO3rA', '6UyUqlAR3jw'), // 3/3
  yt("חזנות - יוסלה קלצקין", 'מוזיקה', 'PLdlf0XFmz0Ww', 'UCLzUCsjjbaSH9dZlpdRO3rA', '1qGnPdujzIU'), // 3/3
  yt("חדר אומנים - משפחה", 'מוזיקה', 'PLbRxj7uDNcRw', 'UC_njrdq5TZ7q1eXYgc5ANSA', 'oRDncdpC0Xg', true), // 3/3
];
const GROUPS = CATS.filter(g => SUGGESTED.some(x => x.group === g));
const norm = t => String(t || '').toLowerCase().replace(/["'׳״’]/g, '').replace(/\s+/g, ' ').trim();

// ---------- parsing (pure) ----------
const MAX_EPS = 20;
/** RSS 2.0 or Atom (YouTube's playlist feed too) -> { name, eps: [{ id, title, t, url, audio, tx }] }. */
export function parseFeed(xml, parser = new DOMParser()) {
  const doc = parser.parseFromString(xml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('not xml');
  const root = doc.documentElement;
  const top = root.getElementsByTagName('channel')[0] || root;
  const child = (el, tag) => [...el.children].find(c => c.tagName === tag);
  const text = (el, tag) => child(el, tag)?.textContent?.trim() || '';
  const items = [...root.getElementsByTagName('item'), ...root.getElementsByTagName('entry')];
  const name = text(top, 'title');
  if (!items.length && !name) throw new Error('not a feed');
  const eps = items.map(it => {
    const linkEl = child(it, 'link');
    const link = linkEl?.getAttribute('href') || linkEl?.textContent?.trim() || '';
    const audio = child(it, 'enclosure')?.getAttribute('url') || '';
    const vid = text(it, 'yt:videoId');
    const t = Date.parse(text(it, 'pubDate') || text(it, 'published') || text(it, 'updated')) || 0;
    return { id: vid || text(it, 'guid') || text(it, 'id') || link || audio || text(it, 'title'), title: text(it, 'title'), t, url: link, audio, tx: true };
  }).filter(e => e.id);
  return { name, eps };
}

/** "לפני 3 ימים", "לפני יומיים (2)", "שודר לפני שעה" -> ms since then (0 = not a past time). */
export function parseAgo(text) {
  const m = String(text || '').match(/לפני\s+(.+)/);
  if (!m) return 0;
  const s = m[1];
  const unit = /שני(ות|יה|ה)/.test(s) ? 1e3 : /דק/.test(s) ? 6e4 : /שע/.test(s) ? 36e5 : /יום|ימים|יומיים/.test(s) ? 864e5
    : /שבוע/.test(s) ? 6048e5 : /חודש/.test(s) ? 2592e6 : /שנ(ה|ים|תיים)/.test(s) ? 31536e6 : 0;
  if (!unit) return 0;
  const n = +(s.match(/\d+/)?.[0] || (/יים(\s|\(|$)/.test(s) ? 2 : 1));
  return n * unit;
}

const initialData = html => {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('no ytInitialData');
  return JSON.parse(m[1]);
};
/** A playlist page (hl=iw) -> { name, eps } in the page's order (lockupViewModel and the older renderers). */
export function parseYtList(html, now = Date.now()) {
  const d = initialData(html);
  const eps = [];
  const walk = o => {
    if (!o || typeof o !== 'object' || eps.length >= 200) return;
    const l = o.lockupViewModel;
    if (l?.contentId && /VIDEO/.test(l.contentType || '')) {
      const md = l.metadata?.lockupMetadataViewModel;
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => r.metadataParts || []);
      const ago = parts.map(p => parseAgo(p.accessibilityLabel || p.text?.content)).find(Boolean) || 0;
      eps.push({ id: l.contentId, title: md?.title?.content || '', t: ago ? now - ago : 0, tx: false });
      return;
    }
    const v = o.playlistVideoRenderer || o.videoRenderer;
    if (v?.videoId) {
      const ago = parseAgo(v.publishedTimeText?.simpleText || (v.videoInfo?.runs || []).map(r => r.text).join(''));
      eps.push({ id: v.videoId, title: v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText || '', t: ago ? now - ago : 0, tx: false });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(d);
  const name = d.metadata?.playlistMetadataRenderer?.title || d.header?.pageHeaderRenderer?.pageTitle || '';
  return { name, eps };
}

/** A channel's /podcasts tab -> { channel, list: [{ id, name, seed }] } (only podcasts; no tab gives []). */
export function parseYtPodcasts(html) {
  const d = initialData(html);
  const out = [];
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    const l = o.lockupViewModel;
    if (l?.contentId && /PODCAST/.test(l.contentType || '')) {
      const seed = JSON.stringify(l).match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/)?.[1] || '';
      if (!out.some(x => x.id === l.contentId)) out.push({ id: l.contentId, name: l.metadata?.lockupMetadataViewModel?.title?.content || l.contentId, seed });
      return;
    }
    for (const k in o) walk(o[k]);
  };
  walk(d);
  return { channel: d.metadata?.channelMetadataRenderer?.title || '', id: d.metadata?.channelMetadataRenderer?.externalId || '', list: out };
}

/** A watch page opened with &list= -> { name, eps } from its side panel, in playlist order. */
export function parseYtPanel(html) {
  const d = initialData(html);
  const pl = d.contents?.twoColumnWatchNextResults?.playlist?.playlist;
  if (!pl?.contents) throw new Error('no playlist panel');
  const eps = pl.contents.map(c => c.playlistPanelVideoRenderer).filter(v => v?.videoId)
    .map(v => ({ id: v.videoId, title: v.title?.simpleText || v.title?.runs?.map(r => r.text).join('') || '', t: 0, tx: false }));
  return { name: pl.title || '', eps, ch: html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] || '' };
}

/** A pasted YouTube link -> { playlist } | { channel } | { video } | { page } | null. */
export function ytLink(u) {
  let x;
  try { x = new URL(u); } catch { return null; }
  if (!/(^|\.)(youtube\.com|youtu\.be)$/.test(x.hostname)) return null;
  const list = x.searchParams.get('list');
  if (list && /^PL[\w-]{10,}$/.test(list)) return { playlist: list, video: x.searchParams.get('v') || '' };
  const ch = x.pathname.match(/\/channel\/(UC[\w-]{22})/);
  if (ch) return { channel: ch[1] };
  const v = x.hostname.endsWith('youtu.be') ? x.pathname.slice(1) : x.searchParams.get('v') || x.pathname.match(/\/(shorts|live|embed)\/([\w-]{11})/)?.[2];
  if (v && /^[\w-]{11}$/.test(v)) return { video: v };
  const pg = x.pathname.match(/^\/(@[^/]+|c\/[^/]+|user\/[^/]+)/);
  if (pg) return { page: `https://www.youtube.com/${pg[1]}` };
  return null;
}
const appleId = u => /(podcasts|itunes)\.apple\.com/.test(u) ? u.match(/id(\d{5,})/)?.[1] : null;

// ---------- fetching ----------
const pause = ms => new Promise(r => setTimeout(r, ms));
const ytGet = url => proxied(url, { as: 'text', headers: [BROWSER_UA] });
/** The first words of a podcast's name ("מורשת | בהגשת..." -> "מורשת"): its episodes' titles carry them. */
export const titleKey = name => noNiqqud(String(name || '').split(/\s+[-|–:]\s+|\s*\|\s*/)[0]).trim();
// Without niqqud and quote marks, so "זמן סיפור" with niqqud matches, and נדל"ן matches נדלן.
const noNiqqud = t => String(t || '').replace(/[֑-ׇ"'׳״]/g, '');
/** Newest first: the playlist order, turned when it is oldest first. Known dates decide; else the show's hint. */
function newestFirst(list, known, ascHint) {
  const dated = list.map(e => known.get(e.id)?.t || e.t).filter(Boolean);
  const asc = dated.length > 1 ? dated[0] < dated[dated.length - 1] : !!ascHint;
  return asc ? [...list].reverse() : list;
}
/** The channel's /videos page, once per refresh for all its podcasts: id -> { title, t }. */
let chanCache = new Map();
function channelVideos(ch) {
  if (!chanCache.has(ch)) chanCache.set(ch, ytGet(`https://www.youtube.com/channel/${ch}/videos?hl=iw&gl=IL`).then(html => parseYtList(html).eps).catch(() => []));
  return chanCache.get(ch);
}
/** A YouTube playlist. Under NetFree the playlist's RSS and page are 418, but the watch page of an open episode with
 *  &list= is open, and its side panel lists the playlist (Pi, 15.11.26). So: the RSS (works outside NetFree), then the
 *  watch page of the newest known open episode, then the channel's /videos page filtered by the podcast's name, then
 *  the playlist page. Dates: the RSS has them; the channel page has "לפני..." for its recent videos. */
async function fetchPlaylist(show, old) {
  const id = show.src;
  const known = new Map((old?.eps || []).map(e => [e.id, e]));
  try {
    // The extra parameter makes the provider fetch again instead of answering from its cache.
    const f = parseFeed(await ytGet(`https://www.youtube.com/feeds/videos.xml?playlist_id=${id}&r=${Date.now() % 1e6}`));
    const asc = f.eps.length > 1 && f.eps[0].t < f.eps[f.eps.length - 1].t;
    // 15 = the RSS's cap: oldest first and longer, so the newest are not in it.
    if (f.eps.length && !(asc && f.eps.length >= 15)) return { name: f.name, eps: f.eps.sort((a, b) => b.t - a.t).slice(0, MAX_EPS) };
  } catch {}
  // Outside NetFree the RSS answered above; from here on the channel's page dates what it can.
  const vids = show.ch ? await channelVideos(show.ch) : [];
  const dateOf = new Map(vids.filter(v => v.t).map(v => [v.id, v.t]));
  const dated = e => ({ ...e, t: e.t || dateOf.get(e.id) || 0 });
  const seeds = [...new Set([...(old?.eps || []).filter(e => e.open !== false).map(e => e.id), show.seed].filter(Boolean))].slice(0, 3);
  for (const v of seeds) {
    try {
      const p = parseYtPanel(await ytGet(`https://www.youtube.com/watch?v=${v}&list=${id}&hl=iw&gl=IL`));
      if (p.eps.length) return { name: p.name, ch: p.ch, eps: newestFirst(p.eps.map(dated), known, show.asc).slice(0, MAX_EPS) };
    } catch {}
  }
  const key = titleKey(show.name);
  if (key.length > 1) {
    const mine = vids.filter(v => known.has(v.id) || noNiqqud(v.title).includes(key));
    if (mine.length) return { name: '', eps: mine.slice(0, MAX_EPS) };
  }
  const p = parseYtList(await ytGet(`https://www.youtube.com/playlist?list=${id}&hl=iw&gl=IL`));
  return { name: p.name, eps: newestFirst(p.eps.map(dated), known, show.asc).slice(0, MAX_EPS) };
}
async function fetchShow(show, old) {
  if (show.kind === 'ytp') return fetchPlaylist(show, old);
  const f = parseFeed(await proxied(show.src, { as: 'text', headers: [BROWSER_UA] }));
  return { name: f.name, eps: f.eps.sort((a, b) => b.t - a.t).slice(0, MAX_EPS) };
}
const showOf = (kind, src, name, extra = {}) => ({ key: (kind === 'ytp' ? 'ytp:' : 'rss:') + src, kind, src, name, notify: false, ...extra });

/** A channel -> its podcasts to pick from. */
async function channelPodcasts(id) {
  let r;
  try { r = parseYtPodcasts(await ytGet(`https://www.youtube.com/channel/${id}/podcasts?hl=iw&gl=IL`)); } catch { throw new Error('הערוץ לא נפתח. הדביקו קישור לפודקאסט עצמו.'); }
  if (!r.list.length) throw new Error('בערוץ הזה אין פודקאסטים. הדביקו קישור לפודקאסט עצמו.');
  return { channel: r.channel, choices: r.list.map(x => showOf('ytp', x.id, x.name, { ch: id, seed: x.seed })) };
}

/** A pasted link -> { show, feed } (one podcast) or { channel, choices: [show] } (a channel's podcasts).
 *  Throws a Hebrew message. */
export async function resolveLink(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('הדביקו קישור.');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const y = ytLink(u);
  if (y || /youtube\.com|youtu\.be/.test(u)) {
    if (y?.playlist) {
      // Under NetFree only the watch page of an episode lists the playlist: a link with v= too is needed.
      const feed = await fetchPlaylist({ src: y.playlist, seed: y.video, name: '' }).catch(() => {
        throw new Error(y.video ? 'הפודקאסט לא נפתח. נסו שוב מאוחר יותר.' : 'הפודקאסט לא נפתח. הדביקו קישור לפרק אחד שלו.');
      });
      return { show: showOf('ytp', y.playlist, feed.name || 'פודקאסט', { ch: feed.ch || '', seed: y.video || feed.eps[0]?.id || '' }), feed };
    }
    let id = y?.channel;
    try {
      if (y?.video) {
        const page = await ytGet(`https://www.youtube.com/watch?v=${y.video}&hl=iw`);
        id = page.match(/"videoDetails":\{"videoId":"[\w-]{11}"[^}]*?"channelId":"(UC[\w-]{22})"/)?.[1] || page.match(/itemprop="channelId" content="(UC[\w-]{22})"/)?.[1] || page.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
      } else if (y?.page) {
        const page = await ytGet(y.page + '?hl=iw');
        id = page.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] || page.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
      }
    } catch {}
    if (!id) throw new Error(y?.page ? 'דף הערוץ לא נפתח. הדביקו קישור לפודקאסט עצמו.' : 'לא מצאנו פודקאסט בקישור הזה.');
    return channelPodcasts(id);
  }
  // Apple's lookup (itunes.apple.com) is blocked in NetFree (checked from the Pi 15.11.26): never asked.
  if (appleId(u)) throw new Error('קישורים של אפל פודקאסטים לא נתמכים (חסומים בנטפרי). הדביקו את קישור הפיד של הפודקאסט או קישור מיוטיוב.');
  let text;
  try { text = await proxied(u, { as: 'text', headers: [BROWSER_UA] }); } catch { throw new Error('הקישור לא נפתח.'); }
  let feed;
  try { feed = parseFeed(text); } catch {
    // A web page that names its feed.
    const alt = text.match(/<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]*>/i)?.[0]?.match(/href="([^"]+)"/)?.[1];
    if (!alt) throw new Error('בקישור הזה אין פודקאסט.');
    u = new URL(alt.replace(/&amp;/g, '&'), u).href;
    try { feed = parseFeed(await proxied(u, { as: 'text', headers: [BROWSER_UA] })); } catch { throw new Error('בקישור הזה אין פודקאסט.'); }
  }
  feed.eps = feed.eps.sort((a, b) => b.t - a.t).slice(0, MAX_EPS);
  return { show: showOf('rss', u, feed.name || u), feed };
}

// ---------- the last good data (localStorage) ----------
// { [show key]: { at (last good fetch), tried, failed, name, eps: [{ id, title, t, tx, url, audio, first, open, wait }] },
//   _seenAt, _opened: [key|id], _pending: [{ key, id, at }] }
const DK = 'haluach.podcasts.data';
export const loadData = () => { try { return JSON.parse(localStorage.getItem(DK) || '{}'); } catch { return {}; } };
const saveData = d => { try { localStorage.setItem(DK, JSON.stringify(d)); } catch {} };

/** Joins a fresh list into the old one. New = an id not seen before and newer than every known episode (a deleted
 *  episode must not bring an old one in as "new"). The first fetch of a show marks nothing as new. */
export function merge(old, fresh, now = Date.now()) {
  const prev = new Map((old?.eps || []).map(e => [e.id, e]));
  const maxOld = Math.max(0, ...(old?.eps || []).map(e => e.t || 0));
  const added = [];
  // Undated lists (a playlist panel) come newest first: only what is above the first known episode is new.
  const firstKnown = fresh.eps.findIndex(e => prev.has(e.id));
  const eps = fresh.eps.map((e, i) => {
    const o = prev.get(e.id);
    prev.delete(e.id);
    if (o) return { ...o, title: e.title || o.title, url: e.url ?? o.url, audio: e.audio ?? o.audio, ...(e.tx || !o.t ? { t: e.t || o.t, tx: e.tx } : {}) };
    // A new episode without a date is dated when first seen.
    const t = e.t || (old?.eps?.length && i < firstKnown ? now - i : 0);
    const isNew = !!old?.eps?.length && !!t && t > maxOld - 60_000;
    if (isNew) added.push(e.id);
    return { ...e, t, first: isNew ? now : 0 };
  });
  const all = [...eps, ...prev.values()].sort((a, b) => b.t - a.t).slice(0, MAX_EPS);
  return { entry: { ...(old || {}), name: fresh.name || old?.name || '', eps: all, at: now, tried: now, failed: false }, added: added.filter(id => all.some(e => e.id === id)) };
}

// ---------- NetFree: is an episode open? 418 = blocked (tested on the Pi). Any other answer from the source = not
// blocked by NetFree. No answer = unknown, asked again next time. YouTube: HEAD watch?v=; audio: HEAD of the file. ----------
let headOk = true; // the provider may not pass HEAD: then GET of the watch page (big, so fewer checks)
/** Checks are GETs of whole watch pages now (no HEAD): callers cap them, as podcasts' own loop does. */
export const ytGets = () => !headOk;
export async function epOpen(sh, ep, allowGet) {
  const url = sh.kind === 'ytp' ? `https://www.youtube.com/watch?v=${ep.id}` : ep.audio;
  if (!url) return null;
  const yt = sh.kind === 'ytp';
  try {
    await proxied(url, { method: yt && !headOk ? 'GET' : 'HEAD', cache: false, as: 'text', headers: [BROWSER_UA] });
    return true;
  } catch (e) {
    const st = parseInt(e.message);
    if (st === 418) return false;
    if (yt && st === 405 && headOk) { headOk = false; return allowGet ? epOpen(sh, ep, true) : null; }
    return st >= 400 && st < 500 ? true : null;
  }
}
/** Checks the newest unchecked episodes and re-checks blocked unread ones, at most 20 per poll. Returns the
 *  episodes that opened since the last check: [{ key, ep }]. */
async function checkOpen(shows, data) {
  const opened = new Set(data._opened || []), todo = [];
  for (const sh of shows) {
    for (const ep of (data[sh.key]?.eps || []).slice(0, 10)) {
      if (ep.open == null || (ep.open === false && !opened.has(sh.key + '|' + ep.id))) todo.push({ sh, key: sh.key, ep });
    }
  }
  todo.sort((a, b) => (a.ep.open === false) - (b.ep.open === false) || b.ep.t - a.ep.t);
  const reopened = [];
  let gets = 0;
  await Promise.all([0, 1, 2, 3].map(async w => {
    for (let i = w; i < Math.min(todo.length, 20); i += 4) {
      const x = todo[i];
      if (x.sh.kind === 'ytp' && !headOk && ++gets > 4) continue;
      const was = x.ep.open, now = await epOpen(x.sh, x.ep, true);
      if (now == null) continue;
      x.ep.open = now;
      x.ep.checked = Date.now();
      if (was === false && now) reopened.push(x);
    }
  }));
  return reopened;
}

// ---------- refresh ----------
const DEFAULTS = { shows: [], everyMin: 60, open: 'audio', blocked: 'open' };
/** Old settings followed whole YouTube channels (kind 'yt'): a channel is not a podcast, so they are dropped. */
const followed = s => (s.shows || []).filter(x => x.kind === 'ytp' || x.kind === 'rss');
let busy = null;
/** Fetches every show whose data is older than the interval (force = all). One run at a time. */
function refresh(shows, everyMin, force = false) {
  return busy ||= (async () => {
    const data = loadData(), now = Date.now();
    chanCache = new Map();
    const due = shows.filter(sh => force || !data[sh.key] || now - (data[sh.key].tried || 0) > everyMin * 60_000 - 30_000);
    await Promise.all(due.map(async sh => {
      try {
        const { entry, added } = merge(data[sh.key], await fetchShow(sh, data[sh.key]), Date.now());
        data[sh.key] = entry;
        data._pending = [...(data._pending || []), ...added.map(id => ({ key: sh.key, id, at: Date.now() }))].slice(-60);
      } catch (e) {
        data[sh.key] = { eps: [], ...(data[sh.key] || {}), tried: Date.now(), failed: true };
        log(`podcasts ${sh.name}: ${e.message}`);
      }
    }));
    // Also when a show came in from a pasted link (its data is fresh, its episodes not checked yet).
    if (due.length || shows.some(sh => (data[sh.key]?.eps || []).slice(0, 10).some(ep => ep.open == null))) {
      try { for (const x of await checkOpen(shows, data)) if (x.ep.wait) data._pending = [...(data._pending || []), { key: x.key, id: x.ep.id, at: Date.now(), reopen: true }]; } catch (e) { log('podcasts open check: ' + e.message); }
    }
    data._at = now;
    saveData(data);
    return shows.some(sh => data[sh.key]?.failed);
  })().finally(() => { busy = null; });
}

const epUrl = (sh, ep, s) => sh.kind === 'ytp' ? `https://www.youtube.com/watch?v=${ep.id}` : (s.open === 'page' ? ep.url || ep.audio : ep.audio || ep.url);

/** For app.js liveChecks: fetches what is due and returns the alerts to send once:
 *  [{ id, title, body, url }]. Only shows with "התראה על פרק חדש" on; on shabbat the provider drops them. */
export async function checkAll() {
  const s = cardSettings('podcasts', DEFAULTS), shows = followed(s);
  if (!shows.length) return [];
  await refresh(shows, s.everyMin);
  const data = loadData(), out = [], keep = [];
  for (const p of data._pending || []) {
    const sh = shows.find(x => x.key === p.key), ep = data[p.key]?.eps?.find(e => e.id === p.id);
    if (!sh?.notify || !ep) continue;
    if (s.blocked !== 'all' && !p.reopen) {
      if (ep.open == null) { if (Date.now() - p.at < 2 * 864e5) keep.push(p); continue; }
      if (ep.open === false) { if (s.blocked === 'reopen') ep.wait = true; continue; }
    }
    if (p.reopen && s.blocked !== 'reopen') continue;
    if (p.reopen) ep.wait = false;
    // The same id as src/podcasts.rs (pod-<show key>-<episode id>): the page and the background never send one twice.
    out.push({ id: `pod-${p.key}-${p.id}${p.reopen ? '-o' : ''}`, title: p.reopen ? `נפתח: ${ep.title}` : sh.name, body: p.reopen ? sh.name : ep.title, url: epUrl(sh, ep, s) });
  }
  data._pending = keep;
  saveData(data);
  return out;
}
const hash = t => { let x = 5381; for (const c of String(t)) x = (x * 33 + c.charCodeAt(0)) >>> 0; return x.toString(36); };

// ---------- the card ----------
/** "לפני 3 שעות" (short, Hebrew). */
export function ago(t, now = Date.now()) {
  if (!t) return '';
  const d = Math.max(0, now - t);
  const f = (n, one, two, many) => n === 1 ? `לפני ${one}` : n === 2 && two ? `לפני ${two}` : `לפני ${n} ${many}`;
  if (d < 36e5) return d < 6e4 ? 'עכשיו' : f(Math.floor(d / 6e4), 'דקה', '', 'דק׳');
  if (d < 864e5) return f(Math.floor(d / 36e5), 'שעה', 'שעתיים', 'שעות');
  if (d < 6048e5) return f(Math.floor(d / 864e5), 'יום', 'יומיים', 'ימים');
  if (d < 2592e6) return f(Math.floor(d / 6048e5), 'שבוע', 'שבועיים', 'שבועות');
  if (d < 31536e6) return f(Math.floor(d / 2592e6), 'חודש', 'חודשיים', 'חודשים');
  return f(Math.floor(d / 31536e6), 'שנה', 'שנתיים', 'שנים');
}
const cut = (t, n = 40) => { t = String(t || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const isNew = (sh, ep, data) => ep.first > (data._seenAt || 0) && !(data._opened || []).includes(sh.key + '|' + ep.id);
/** Shown by default: only episodes found open. "all": everything, blocked ones marked. */
const visible = (ep, mode) => mode === 'all' || ep.open === true;
/** Every visible episode of every followed show, newest first: [{ sh, ep }]. */
function episodes(shows, data, mode) {
  return shows.flatMap(sh => (data[sh.key]?.eps || []).filter(ep => visible(ep, mode)).map(ep => ({ sh, ep }))).sort((a, b) => b.ep.t - a.ep.t);
}
/** A podcast with nothing open for a long time: no open episode in the last 60 days, and a blocked one exists. */
export function longBlocked(eps, now = Date.now()) {
  return (eps || []).some(e => e.open === false) && !(eps || []).some(e => e.open === true && now - e.t < 60 * 864e5);
}
const BLOCKED_NOTE = 'אין פרקים פתוחים בנטפרי לאחרונה';

const svg = d => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true">${d}</svg>`;
const I = { x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'), plus: svg('<path d="M8 3v10M3 8h10"/>'), check: svg('<path d="M3.5 8.5l3 3 6-7"/>') };

function epRow({ sh, ep }, data, s, onOpen, showName = true) {
  const open = () => {
    const d = loadData();
    d._opened = [...(d._opened || []), sh.key + '|' + ep.id].slice(-300);
    saveData(d);
    openExternal(epUrl(sh, ep, s));
    onOpen?.();
  };
  return h('div', { class: 'item pod-it', role: 'button', tabindex: 0, title: ep.title, onclick: open, onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } } },
    h('div', {},
      h('div', { class: 'lab' }, isNew(sh, ep, data) ? h('span', { class: 'pod-dot', title: 'חדש' }) : '', showName ? sh.name : '', ep.open === false ? h('span', { class: 'faint' }, showName ? ' · חסום' : 'חסום') : ''),
      h('div', { class: 'val', dir: 'auto' }, ep.title || 'פרק')),
    h('span', { class: 'end faint' }, ago(ep.t)));
}

function allLayer(ctx) {
  const s = ctx.s, shows = followed(s), data = loadData();
  openLayer(body => {
    body.append(h('h2', {}, 'כל הפרקים'));
    for (const sh of shows) {
      const d = data[sh.key];
      const eps = (d?.eps || []).filter(ep => visible(ep, s.blocked)).map(ep => ({ sh, ep }));
      body.append(h('h3', {}, sh.name, d?.failed ? h('span', { class: 'faint' }, ' · לא ענה', d.at ? `, מעודכן ל-${hm(new Date(d.at))}` : '') : ''));
      if (longBlocked(d?.eps)) body.append(h('div', { class: 'faint pod-note' }, BLOCKED_NOTE));
      body.append(...(eps.length ? eps.map(x => epRow(x, data, s, () => ctx.rerender(), false)) : longBlocked(d?.eps) ? [] : [h('div', { class: 'sub' }, d ? 'אין פרקים.' : 'טוען...')]));
    }
    body.append(h('hr', { class: 'sep' }), h('button', { class: 'more', onclick: () => addLayer(ctx) }, 'הוספת פודקאסט'));
  });
  // Opening the list = the new episodes were seen.
  data._seenAt = Date.now();
  saveData(data);
  ctx.rerender();
}

/** What a followed show keeps (the list's category stays in the list). */
const followOf = x => ({ key: x.key, kind: x.kind, src: x.src, name: x.name, notify: false, ...(x.kind === 'ytp' ? { ch: x.ch || '', seed: x.seed || '', asc: !!x.asc } : {}) });

/** Paste a link + the built-in list with a search. `fol` = { has(key), add(show, feed?), remove(key) }. */
function addPanel(fol) {
  const input = h('input', { type: 'url', placeholder: 'קישור לפודקאסט או לערוץ', 'aria-label': 'קישור לפודקאסט' });
  const status = h('div', { class: 'sub pod-status' });
  const picks = h('div', { class: 'pod-pick' });
  const row = x => {
    const b = h('button', { class: 'icon', onclick: () => { fol.has(x.key) ? fol.remove(x.key) : fol.add(followOf(x)); paint(); } });
    const paint = () => { const on = fol.has(x.key); b.innerHTML = on ? I.check : I.plus; b.title = on ? 'הסרה מהמעקב' : 'מעקב'; b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String(on)); };
    paint();
    return h('div', { class: 'pod-pick-row' }, h('span', { class: 'pod-pick-name' }, x.name), x.group ? h('span', { class: 'faint pod-pick-grp' }, x.group) : '', b);
  };
  const add = async () => {
    status.textContent = 'בודק...';
    picks.replaceChildren();
    try {
      const r = await resolveLink(input.value);
      if (r.choices) {
        // A channel: its podcasts, to pick from.
        status.textContent = `הפודקאסטים${r.channel ? ' של ' + r.channel : ''}:`;
        picks.replaceChildren(h('div', { class: 'list' }, ...r.choices.map(row)));
        return;
      }
      if (fol.has(r.show.key)) { status.textContent = 'כבר במעקב.'; return; }
      fol.add(r.show, r.feed);
      input.value = '';
      status.textContent = `נוסף: ${r.show.name}`;
      draw(search.value);
    } catch (e) { status.textContent = e.message; }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  const box = h('div', { class: 'pod-pick' });
  const draw = q => {
    q = norm(q);
    if (q) {
      const f = SUGGESTED.filter(x => norm(x.name + ' ' + x.group).includes(q));
      box.replaceChildren(f.length ? h('div', { class: 'list' }, ...f.map(row)) : h('div', { class: 'sub' }, 'לא נמצא.'));
      return;
    }
    box.replaceChildren(...GROUPS.map(g => { const l = SUGGESTED.filter(x => x.group === g); return h('details', {}, h('summary', {}, g, ' ', h('span', { class: 'faint num' }, l.length)), h('div', { class: 'list' }, ...l.map(x => row({ ...x, group: '' })))); }));
  };
  const search = h('input', { type: 'search', placeholder: 'חיפוש ברשימה', 'aria-label': 'חיפוש ברשימה', oninput: e => draw(e.target.value) });
  draw('');
  return [h('div', { class: 'pod-add' }, input, h('button', { class: 'btn primary', onclick: add }, 'הוספה')), status, picks,
    section('מומלצים'), h('div', { class: 'faint pod-tip' }, 'פתוחים בנטפרי. הפלוס מוסיף למעקב.'), search, box];
}
// A pasted link was already fetched: keep that data, so the card shows it at once.
function keepFeed(show, feed) {
  if (!feed) return;
  const d = loadData();
  d[show.key] = merge(null, feed).entry;
  saveData(d);
}

function addLayer(ctx) {
  openLayer(body => {
    body.append(h('h2', {}, 'הוספת פודקאסט'), ...addPanel({
      has: key => ctx.s.shows.some(x => x.key === key),
      add: (show, feed) => { keepFeed(show, feed); ctx.set({ shows: [...followed(ctx.s), show] }); ctx.rerender(); },
      remove: key => { ctx.set({ shows: followed(ctx.s).filter(x => x.key !== key) }); ctx.rerender(); },
    }));
  });
}

export default {
  id: 'podcasts',
  title: 'פודקאסטים',
  size: [1, 3],
  defaults: DEFAULTS,
  every: ctx => Math.max(15, ctx.s.everyMin || 60) * 60_000,
  async render(el, ctx) {
    const s = ctx.s, shows = followed(s);
    if (shows.length !== (s.shows || []).length) ctx.set({ shows });
    if (!shows.length) {
      el.replaceChildren(h('div', { class: 'sub' }, 'אין פודקאסטים במעקב.'), h('button', { class: 'btn pod-empty', onclick: () => addLayer(ctx) }, 'הוספת פודקאסט'));
      return;
    }
    const draw = (failed, done) => {
      const data = loadData(), list = episodes(shows, data, s.blocked);
      const empty = !done ? 'טוען...' : failed && !list.length ? 'המקורות לא ענו.' : 'אין פרקים פתוחים עדיין.';
      el.replaceChildren(...(list.length ? list.slice(0, 6).map(x => epRow(x, data, s, () => ctx.rerender())) : [h('div', { class: 'sub' }, empty)]),
        h('button', { class: 'more', onclick: () => allLayer(ctx) }, 'כל הפרקים'));
      const oks = shows.map(sh => data[sh.key]?.at).filter(Boolean);
      ctx.stale(oks.length ? new Date(Math.min(...oks)) : null, failed);
    };
    draw(false, false);
    let failed = false;
    try { failed = await refresh(shows, s.everyMin); } catch (e) { failed = true; log('podcasts: ' + e.message); }
    draw(failed, true);
  },
  // Folded: the widget's summary; with nothing followed, the full card (its "הוספת פודקאסט" button).
  compact(ctx) { return followed(ctx?.s || DEFAULTS).length ? this.widget(ctx) : null; },
  async widget(ctx) {
    try {
      const s = ctx?.s || DEFAULTS, shows = followed(s);
      if (!shows.length) return { big: '', sub: 'אין פודקאסטים במעקב', rows: [] };
      let data = loadData();
      if (!data._at || Date.now() - data._at > s.everyMin * 60_000) { try { await refresh(shows, s.everyMin); } catch {} data = loadData(); }
      const list = episodes(shows, data, s.blocked);
      const n = list.filter(x => isNew(x.sh, x.ep, data)).length;
      return {
        big: n ? `${n} חדשים` : '',
        sub: list[0] ? cut(`${list[0].sh.name}: ${list[0].ep.title}`, 60) : 'אין פרקים עדיין',
        rows: list.slice(1, 5).map(x => [x.sh.name, cut(x.ep.title), isNew(x.sh, x.ep, data)]),
        // One summary per podcast, for a widget set (התאמה אישית) to one of them.
        per: Object.fromEntries(shows.map(sh => {
          const eps = list.filter(x => x.sh.key === sh.key), k = eps.filter(x => isNew(x.sh, x.ep, data)).length;
          return [sh.key, { name: sh.name, big: k ? `${k} חדשים` : '', sub: eps[0] ? cut(eps[0].ep.title, 60) : 'אין פרקים עדיין',
            rows: eps.slice(1, 4).map(x => [cut(x.ep.title), '', isNew(x.sh, x.ep, data)]) }];
        })),
      };
    } catch { return { big: '', sub: 'אין נתוני פודקאסטים', rows: [] }; }
  },
  settings(box, ctx) {
    // The followed podcasts: a switch for "a new episode" alerts, and removal. Adding is in the card ("הוספת פודקאסט").
    const data = loadData();
    const list = h('div', { class: 'form' });
    const draw = () => {
      const shows = followed(ctx.s);
      list.replaceChildren(...(shows.length ? shows.map(sh => h('div', { class: 'srow' },
        h('span', { class: 'pod-show-name' }, sh.name, longBlocked(data[sh.key]?.eps) ? h('span', { class: 'hint' }, BLOCKED_NOTE) : ''),
        h('span', { class: 'pod-show-ctl' },
          h('input', { type: 'checkbox', checked: !!sh.notify, title: 'התראה על פרק חדש', 'aria-label': 'התראה על פרק חדש: ' + sh.name,
            onchange: e => ctx.set({ shows: followed(ctx.s).map(x => x.key === sh.key ? { ...x, notify: e.target.checked } : x) }) }),
          h('button', { class: 'icon', title: 'הסרה מהמעקב', 'aria-label': 'הסרה מהמעקב', html: I.x, onclick: () => { ctx.set({ shows: followed(ctx.s).filter(x => x.key !== sh.key) }); ctx.rerender(); draw(); } }))))
        : [h('div', { class: 'sub' }, 'אין פודקאסטים במעקב.')]));
    };
    draw();
    box.append(section('במעקב'), list,
      h('div', { class: 'hint' }, 'המתג ליד פודקאסט: התראה על פרק חדש. בשבת ובחג לא יוצאת'),
      h('button', { class: 'btn', onclick: () => addLayer(ctx) }, 'הוספת פודקאסט'),
      section('הצגה'),
      row('פרקים בכרטיס', select([['open', 'רק פתוחים בנטפרי'], ['reopen', 'רק פתוחים, והתראה כשנפתח'], ['all', 'הכל, גם חסומים']], s0(ctx).blocked, v => { ctx.set({ blocked: v }); ctx.rerender(); })),
      row('פרק נפתח ב', choice([['audio', 'קובץ השמע'], ['page', 'דף הפרק']], s0(ctx).open, v => ctx.set({ open: v })), 'בדפדפן'),
      more(row('בדיקת פרקים חדשים', select([[30, 'כל חצי שעה'], [60, 'כל שעה'], [180, 'כל 3 שעות'], [360, 'כל 6 שעות'], [720, 'פעמיים ביום']], s0(ctx).everyMin, v => ctx.set({ everyMin: +v })))));
  },
};
const s0 = ctx => ({ ...DEFAULTS, ...ctx.s });

export const css = `
.pod-it { cursor: pointer; border-radius: var(--radius-s); }
.pod-it:hover .val { color: var(--accent); }
.pod-it > div { min-width: 0; flex: 1; }
.pod-it .lab, .pod-it .val { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pod-it > .end { font-size: 12px; }
.pod-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); margin-inline-end: 5px; vertical-align: 1px; }
.pod-note { display: block; font-size: 12px; }
.pod-add { display: flex; gap: 6px; padding-top: 6px; }
.pod-add input { flex: 1; min-width: 0; }
.pod-pick { display: grid; gap: 2px; margin-top: 6px; }
.pod-pick-row { display: flex; align-items: center; gap: 6px; padding-inline-start: 10px; }
.pod-pick-name { flex: 1; min-width: 0; }
.pod-pick-grp { font-size: 12px; flex: none; }
.pod-pick .icon[aria-pressed="true"] { color: var(--accent); }
.pod-show-name { min-width: 0; }
.pod-show-ctl { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.pod-tip { font-size: 12.5px; margin-bottom: 4px; }
.pod-status:empty { display: none; }
.pod-status { padding-top: 6px; }
.expand-body > input[type=search], .form > input[type=search] { width: 100%; }
`;
