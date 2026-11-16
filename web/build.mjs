// Builds src/board.html (the one page the provider embeds) from web/board.html + web/src/*.js.
// Run: node web/build.mjs   (tools/deploy.ps1 runs it before cargo build)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// "מה חדש" in the settings (About): the project's CHANGELOG.md, built into the page (none yet: a short line).
const changelog = join(here, '..', 'CHANGELOG.md');
const out = await build({
  entryPoints: [join(here, 'src', 'app.js')],
  bundle: true, format: 'iife', minify: true, write: false, target: 'chrome120', charset: 'utf8',
  legalComments: 'none',
  define: { __CHANGELOG__: JSON.stringify(existsSync(changelog) ? readFileSync(changelog, 'utf8') : '') },
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync(join(here, 'src', 'style.css'), 'utf8');
const html = readFileSync(join(here, 'board.html'), 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('%LOGO%', () => readFileSync(join(here, 'src', 'logo64.txt'), 'utf8').trim())
  .replace('/*JS*/', () => js);
writeFileSync(join(here, '..', 'src', 'board.html'), html);
console.log(`board.html ${(html.length / 1024).toFixed(0)}KB`);
