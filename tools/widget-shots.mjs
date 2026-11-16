// Dev aid: every widget card in every size as a PNG (2x), light and dark, and a check of each card
// (the Adaptive Cards renderer's validation, Microsoft's 1/3/4 click targets, content taller than the widget).
// node tools/widget-shots.mjs [out dir] [kinds,comma,separated] [data folder]
//   out dir:     default target/widget-shots
//   data folder: the widgets.json + settings.json to draw from; default the installed dev app's
//                %LOCALAPPDATA%\Packages\HaLuachWidget_*\LocalCache\Local\HaLuach
// Needs target/release/haluach-widget.exe (cargo build --release) and Edge. Exits 1 when a card has a problem.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outDir = join(root, 'target', 'widget-shots'), kinds = '', folderArg] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const pk = join(process.env.LOCALAPPDATA, 'Packages');
const pkg = existsSync(pk) && readdirSync(pk).find((d) => d.startsWith('HaLuachWidget_'));
const folder = folderArg || (pkg ? join(pk, pkg, 'LocalCache', 'Local', 'HaLuach') : '');
const cardsFile = join(mkdtempSync(join(tmpdir(), 'haluach-cards-')), 'cards.json');
execFileSync(join(root, 'target', 'release', 'haluach-widget.exe'), ['--widgets', cardsFile, ...(folder ? [folder] : [])]);

const preview = join(root, 'tools', 'widget-preview');
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
  const file = name === 'cards.json' ? cardsFile : join(preview, name.replace(/[^\w.-]/g, ''));
  let body;
  try { body = readFileSync(file); } catch { return res.writeHead(404).end(); }
  res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' }).end(body);
}).listen(0);
const port = server.address().port;

const CDP = 9341;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'haluach-wshots-'))}`, '--no-first-run', '--hide-scrollbars', 'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40 && !targets; i++) { await sleep(250); targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.exceptionThrown') console.log('page error:', d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
};
const cdp = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const value = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 3000, deviceScaleFactor: 2, mobile: false });
let problems = [];
for (const theme of ['light', 'dark']) {
  await cdp('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await cdp('Page.navigate', { url: `http://localhost:${port}/?${kinds}${theme === 'dark' ? '#dark' : ''}` });
  for (let i = 0; i < 60 && !(await value('window.done === true')); i++) await sleep(250);
  await sleep(500);
  const boxes = JSON.parse(await value(`JSON.stringify([...document.querySelectorAll(".row")].flatMap((row) => [...row.querySelectorAll(".w")].map((w) => { const r = w.getBoundingClientRect(); return { kind: row.id.slice(2), size: w.classList[1], x: r.x, y: r.y, w: r.width, h: r.height }; })))`));
  for (const b of boxes) {
    const png = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 }, captureBeyondViewport: true });
    writeFileSync(join(outDir, `widget-${b.kind}-${b.size}-${theme}.png`), Buffer.from(png.result.data, 'base64'));
  }
  if (theme === 'light') problems = await value('window.problems');
  console.log(theme, boxes.length, 'cards');
}
ws.close(); edge.kill(); server.close();
console.log(problems.length ? 'problems:\n  ' + problems.join('\n  ') : 'all cards valid');
console.log('PNGs in', outDir);
process.exit(problems.length ? 1 : 0);
