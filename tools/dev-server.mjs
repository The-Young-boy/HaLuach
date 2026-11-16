// Dev server: serves src/board.html at /board/ and answers the provider's routes the same way
// (zmanim through the release exe's CLI, proxy through Node fetch). Port 5181.
// node tools/dev-server.mjs   (rebuild the page with node web/build.mjs first)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(root, 'target', 'release', 'haluach-widget.exe');
const settingsFile = join(root, 'target', 'dev-settings.json');
const cache = new Map();

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const route = u.pathname.replace(/^\/board\/?/, '');
  // Design drafts: /brand/<file>
  if (u.pathname.startsWith('/brand/')) { try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(root, 'brand', u.pathname.slice(7).replace(/[^\w.-]/g, '')))); } catch { res.writeHead(404); return res.end(); } }
  const send = (body, type = 'application/json', status = 200) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
  try {
    if (route === 'zmanim') return send(execFileSync(exe, ['--zmanim', u.search.slice(1)]).toString());
    if (route === 'version') return send('dev', 'text/plain');
    if (route === 'accent') return send('', 'text/plain');
    // A pinned shabbat widget set to Jerusalem (shabbat.js per).
    if (route === 'customs') return send(u.searchParams.get('k') === 'shabbat' ? JSON.stringify([JSON.stringify({ name: 'ירושלים', lat: 31.778, lng: 35.235, elev: 754 })]) : '[]');
    if (route === 'metered') return send('0', 'text/plain');
    if (route === 'geo') return send(JSON.stringify({ ok: true, lat: 32.0849, lng: 34.8352, accuracy: 50 }));
    if (route === 'log') { console.log('page:', u.searchParams.get('m')); return send('ok', 'text/plain'); }
    if (route === 'notify') { console.log('notify:', Object.fromEntries(u.searchParams)); return send('', 'text/plain'); }
    if (route === 'radio') { console.log('radio:', Object.fromEntries(u.searchParams)); return send(JSON.stringify({ playing: false, volume: 0.8, sleepLeft: 0, want: '' })); }
    if (route === 'schedule') { const d = JSON.parse(u.searchParams.get('d') || '{}'); console.log('schedule:', d.plan?.length, 'items,', d.quiet?.length, 'quiet'); return send(String(d.plan?.length || 0), 'text/plain'); }
    // forums.rs in the exe; here a made-up sample for the card's look (two forums connected). Never reads a body.
    if (route === 'forum') {
      const t = Date.now(), it = (id, text, m, unread) => ({ id, text, url: 'https://mitmachim.top/post/' + id, at: t - m * 60_000, unread });
      const f = (id, name, url, kind, x) => ({ id, name, url, kind, connected: false, mode: null, user: null, pending: false, failed: null, unread: null, chats: null, items: [], at: null, err: null, ...x });
      return send(JSON.stringify({ quiet: false, forums: [
        f('mitmachim', 'מתמחים טופ', 'https://mitmachim.top', 'nodebb', { connected: true, mode: 'window', unread: 3, chats: 1, at: t, items: [it('1', 'משה הגיב בנושא עדכון לתוכנה', 4, true), it('2', 'דוד הזכיר אותך בשאלה על נטפרי', 50, true), it('3', 'יוסי הצביע לפוסט שלך', 300, false)] }),
        f('prog', 'פרוג', 'https://www.prog.co.il', 'xenforo', { connected: true, mode: 'creds', user: 'test', unread: 1, chats: 0, at: t, items: [it('9', 'אבי הגיב לנושא מתכון לשבת', 20, true)] }),
      ] }));
    }
    // The packaged station logos (main.rs serves them from the install folder).
    if (route === 'station') {
      const id = u.searchParams.get('id') || '';
      const f = new URL(`../package/Images/stations/${id}.png`, import.meta.url);
      if (!/^[a-z0-9-]+$/i.test(id) || !existsSync(f)) { res.writeHead(404); return res.end(); }
      return send(readFileSync(f), 'image/png');
    }
    if (route === 'open') { console.log('open:', u.searchParams.get('u')); return send('', 'text/plain'); }
    if (route === 'settings') {
      // The page sends it as a POST body now (an address is too short); the query still works.
      let d = u.searchParams.get('d');
      if (req.method === 'POST') { let b = ''; for await (const c of req) b += c; d = b || d; }
      if (d) writeFileSync(settingsFile, d);
      return send(existsSync(settingsFile) ? readFileSync(settingsFile) : '{}');
    }
    if (route === 'proxy') {
      const url = u.searchParams.get('u');
      const method = u.searchParams.get('m') || 'GET';
      const headers = {};
      for (const h of u.searchParams.getAll('h')) { const i = h.indexOf(':'); headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
      if (u.searchParams.get('t')) headers['Content-Type'] = u.searchParams.get('t');
      headers['User-Agent'] ??= 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach';
      const key = u.search;
      if (method === 'GET' && cache.has(key) && Date.now() - cache.get(key).t < 60_000) { const c = cache.get(key); return send(c.body, c.type, c.status); }
      const r = await fetch(url, { method, headers, body: method === 'POST' ? u.searchParams.get('b') : undefined });
      const body = Buffer.from(await r.arrayBuffer());
      const type = r.headers.get('content-type') || 'application/octet-stream';
      if (method === 'GET') cache.set(key, { t: Date.now(), body, type, status: r.status });
      return send(body, type, r.status);
    }
    return send(readFileSync(join(root, 'src', 'board.html')), 'text/html; charset=utf-8');
  } catch (e) { console.error(route, e.message); send(String(e.message), 'text/plain', 500); }
}).listen(5181, () => console.log('http://localhost:5181/board/'));
