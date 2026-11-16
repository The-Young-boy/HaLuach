// Links that open a text in Otzaria / Zayit (SPEC "קישורים לאוצריא ולזית"): the provider's deep link to the place
// (/board/book, from the app's seforim.db), else the app's search. Which buttons show: the installed apps
// (/board/apps), of cardSettings('learning').apps.
import { h, openExternal, cardSettings } from '../core.js';
import { OTZARIA, ZAYIT } from './app-logos.js';

const LOGOS = { otzaria: OTZARIA, zayit: ZAYIT };

export const APPS = { otzaria: 'אוצריא', zayit: 'זית' };

export function appUrl(app, q, { daily = false } = {}) {
  if (app === 'otzaria') return daily ? 'otzaria://open/daily_page' : 'otzaria://open/search?q=' + encodeURIComponent(q);
  if (app === 'zayit') return 'zayit://search/' + encodeURIComponent(q);
  return '';
}

// The installed apps, asked once per board load. Until it answers, or when it fails: all of them (the old way).
let installed = null;
export const appsReady = fetch('apps').then(r => r.ok ? r.json() : null).then(a => { if (Array.isArray(a)) installed = a; }).catch(() => {});
export function installedApps() { return Object.keys(APPS).filter(a => !installed || installed.includes(a)); }

/** The apps to show: the installed ones; when the user chose a default app, only it. */
export function shownApps() {
  const s = cardSettings('learning', { apps: ['otzaria', 'zayit'], prefer: '' });
  const apps = (s.apps || []).filter(a => APPS[a] && installedApps().includes(a));
  return s.prefer && apps.includes(s.prefer) ? [s.prefer] : apps;
}

/** The deep link to `place` (see learning-places.js), or '' when the app's DB does not have it. */
async function deepLink(app, place) {
  try {
    const r = await fetch(`book?app=${app}&q=${encodeURIComponent(JSON.stringify(place))}`);
    return r.ok ? (await r.text()).trim() : '';
  } catch { return ''; }
}

/** Small link buttons, one per app. `daily` = the daf yomi page in Otzaria; `place` = where it is in the library. */
export function linkButtons(q, opts = {}) {
  // The app's logo, not its name; the name is in the tooltip ("פתיחה בזית").
  return shownApps().map(app => h('button', {
    class: 'app-link', title: 'פתיחה ב' + APPS[app], 'aria-label': 'פתיחה ב' + APPS[app],
    onclick: async e => {
      e.stopPropagation();
      const daily = opts.daily && app === 'otzaria';
      openExternal((!daily && opts.place && await deepLink(app, opts.place)) || appUrl(app, q, { daily }));
    },
  }, h('img', { class: 'lazyfade', src: LOGOS[app], alt: '', width: 22, height: 22, onload: e => e.target.classList.add('in') })));
}

/** The links sit in a `.lnks` box (a gap between them). */
export const linkCss = `.lnks { display: inline-flex; gap: 6px; align-items: center; }
.app-link { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--radius-s); background: none; cursor: pointer; }
.app-link:hover { background: var(--fill); }
.app-link img { width: 22px; height: 22px; display: block; }`;
