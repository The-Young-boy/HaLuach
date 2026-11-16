// The "now" strip on top of the board (approved draft: brand/redesign.html): the next time from the user's own
// list (cards/zmanim.js) in large type with a countdown, the three after it, the sun on its arc, and a footer line
// for shabbat / yom tov (the parasha; candles before, havdalah during). Redrawn every 30 seconds.
import { HDate, flags } from '@hebcal/core';
import { settings, cardSettings, zmanim, zmanText, h, log } from './core.js';
import { chosen } from './cards/zmanim.js';
import { upcoming, parashaOf } from './cards/shabbat.js';
import { holidays, evName } from './cards/calendar-heb.js';

export const left = ms => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'עכשיו';
  if (m < 60) return `בעוד ${m} דקות`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return `בעוד ${hh === 1 ? 'שעה' : hh === 2 ? 'שעתיים' : hh + ' שעות'}${mm ? ` ו-${mm} דקות` : ''}`;
};

/** The moon's age in the month, 0..1 (0 = new, .5 = full), from a known new moon (6.1.2000 18:14 UTC). */
export function moonAge(d) {
  const syn = 29.530588853 * 86400_000;
  return ((((d - Date.UTC(2000, 0, 6, 18, 14)) / syn) % 1) + 1) % 1;
}
/** The moon's disc lit by its age: the outer edge on the lit side, then the terminator (an ellipse) back. */
function moonDisc(cx, cy, r, age) {
  const waxing = age < .5, crescent = age < .25 || age > .75;
  const rx = Math.abs(Math.cos(2 * Math.PI * age)) * r;
  const lit = `M${cx} ${cy - r}A${r} ${r} 0 0 ${waxing ? 1 : 0} ${cx} ${cy + r}A${rx.toFixed(2)} ${r} 0 0 ${waxing ? (crescent ? 0 : 1) : (crescent ? 1 : 0)} ${cx} ${cy - r}Z`;
  return `<circle cx="${cx}" cy="${cy}" r="${r - .5}" fill="var(--card)" stroke="var(--moon)" stroke-opacity=".6"/><path d="${lit}" fill="var(--moon)"/>`;
}

/** The arc: by day the sun from sunrise (right, east) to sunset (left); by night the moon, with its phase, from
 *  sunset to the next sunrise. (The moon is drawn on the night arc, not where it really is.) */
/** marks: the chosen times inside the day ([name, Date]), small ticks on the path with the name as a tooltip. */
function arc(rise, set, now, night, marks = []) {
  const W = 220, H = 92, x0 = 206, x1 = 14, base = 80;
  const f = rise && set ? Math.min(1, Math.max(0, (now - rise) / (set - rise))) : 0;
  const pt = t => { const x = x0 + (x1 - x0) * t; const y = base - 66 * 4 * t * (1 - t); return [x, y]; };
  const [sx, sy] = pt(f);
  const col = night ? 'currentColor' : 'var(--sun)';
  const pts = []; for (let i = 0; i <= 20; i++) pts.push(pt(f * i / 20).map(v => v.toFixed(1)).join(' '));
  const done = `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-opacity="${night ? .35 : 1}" stroke-width="2.5" stroke-linecap="round"/>`;
  const path = []; for (let i = 0; i <= 40; i++) path.push(pt(i / 40).map(v => v.toFixed(1)).join(' '));
  const body = night ? moonDisc(+sx.toFixed(1), +sy.toFixed(1), 8, moonAge(now)) : `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="8" fill="var(--sun)"/>`;
  return `<svg class="arc" viewBox="0 0 ${W} ${H + 4}" aria-hidden="true">
    <line x1="4" y1="${base}" x2="${W - 4}" y2="${base}" stroke="currentColor" stroke-opacity=".15"/>
    <polyline points="${path.join(' ')}" fill="none" stroke="${col}" stroke-opacity="${night ? .25 : .45}" stroke-width="2" stroke-dasharray="3 5"/>
    ${marks.filter(([, t]) => t > rise && t < set).map(([n, t, k]) => { const [x, y] = pt((t - rise) / (set - rise)); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="currentColor" opacity="${t < now ? .3 : .6}"><title>${n} ${zmanText(t, k)}</title></circle>`; }).join('')}
    ${done}${body}
    <text x="${W - 2}" y="${H + 2}" font-size="10" text-anchor="end" fill="currentColor" opacity=".55">${zmanText(rise, 'sec')}</text>
    <text x="2" y="${H + 2}" font-size="10" text-anchor="start" fill="currentColor" opacity=".55">${zmanText(set, 'sec')}</text>
  </svg>`;
}

/** A menorah with n of 8 lights lit, and the shamash (SVG, the flames flicker). */
function menorah(n) {
  let lights = '';
  for (let i = 0; i < 8; i++) {
    const x = 6 + i * 9 + (i > 3 ? 8 : 0);   // right to left in the picture is the order of adding; draw all 8
    const on = 7 - i < n;                    // the lit ones are on the right (the first candle on the right)
    lights += `<rect x="${x - 1}" y="14" width="2" height="9" fill="currentColor" opacity="${on ? .9 : .3}"/>`;
    if (on) lights += `<path class="flame" d="M${x} 7c-2 3-2 5 0 6 2-1 2-3 0-6z" fill="var(--sun)"/>`;
  }
  return `<svg class="menorah" viewBox="0 0 92 34" aria-hidden="true">${lights}
    <rect x="45" y="10" width="2" height="13" fill="currentColor" opacity=".9"/><path class="flame" d="M46 3c-2 3-2 5 0 6 2-1 2-3 0-6z" fill="var(--sun)"/>
    <path d="M6 23h80M46 23v8M38 31h16" stroke="currentColor" stroke-width="1.6" fill="none" opacity=".7"/></svg>`;
}

/** The special day's line (SPEC "ימים מיוחדים"): Chanukah lights tonight, a fast's start and end, erev Pesach's
 *  chametz times. HTML for the foot, or ''. */
function specialDay(now, z, zt, w) {
  const il = !!settings().loc?.il;
  const mine = id => chosen(cardSettings('zmanim')).find(t => t.id === id)?.method;
  const noon = d => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
  const evs = d => holidays(new HDate(noon(d)), il);
  const tomorrow = new Date(+now + 86400_000);
  // Chanukah: hebcal puts "Chanukah: N Candles" on the civil day whose evening has N lights.
  const ch = evs(now).find(e => e.getFlags() & flags.CHANUKAH_CANDLES);
  if (ch && z?.sunset) {
    const n = +(/(\d+)/.exec(ch.getDesc())?.[1] || 1);
    const name = ['', 'נר ראשון', 'נר שני', 'נר שלישי', 'נר רביעי', 'נר חמישי', 'נר שישי', 'נר שביעי', 'נר שמיני'][n];
    const t = z[mine('tzeit')] || z.tzeit_8_5;
    const when = now.getDay() === 5 ? `לפני הדלקת נרות שבת${w ? ` <b class="num">${zmanText(w.start, 'down')}</b>` : ''}`
      : now.getDay() === 6 ? (w ? `אחרי הבדלה <b class="num">${zmanText(w.end, 'up')}</b>` : 'אחרי הבדלה')
      : `שקיעה <b class="num">${zmanText(z.sunset, 'sec')}</b> · צאת <b class="num">${zmanText(t, 'up')}</b>`;
    return `<span class="special">${menorah(n)}חנוכה, ${name} הלילה</span><span>${when}</span>`;
  }
  // Erev Pesach: the last time to eat chametz (4 hours) and to burn it (5), Gra and Magen Avraham (72 minutes).
  const ep = evs(now).find(e => /Erev Pesach/.test(e.getDesc()));
  if (ep && z?.sunrise && z?.sunset) {
    const hour = (a, b, k) => new Date(+a + (b - a) / 12 * k);
    const ma = [new Date(+z.sunrise - 72 * 60_000), new Date(+z.sunset + 72 * 60_000)];
    return `<span>ערב פסח</span><span>אכילת חמץ עד <b class="num">${zmanText(hour(z.sunrise, z.sunset, 4), 'down')}</b> (מג״א <b class="num">${zmanText(hour(...ma, 4), 'down')}</b>) · ביעור עד <b class="num">${zmanText(hour(z.sunrise, z.sunset, 5), 'down')}</b> (מג״א <b class="num">${zmanText(hour(...ma, 5), 'down')}</b>)</span>`;
  }
  // A fast: today (until it ends) or tomorrow (from the afternoon before).
  for (const [d, zz] of [[now, z], [tomorrow, zt]]) {
    const f = evs(d).find(e => (e.getFlags() & (flags.MINOR_FAST | flags.MAJOR_FAST)) && !(e.getFlags() & flags.EREV));
    if (!f || !zz) continue;
    const major = !!(f.getFlags() & flags.MAJOR_FAST);
    const end = zz[mine('tzeit')] || zz.tzeit_8_5;
    const start = major ? new Date(+(d === now ? z : zz).sunset - 86400_000) : zz[mine('alot')] || zz.alot_72deg;
    if (now > end) continue;
    if (d === tomorrow && now.getHours() < 12) continue;
    const startTxt = major ? (d === now ? 'התחיל אתמול בשקיעה' : `מתחיל בשקיעה <b class="num">${zmanText(z.sunset, 'sec')}</b>`) : `מתחיל <b class="num">${zmanText(start, 'sec')}</b>`;
    return `<span>${evName(f)}${d === tomorrow ? ' (מחר)' : ''}</span><span>${startTxt} · נגמר <b class="num">${zmanText(end, 'up')}</b></span>`;
  }
  // Purim (Shushan Purim in Jerusalem): the Megillah at night from nightfall, and in the day from sunrise.
  const purim = /ירושלים|Jerusalem/.test(settings().loc?.name || '') ? 'Shushan Purim' : 'Purim';
  const isPurim = d => evs(d).some(e => e.getDesc() === purim);
  if (isPurim(now) && z?.sunrise && now < z.sunset) return `<span>${purim === 'Purim' ? 'פורים' : 'שושן פורים'}</span><span>קריאת המגילה מהנץ <b class="num">${zmanText(z.sunrise, 'sec')}</b> · עד השקיעה <b class="num">${zmanText(z.sunset, 'sec')}</b></span>`;
  if (isPurim(tomorrow) && z?.sunset && now.getHours() >= 12) {
    const t = z[mine('tzeit')] || z.tzeit_8_5;
    return `<span>${purim === 'Purim' ? 'פורים' : 'שושן פורים'} הלילה</span><span>קריאת המגילה מצאת הכוכבים <b class="num">${zmanText(t, 'up')}</b></span>`;
  }
  return '';
}

// A failure keeps the last strip; it is logged once until a drawing works again.
let nowFailed = false;
export async function drawNow() {
  // The board is closed: nothing to draw (the strip draws again when it opens).
  if (document.hidden) return;
  try { await drawNowInner(); nowFailed = false; }
  catch (e) { if (!nowFailed) { nowFailed = true; log(`now strip: ${e?.message || e}`); } }
}
async function drawNowInner() {
  const el = document.getElementById('now');
  const loc = settings().loc;
  if (!loc) { el.hidden = true; return; }
  const now = new Date();
  const [z, zt] = await Promise.all([zmanim(now), zmanim(new Date(+now + 86400_000))]);
  if (!z) { el.hidden = true; return; }
  // The user's chosen times, today and then tomorrow (after the last one tonight).
  const list = [...chosen(cardSettings('zmanim')).filter(t => t.on).map(t => ({ name: t.name, at: z[t.method], round: t.round })),
                ...chosen(cardSettings('zmanim')).filter(t => t.on).map(t => ({ name: t.name, at: zt?.[t.method], round: t.round }))]
    .filter(t => t.at && +t.at > +now);
  const [next, ...rest] = list;
  // Footer: shabbat / yom tov when it is near (from 24 hours before the candles) or running; otherwise the parasha.
  let foot = '';
  try {
    const w = (await upcoming(3, now))[0];
    const sp = specialDay(now, z, zt, w);
    if (sp) foot = sp;
    else if (w && now >= w.start) foot = `<span>${w.name}</span><span>${w.name.startsWith('שבת') ? 'צאת השבת' : 'צאת החג'} <b class="num">${zmanText(w.end, 'up')}</b></span>`;
    else if (w && w.start - now < 24 * 3600_000) foot = `<span>${w.name}</span><span>הדלקת נרות <b class="num">${zmanText(w.start, 'down')}</b> · ${left(w.start - now)}</span>`;
    else {
      // Motzaei shabbat already belongs to next week's parasha.
      let d = new Date(now); if (d.getDay() === 6 && z.sunset && now > z.sunset) d.setDate(d.getDate() + 1);
      while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
      // The parasha of the week ("פרשת ויצא" all week, not "שבת פרשת"); a shabbat that is a festival keeps its name.
      foot = `<span>${parashaOf(new HDate(d))}</span>`;
    }
  } catch {}
  // Built first, then swapped in: a throw on the way keeps the last strip.
  const parts = [
    h('div', {},
      next ? h('div', { class: 'lbl' }, next.name) : h('div', { class: 'lbl' }, 'אין עוד זמנים היום'),
      next ? h('div', { class: 'bigtime num' }, zmanText(next.at, next.round)) : '',
      next ? h('div', { class: 'left' }, left(next.at - now)) : '',
      h('div', { class: 'then' }, ...rest.slice(0, 3).map(t => h('span', {}, t.name, h('b', { class: 'num' }, zmanText(t.at, t.round)))))),
    h('div', { html: (() => {
      const rise = z.sunrise_vis || z.sunrise, set = z.sunset_vis || z.sunset;
      if (now >= rise && now <= set) return arc(rise, set, now, false, chosen(cardSettings('zmanim')).filter(t => t.on && z[t.method]).map(t => [t.name, z[t.method], t.round]));
      // Night: from tonight's sunset to tomorrow's sunrise, or (before dawn) from last night's sunset to today's sunrise.
      return now > set ? arc(set, zt?.sunrise_vis || zt?.sunrise, now, true) : arc(new Date(+set - 86400_000), rise, now, true);
    })() }),
    foot ? h('div', { class: 'foot', html: foot }) : '',
  ];
  el.replaceChildren(...parts);
  el.hidden = false;
}
