// Renders the three blueprint views in docs/preview.html to PNGs in docs/screens/.
//
//   NODE_PATH="$(npm root -g)" node docs/render-screens.mjs [desktop.png] [mobile.png]
//
// The optional arguments also save full-page screenshots at desktop and phone width.
// Behind an HTTPS proxy whose CA Chromium does not trust, the web fonts are fetched
// with curl (which uses the system CA configuration) and handed to the page.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(join(here, 'preview.html')).href;
const outDir = join(here, 'screens');
const views = { 'bp-ready': 'ready.png', 'bp-running': 'running.png', 'bp-gameover': 'gameover.png' };
const [desktopShot, mobileShot] = process.argv.slice(2);

const behindProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
const browser = await chromium.launch();

async function serveFontsViaCurl(page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    const req = route.request();
    const url = req.url();
    try {
      const body = execFileSync('curl', ['-sS', '--fail', '--max-time', '20', '-A', req.headers()['user-agent'] || 'Mozilla/5.0', url]);
      const contentType = url.includes('googleapis') ? 'text/css; charset=utf-8'
        : url.endsWith('.ttf') ? 'font/ttf' : 'font/woff2';
      await route.fulfill({ status: 200, contentType, headers: { 'access-control-allow-origin': '*' }, body });
    } catch {
      await route.abort();
    }
  });
}

async function open(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (behindProxy) await serveFontsViaCurl(page);
  await page.goto(pageUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.documentElement.dataset.blueprints === 'ready', null, { timeout: 20000 });
  return { page, errors };
}

try {
  const { page, errors } = await open({ width: 1200, height: 900 });

  const annotated = await page.evaluate(() => document.documentElement.dataset.annotated);
  if (!annotated || annotated === 'missing') throw new Error('View B was rendered without its dimension annotations');

  const fonts = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`));

  mkdirSync(outDir, { recursive: true });
  for (const [id, file] of Object.entries(views)) {
    const dataUrl = await page.evaluate((i) => document.getElementById(i).toDataURL('image/png'), id);
    writeFileSync(join(outDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }

  if (desktopShot) await page.screenshot({ path: desktopShot, fullPage: true });
  if (mobileShot) {
    const mobile = await open({ width: 390, height: 844 });
    errors.push(...mobile.errors);
    const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) errors.push(`page scrolls sideways by ${overflow}px at 390px width`);
    await mobile.page.screenshot({ path: mobileShot, fullPage: true });
  }

  console.log(JSON.stringify({ annotated, fonts: [...new Set(fonts)], errors, wrote: Object.values(views) }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
