// Every card except zmanim (which app.js imports for the wizard). Order = the default board order.
// A card's CSS: its `css` property (or a named `css` export); app.js adds them to the page.
import radio, { css as radioCss } from './radio.js';
import podcasts, { css as podcastsCss } from './podcasts.js';
import youtube, { css as youtubeCss } from './youtube.js';
import weather from './weather.js';
import rates from './rates.js';
import kinneret from './kinneret.js';
import transit, { css as transitCss } from './transit.js';
import shipments, { css as shipmentsCss } from './shipments.js';
import tools, { css as toolsCss } from './tools.js';
import redalert, { css as redalertCss } from './redalert.js';
import shabbat, { css as shabbatCss } from './shabbat.js';
import learning, { css as learningCss } from './learning.js';
import omer, { css as omerCss } from './omer.js';
import calendar, { css as calendarCss } from './calendar.js';
import personal, { css as personalCss } from './personal.js';
import forums, { css as forumsCss } from './forums.js';

export const cards = [shabbat, learning, weather, radio, podcasts, youtube, omer, calendar, personal, rates, kinneret, transit, shipments, tools, redalert, forums];
export const css = [radioCss, podcastsCss, youtubeCss, transitCss, shipmentsCss, toolsCss, redalertCss, shabbatCss, learningCss, omerCss, calendarCss, personalCss, forumsCss, ...cards.map(c => c.css || '')].join('\n');
