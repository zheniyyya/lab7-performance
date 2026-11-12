import { build, preview } from 'vite';
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const RUNS = Number(args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 3);
const PORT = 4174;
const URL = `http://localhost:${PORT}/`;
const CPU_SLOWDOWN = 4;

const WATCH = [
  'weightedRating', 'tutorScore', 'getVisibleTutors', 'applyFilters', 'matchesQuery', 'normalizeText',
  'formatPrice', 'averageRating', 'update', 'TutorCard', 'TutorList', 'RatingStars',
  'Filters', 'buildSubjectOptions', 'slugify', 'suggestNames', 'editDistance', 'EmptyState',
  'generateTutors', 'makeReviews', 'makeBio', 'isoDate', 'useReferenceData', 'load', 'fetchRegions',
  'useBioClamp', 'measure', 'App',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function chromePath() {
  const p = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean).find((x) => existsSync(x));
  if (!p) throw new Error('Не знайдено Chrome. Вкажіть шлях у змінній CHROME_PATH.');
  return p;
}

function analyze(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const name = (n) => n.callFrame.functionName || '(anonymous)';
  const self = new Map();
  const total = new Map();
  let busy = 0;
  profile.samples.forEach((id, i) => {
    const dt = (profile.timeDeltas[i] || 0) / 1000;
    const node = byId.get(id);
    const n = name(node);
    if (n === '(idle)') return;
    busy += dt;
    const label = node.callFrame.url ? n : n === '(program)' || n === '(garbage collector)' ? n : `${n} [native]`;
    self.set(label, (self.get(label) || 0) + dt);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const fn = name(byId.get(cur));
      if (!seen.has(fn)) {
        seen.add(fn);
        total.set(fn, (total.get(fn) || 0) + dt);
      }
    }
  });
  return { self, total, busy };
}

async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  return { context, page, cdp };
}

const idle = (page, ms = 600) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))).then(() => sleep(ms));

async function typeText(cdp, page, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await idle(page, 150);
  }
}

async function toGrid(page) {
  await page.evaluate(() => {
    const grid = document.querySelector('.tutor-grid');
    window.scrollTo(0, grid.getBoundingClientRect().top + window.scrollY - 140);
  });
  await idle(page, 600);
}

async function clickAt(page, el) {
  const b = await el.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

const SCENARIOS = {
  'load (завантаження)': async ({ page, cdp }) => {
    await cdp.send('Profiler.start');
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.tutor-card', { timeout: 120000 });
    await idle(page, 1500);
  },
  'type "фізика"': async ({ page, cdp }) => {
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.tutor-card', { timeout: 120000 });
    await idle(page, 1000);
    await clickAt(page, await page.$('input[type=search]'));
    await idle(page);
    await cdp.send('Profiler.start');
    await typeText(cdp, page, 'фізика');
    await idle(page);
  },
  'type "Шевчнко" (нічого не знайдено, показує підказки)': async ({ page, cdp }) => {
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.tutor-card', { timeout: 120000 });
    await idle(page, 1000);
    await clickAt(page, await page.$('input[type=search]'));
    await typeText(cdp, page, 'Шевчн');
    await idle(page);
    await cdp.send('Profiler.start');
    await typeText(cdp, page, 'ко');
    await idle(page);
  },
  'favorite x3': async ({ page, cdp }) => {
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.tutor-card', { timeout: 120000 });
    await idle(page, 1000);
    await toGrid(page);
    await cdp.send('Profiler.start');
    for (const i of [0, 1, 2]) {
      await clickAt(page, (await page.$$('.tutor-card__fav'))[i]);
      await idle(page, 300);
    }
  },
  'scroll 20x300px': async ({ page, cdp }) => {
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForSelector('.tutor-card', { timeout: 120000 });
    await idle(page, 1000);
    await toGrid(page);
    await page.mouse.move(683, 384);
    await cdp.send('Profiler.start');
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel({ deltaY: 300 });
      await sleep(100);
    }
    await idle(page);
  },
};

async function main() {
  console.log('Збираю dist-profile/ (без мініфікації)...');
  await build({ logLevel: 'warn', build: { minify: false, outDir: 'dist-profile', sourcemap: false, emptyOutDir: true } });
  const server = await preview({ logLevel: 'warn', build: { outDir: 'dist-profile' }, preview: { port: PORT, strictPort: true } });
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
  console.log(`${await browser.version()}, CPU ${CPU_SLOWDOWN}x, ${RUNS} запуски на сценарій, медіана\n`);

  try {
    for (const [title, run] of Object.entries(SCENARIOS)) {
      const results = [];
      for (let i = 0; i < RUNS; i++) {
        const ctx = await newPage(browser);
        await run(ctx);
        const { profile } = await ctx.cdp.send('Profiler.stop');
        results.push(analyze(profile));
        await ctx.context.close();
      }
      const med = (key, fn) => median(results.map((r) => r[key].get(fn) || 0));
      console.log(`=== ${title}: зайнятий потік ~${median(results.map((r) => r.busy)).toFixed(0)} мс`);
      const names = new Set(results.flatMap((r) => [...r.self.keys()]));
      const top = [...names].map((n) => [n, med('self', n)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
      console.log('  Bottom-Up (self), топ-10:');
      for (const [n, v] of top) console.log(`    ${v.toFixed(1).padStart(9)} мс  ${n}`);
      console.log('  Окремі функції (total / self):');
      for (const fn of WATCH) {
        const t = med('total', fn);
        if (t > 0) console.log(`    ${fn.padEnd(20)} ${t.toFixed(1).padStart(9)} / ${med('self', fn).toFixed(1)} мс`);
      }
      console.log('');
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
