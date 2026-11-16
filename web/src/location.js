// Picking the location: Windows' location (default), or a search over every place (Open-Meteo geocoding, in Hebrew).
// The elevation comes from Open-Meteo too (the zmanim "מהגובה" and the visible sunrise need it).
import { h, proxied, save, settings, BROWSER_UA } from './core.js';

/** A place from coordinates: the nearest name and the elevation. */
export async function placeFrom(lat, lng, name) {
  const el = await proxied(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`).catch(() => null);
  const elev = Math.max(0, Math.round(el?.elevation?.[0] ?? 0));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { name: name || 'המיקום שלי', lat: +(+lat).toFixed(5), lng: +(+lng).toFixed(5), elev, tz, il: inIsrael(lat, lng) };
}
/** Rough box of Israel (with Judea, Samaria and the Golan): for Israel/diaspora rules (yom tov sheni, parasha). */
export function inIsrael(lat, lng) { return lat > 29.4 && lat < 33.4 && lng > 34.2 && lng < 35.95; }

/** The town at these coordinates (OpenStreetMap), so a place from Windows shows where Windows thinks you are. */
export async function townAt(lat, lng) {
  const d = await proxied(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=he&zoom=12`, { headers: [BROWSER_UA] }).catch(() => null);
  const a = d?.address || {};
  return a.city || a.town || a.village || a.suburb || a.municipality || d?.name || '';
}
export async function fromWindows() {
  const g = await fetch('geo').then(r => r.json()).catch(() => ({ ok: false }));
  if (!g.ok) return null;
  const town = await townAt(g.lat, g.lng);
  return { ...(await placeFrom(g.lat, g.lng, town ? `${town} (לפי Windows)` : 'המיקום שלי (לפי Windows)')), windows: true };
}

export async function search(q) {
  if (!q.trim()) return [];
  const d = await proxied(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&language=he&count=8`).catch(() => null);
  return (d?.results || []).map(r => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', '),
    lat: r.latitude, lng: r.longitude, elev: Math.max(0, Math.round(r.elevation ?? 0)), tz: r.timezone, il: r.country_code === 'IL' || inIsrael(r.latitude, r.longitude),
  }));
}

/** The picker: a "my location" button and a search box with results. `done(loc)` with the chosen place. */
export function picker(box, done) {
  const status = h('div', { class: 'sub' });
  const results = h('div', { class: 'list' });
  const input = h('input', { type: 'search', placeholder: 'חיפוש עיר או יישוב', autofocus: true });
  let t = 0, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      // A slower answer to an older search must not replace a newer one.
      const my = ++seq;
      const list = await search(input.value);
      if (my !== seq) return;
      results.replaceChildren(...list.map(p => h('button', { onclick: () => done(p) }, p.name)));
      if (!list.length && input.value.trim()) results.replaceChildren(h('div', { class: 'sub' }, 'לא נמצא מקום בשם הזה.'));
    }, 300);
  });
  const mine = h('button', { class: 'btn', onclick: async () => {
    status.textContent = 'מבקש את המיקום מ-Windows...';
    const p = await fromWindows();
    if (p) done(p);
    else status.textContent = 'Windows לא נתן מיקום (אפשר להפעיל ב: הגדרות > פרטיות > מיקום). בחרו עיר מהרשימה.';
  } }, h('span', { html: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" style="vertical-align:-3px;margin-inline-end:6px"><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14z"/><circle cx="8" cy="6.5" r="1.6"/></svg>' }), 'לפי המיקום שלי');
  box.append(mine, status, input, results);
}

export function setLocation(loc) { save({ loc }); }
export function current() { return settings().loc; }
