// Builds docs/preview.html, then renders its four blueprint views to PNGs in
// docs/screens/ for the README.
//
//   NODE_PATH="$(npm root -g)" node docs/render-screens.mjs [desktop.png] [mobile.png]
//
// The optional arguments also save full-page screenshots at desktop and phone
// width. Exits non-zero on page errors or if the page scrolls sideways at
// phone width. Behind an HTTPS proxy whose CA Chromium does not trust, the web
// fonts are fetched with curl (which uses the system CA configuration).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPreview } from './build-preview.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(buildPreview()).href;
const outDir = join(here, 'screens');
const views = ['port', 'route', 'flight', 'arrival'];
const [desktopShot, mobileShot] = process.argv.slice(2);
const behindProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
const browser = await chromium.launch();

async function serveFontsViaCurl(page) {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
    const req = route.request();
    const url = req.url();
    try {
      const body = execFileSync('curl', ['-sS', '--fail', '--max-time', '20', '-A', req.headers()['user-agent'] || 'Mozilla/5.0', url]);
      const contentType = url.includes('googleapis') ? 'text/css; charset=utf-8' : url.endsWith('.ttf') ? 'font/ttf' : 'font/woff2';
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
  await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 30000 });
  return { page, errors };
}

try {
  const { page, errors } = await open({ width: 1240, height: 900 });
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith('.png')) rmSync(join(outDir, f));
  for (const v of views) {
    await page.locator(`#scene-${v}`).screenshot({ path: join(outDir, `${v}.png`) });
  }
  const fonts = await page.evaluate(() =>
    [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))]);
  if (desktopShot) await page.screenshot({ path: desktopShot, fullPage: true });
  if (mobileShot) {
    const mobile = await open({ width: 390, height: 844 });
    errors.push(...mobile.errors);
    const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) errors.push(`page scrolls sideways by ${overflow}px at 390px width`);
    await mobile.page.screenshot({ path: mobileShot, fullPage: true });
  }
  console.log(JSON.stringify({ fonts, errors, wrote: views.map((v) => `${v}.png`) }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
