# Design rules for the cards (binding)

The approved look: `brand/redesign.html` (open it at http://localhost:5181/brand/redesign.html when the dev server
runs, or read the file). Windows 11 widgets-board language. The user said the previous design was "very bad",
cluttered and did not follow dark mode. These rules exist to fix exactly that.

## Hard rules
1. **Use only the building blocks in `web/src/style.css`.** Rows: `.row` (label + value; `.past`, `.next`), `.item`
   (`.lab` small grey label above `.val` bold value, `.end` for a trailing link/button), `.big` (one large number),
   `.chips`/`.chip` (`.on`), `.more` (a "show more" link button), `.link`, `.num`, `.up`/`.down`, `hr.sep`,
   `.btn`/`.btn.primary`, `.sub`, `.faint`. Forms in settings: `.form`, `label`, `.check`.
2. **No colours of your own.** Only the tokens: `--fg --fg2 --fg3 --accent --on-accent --fill --fill-2 --stroke
   --card --sun --good --bad`. No hex/rgb in card CSS (the sun/weather icons may use `--sun`). Dark mode then works
   by itself. Never `#fff`/`#000`.
3. **A card is as tall as its content.** No fixed heights, no `overflow: auto`/scrollbars inside a card, no empty
   boxes. Nothing may stick out of the card at 280px width.
4. **Show little.** At most 6 rows (or one big value + 4 rows). Everything else goes in a detail layer:
   `openLayer(body => ...)`, opened by a `.more` button ("עוד", "כל הזמנים", "פירוט") or by clicking the main item.
5. **Numbers with a sign or a unit** (‎-213.73, ‎+0.25%, ‎25°) go in `<span class="num">`, the unit outside it:
   `h('span', {}, h('span', { class: 'num' }, '-213.73'), ' מ׳')`.
6. **Icons:** inline SVG, 16px, `stroke="currentColor"` or `fill="currentColor"`, thin (1.3). No emoji, no ⚙ ✕ ▶
   characters as icons.
7. **Text:** Hebrew, short. Card titles are drawn by core.js; do not add another title inside. Empty states one short
   line in `.sub`. No em-dash.
8. **Keep every feature and setting.** This is a visual rewrite: data, logic, exports (`widget()`, `upcoming()`,
   etc.) and settings stay as they are. Settings forms use `.form`.
9. Remove the card's old CSS that the building blocks replace. Keep only small layout bits the blocks cannot do.

## Check
- `node web/build.mjs` must pass.
- No browser (the owner reviews every card in both themes in the browser). Re-read your render code for rules 2-6.

## Inner menus: the open card and its settings (binding, 15.11.26)
The user: the main page is fine; "הבעיה בעיקר בתפריטים פנימיים של הרבה דברים". These rules fix that.

1. **Saves by itself.** Every change is saved at once (`ctx.set` on change; `ctx.rerender()` after, debounced for text fields). No "שמירה" button. The only button at the end is none: the ✕ of the panel folds it. (Exception: a form that creates one thing, e.g. a new personal date or a new alarm: there a primary "הוספה" button is right.)
2. **One row per setting:** the label on the right (with an optional `.hint` line under it in grey), the control at the end. Switches for on/off. A setting that depends on another (a threshold of an alert, minutes of a reminder) is shown only while its switch is on, indented, right under it.
3. **The right control size:** a number gets a narrow field (`class: 'n'`, about 72px) with its unit after it ("15 דק׳", "0.2 מ״מ"); a choice of 2-4 short options is a segmented row of chips (`.chips` with `.chip.on`), not a dropdown; a longer choice is a `select`; text fields take the row's width only when the text is long (search, name).
4. **Short and grouped:** at most about 8 rows in view. Sections with a grey `h3`. Rare settings go under one "עוד הגדרות" (`details.more-set`) at the end. Long lists (stations, towns, podcasts, sounds per alert type) are collapsible groups (`details > summary`, styled by style.css: a row with a chevron and a count), or a search with results.
5. **No repetition with the card:** the open card shows and does things (lists, actions); the settings only choose and set. A list that is already in the open card (radio stations, podcasts to follow) is not repeated in settings: settings links to it ("בחירת תחנות" opens the card's list).
6. **Words:** short Hebrew labels in the user's words; no technical terms (no "RSS", "API", "SIRI", "curlbus", "Open-Meteo" in the UI); a hint only when the label is not enough.
7. **Where things open (the user, 15.11.26):** the header's place button, "+" and gear, and the first-run wizard open in
   a popup sheet as in HaFeed (`openSheet(title, build, { tabs })` in core.js). Only what is inside a card (its
   details and its own settings) opens in place, inside that card (`openLayer`).
8. Everything else in this file still holds (tokens only, SVG icons, `.num` for numbers with units).

## Motion (shared with HaFeed, 15.11.26)
Every change slides or fades, never jumps. The same helpers and CSS as HaFeed's feed.html "motion" block; a change to
the shared CSS (motion, tokens, switches, the settings sheet) is sent to HaFeed's session in one line, and back.
- A tab (the board's, the settings sheet's): `vt(fn, dir, kind)` in core.js. The content slides from the tab's side,
  the underline (`<i class="ink">`, not `::after`) glides. A layer name exists only during its own transition.
- A card's height (opened, folded, new data): renderCard measures before and calls `growFrom(card, h0)` after the
  drawing. Never animate a card's height anywhere else.
- Each drawing of a card gets its own box (`.card-draw`, `display: contents`), started with the previous content: a
  slow drawing writes into a box no longer shown, and a refresh does not flash empty.
- A layer inside a card that closes: `collapse`. One replaced by another: gone at once (closeLayer(box, true)).
- Something that shows or hides with `hidden`: give it the class `fold` (or `.dep` from ui.js toggle). Not a list of
  ids. A section of the settings sheet gets an entry fade only (an exit fade keeps it on screen during a tab's slide).
- A list sorted by dragging (cards, the radio's favourites): `liveDrag(e, el, items, done, tap)` in core.js. The others
  step aside while dragging (class `shift`); no marker line, no redraw after the drop.
- A picture: `lazyfade` + `in` on load (an insert animation is over before a slow picture arrives).
- Colours, radius, easing from the tokens only: `--good`, `--bad`, `--on-accent`, `--radius`, `--ease`.
- `prefers-reduced-motion`: all of it off, View Transitions included.
- Checking it in the dev pane: when the pane does not paint (behind another window), animations stay at 0 and
  `display` transitions do not end. That is the pane, not the board.
- Decided with HaFeed (the user, 15.11.26, after a mockup; "הכל יהיה גם בלוח"): `--good`/`--bad` are Windows' semantic
  colours; text on the accent is white in both themes; a bottom notice (toast) is the accent with `--on-accent` text,
  an undo bar is a raised surface with an accent "ביטול" button; both `--radius` and `bottom: 18px`.
