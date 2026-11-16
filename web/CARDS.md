# Writing a card (for whoever builds cards in parallel)

Read first: `../SPEC.md` (the user's decisions - they are binding; when the spec says "המשתמש בוחר", the
choice goes into the card's settings), `../research/sources.md` (which sources work, from where, and how).

## Files
- One module per card: `web/src/cards/<id>.js`, `export default { ... }`. Helpers of your own: `web/src/cards/<id>-*.js`.
- **Do not edit** `core.js`, `app.js`, `style.css`, `cards/index.js`, `board.html` or any Rust file. If you need
  something there, write it in your final report (exact code), and the owner adds it.
- Card-specific CSS: export `css` (a string) from the module; the owner adds it to the page. Use the tokens in
  `style.css` (`--accent --card --card-2 --fg --sub --line --good --bad --radius --num`), never fixed colours.

## The module
```js
import { h, hm, proxied, BROWSER_UA, zmanim, settings, openExternal, notify, openLayer, log, ymd } from '../core.js';
export default {
  id: 'weather',            // stable, lowercase
  title: 'מזג אוויר',
  size: [1, 3],             // default grid span: columns, rows (row = 96px)
  hiddenByDefault: false,
  defaults: { ... },        // this card's settings
  every: 30 * 60_000,       // re-render interval (ms) or (ctx) => ms; omit if static
  async render(el, ctx) {}, // fill el (replace its children). ctx.s = settings (defaults + saved), ctx.set(patch),
                            // ctx.stale(lastOkDate, failed) marks "updated HH:MM" + red dot after a failure,
                            // ctx.rerender(). Keep the last good data in localStorage and show it on failure.
  settings(box, ctx) {},    // optional: the card's settings form in the layer; call ctx.set(patch) then ctx.done().
};
```
- `settings().loc` = `{ name, lat, lng, elev, tz, il }` (null until chosen: then say "בחרו מיקום בהגדרות").
- `proxied(url, { method, body, type, headers: ['Name: value'], as: 'json'|'text'|'buffer' })` = fetch through the
  provider (no CORS). IMS, data.gov.il and boi.org.il need `headers: [BROWSER_UA]`.
- `zmanim(date)` = `{ engineId: Date }` from the Rust engine (ids in `cards/zmanim.js` TIMES).
- `@hebcal/core` and `@hebcal/learning` are installed (`import { HDate, HebrewCalendar, ... } from '@hebcal/core'`).
- Hebrew UI only. Short texts. No em-dash anywhere (use "-"). Hebrew date format: כ״ד כסלו תשפ״ז (gershayim, no ה' of the thousands).
- Never decide product parameters silently: when unsure, make it a setting, default per SPEC, and list it in your report.
- No new npm packages without listing why in the report.

## Checking your work
- `node web/build.mjs` must pass (esbuild bundles everything that `cards/index.js` imports; to test your card
  before it is registered, temporarily import it in a scratch entry - do not leave scratch files).
- Data logic: write it as pure functions in your module and check them with a small `node` script against real
  responses (then delete the script). The browser pane is busy: do not use it.

## Report (your final message)
Files you wrote; what each setting does and its default; the sources used; anything left open; exact code the
owner must add elsewhere (index.js line, css, Rust routes).
