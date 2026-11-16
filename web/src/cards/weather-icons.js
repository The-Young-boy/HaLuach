// Animated weather icons (SVG + CSS). Kinds: clear, partly, cloudy, rain, drizzle, thunder, snow, fog, dust, wind.
// The animations stop under "reduce motion" (the global rule in style.css).

/** WMO weather code (Open-Meteo) -> [kind, Hebrew text]. */
export function wmo(code) {
  const c = +code;
  if (c === 0) return ['clear', 'בהיר'];
  if (c === 1) return ['partly', 'בהיר בעיקר'];
  if (c === 2) return ['partly', 'מעונן חלקית'];
  if (c === 3) return ['cloudy', 'מעונן'];
  if (c === 45 || c === 48) return ['fog', 'ערפל'];
  if (c >= 51 && c <= 57) return ['drizzle', 'טפטוף'];
  if (c >= 61 && c <= 67) return ['rain', c >= 65 ? 'גשם חזק' : 'גשם'];
  if (c >= 71 && c <= 77) return ['snow', 'שלג'];
  if (c >= 80 && c <= 82) return ['rain', 'ממטרים'];
  if (c === 85 || c === 86) return ['snow', 'ממטרי שלג'];
  if (c >= 95) return ['thunder', 'סופות רעמים'];
  return ['cloudy', ''];
}

/** IMS weather code (isr_cities.xml) -> [kind, Hebrew text]. */
const IMS = {
  1250: ['clear', 'בהיר'], 1220: ['partly', 'מעונן חלקית'], 1230: ['cloudy', 'מעונן'],
  1530: ['partly', 'מעונן חלקית, אפשרות לגשם'], 1540: ['cloudy', 'מעונן, אפשרות לגשם'], 1560: ['drizzle', 'מעונן, גשם קל'],
  1140: ['rain', 'גשום'], 1020: ['thunder', 'סופות רעמים'], 1510: ['thunder', 'סוער'], 1010: ['dust', 'סופות חול'],
  1570: ['dust', 'אובך'], 1160: ['fog', 'ערפל'], 1260: ['wind', 'רוחות חזקות'], 1270: ['clear', 'חם ולח'],
  1310: ['clear', 'חם'], 1580: ['clear', 'חם מאוד'], 1320: ['cloudy', 'קר'], 1300: ['clear', 'קרה'],
  1060: ['snow', 'שלג'], 1070: ['snow', 'שלג קל'], 1080: ['snow', 'שלג מעורב בגשם'], 1520: ['snow', 'שלג כבד'],
};
export function imsCode(code) { return IMS[+code] || null; }

const CLOUD = 'M20 46h26a10 10 0 0 0 0-20 14 14 0 0 0-27-2 11 11 0 0 0 1 22z';
const sun = (cx, cy, r) => `<g class="wx-sun"><g class="wx-rays">${[0, 45, 90, 135, 180, 225, 270, 315].map(a =>
  `<line x1="${cx}" y1="${cy - r - 4}" x2="${cx}" y2="${cy - r - 9}" transform="rotate(${a} ${cx} ${cy})"/>`).join('')}</g><circle cx="${cx}" cy="${cy}" r="${r}"/></g>`;
// A crescent: the left half circle minus a narrower left half ellipse.
const moon = (cx, cy, r) => `<path class="wx-moon" d="M${cx} ${cy - r}A${r} ${r} 0 0 0 ${cx} ${cy + r}A${r * .55} ${r} 0 0 1 ${cx} ${cy - r}z"/>`;
const cloud = (cls = '') => `<path class="wx-cloud ${cls}" d="${CLOUD}"/>`;
const drops = (n, cls) => Array.from({ length: n }, (_, i) =>
  `<line class="${cls}" style="animation-delay:${(i * .35).toFixed(2)}s" x1="${24 + i * 9}" y1="50" x2="${21 + i * 9}" y2="57"/>`).join('');
const flakes = () => [0, 1, 2].map(i => `<circle class="wx-flake" style="animation-delay:${i * .6}s" cx="${24 + i * 9}" cy="52" r="2"/>`).join('');

export function icon(kind, night = false, size = 40) {
  const body = night ? moon(26, 24, 11) : sun(26, 24, 10);
  let g;
  switch (kind) {
    case 'clear': g = night ? moon(32, 30, 15) : sun(32, 32, 12); break;
    case 'partly': g = body + cloud('wx-drift'); break;
    case 'cloudy': g = `<path class="wx-cloud back wx-drift" transform="translate(-8 -8) scale(.8)" d="${CLOUD}"/>` + cloud('wx-drift2'); break;
    case 'drizzle': g = cloud() + drops(3, 'wx-drop light'); break;
    case 'rain': g = cloud() + drops(4, 'wx-drop'); break;
    case 'thunder': g = cloud() + drops(2, 'wx-drop') + '<path class="wx-bolt" d="M33 44l-6 10h6l-3 8 9-12h-6l3-6z"/>'; break;
    case 'snow': g = cloud() + flakes(); break;
    case 'fog': g = [24, 32, 40].map((y, i) => `<line class="wx-fog" style="animation-delay:${i * .5}s" x1="12" y1="${y}" x2="52" y2="${y}"/>`).join(''); break;
    case 'dust': g = body + [0, 1, 2, 3, 4].map(i => `<circle class="wx-dust" style="animation-delay:${i * .4}s" cx="${14 + i * 9}" cy="${44 + (i % 2) * 6}" r="2"/>`).join(''); break;
    case 'wind': g = '<path class="wx-wind" d="M10 26h30a6 6 0 1 0-6-6M10 36h40a6 6 0 1 1-6 6M10 46h22"/>'; break;
    default: g = cloud();
  }
  return `<svg class="wx-icon" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">${g}</svg>`;
}

// Token colours only: the sun and the bolt are --sun, everything else currentColor (the icon is --fg3 by default).
export const iconCss = `
.wx-icon { overflow: visible; flex: none; color: var(--fg3); }
.wx-sun circle { fill: var(--sun); }
.wx-rays line { stroke: var(--sun); stroke-width: 3; stroke-linecap: round; }
.wx-rays { transform-box: fill-box; transform-origin: center; animation: wx-spin 24s linear infinite; }
.wx-moon { fill: currentColor; opacity: .85; }
.wx-cloud { fill: currentColor; opacity: .75; }
.wx-cloud.back { opacity: .45; }
.wx-drift { animation: wx-drift 6s ease-in-out infinite alternate; }
.wx-drift2 { animation: wx-drift 8s ease-in-out infinite alternate-reverse; }
.wx-drop { stroke: var(--fg2); stroke-width: 2.5; stroke-linecap: round; animation: wx-fall 1.2s linear infinite; }
.wx-drop.light { stroke-width: 1.6; animation-duration: 1.6s; }
.wx-flake { fill: var(--fg2); animation: wx-snow 2.4s linear infinite; }
.wx-bolt { fill: var(--sun); animation: wx-flash 3s steps(1) infinite; }
.wx-fog { stroke: currentColor; stroke-width: 3; stroke-linecap: round; opacity: .75; animation: wx-drift 4s ease-in-out infinite alternate; }
.wx-dust { fill: currentColor; animation: wx-blow 2s linear infinite; }
.wx-wind { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-dasharray: 60 20; animation: wx-dash 2.5s linear infinite; }
@keyframes wx-spin { to { transform: rotate(360deg); } }
@keyframes wx-drift { from { transform: translateX(-2px); } to { transform: translateX(3px); } }
@keyframes wx-fall { from { transform: translateY(-4px); opacity: 0; } 30% { opacity: 1; } to { transform: translateY(6px); opacity: 0; } }
@keyframes wx-snow { from { transform: translate(0, -3px); opacity: 0; } 30% { opacity: 1; } to { transform: translate(2px, 8px); opacity: 0; } }
@keyframes wx-flash { 0%, 100% { opacity: 1; } 10% { opacity: .2; } 14% { opacity: 1; } 18% { opacity: .3; } }
@keyframes wx-blow { from { transform: translateX(6px); opacity: 0; } 40% { opacity: 1; } to { transform: translateX(-8px); opacity: 0; } }
@keyframes wx-dash { to { stroke-dashoffset: -80; } }
`;
