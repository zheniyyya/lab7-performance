import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import lighthouse, { desktopConfig } from 'lighthouse';

const ALL = ['lighthouse', 'load', 'type', 'favorite', 'details', 'scroll'];
const args = process.argv.slice(2);
const label = args.find((a, i) => !a.startsWith('--') && !['--runs', '--only', '--url'].includes(args[i - 1])) || 'run';
const RUNS = Number(option('--runs', 5));
const ONLY = option('--only', ALL.join(',')).split(',');
const TRACE = args.includes('--trace');
const HEADLESS = !args.includes('--headed');
const URL = option('--url', 'http://localhost:4173/');

const CPU_SLOWDOWN = 4;
const VIEWPORT = { width: 1366, height: 768 };
const QUERY = 'фізика';
const OUT = join(process.cwd(), 'report');
const FAST_4G = {
  offline: false,
  downloadThroughput: ((9 * 1000 * 1000) / 8) * 0.9,
  uploadThroughput: ((1.5 * 1000 * 1000) / 8) * 0.9,
  latency: 60 * 2.75,
};

function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Не знайдено Chrome. Вкажіть шлях у змінній CHROME_PATH.');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const OBSERVERS = `
  window.__perf = { events: [], longtasks: [], shifts: [], lcp: 0, lcpElement: '', t0: 0 };
  const observe = (type, cb) => new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true, durationThreshold: 16 });
  observe('event', (e) => {
    if (e.interactionId) window.__perf.events.push({ id: e.interactionId, name: e.name, start: e.startTime, duration: e.duration });
  });
  observe('longtask', (e) => window.__perf.longtasks.push({ start: e.startTime, duration: e.duration }));
  observe('largest-contentful-paint', (e) => {
    window.__perf.lcp = e.startTime;
    window.__perf.lcpElement = e.element ? e.element.tagName.toLowerCase() + '.' + e.element.className : e.url;
  });
  observe('layout-shift', (e) => {
    if (!e.hadRecentInput) window.__perf.shifts.push({ start: e.startTime, value: e.value });
  });
`;

async function afterPaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

async function settle(page, ms = 1000) {
  await afterPaint(page);
  await sleep(ms);
}

async function markStart(page) {
  await page.evaluate(() => {
    window.__perf.t0 = performance.now();
  });
}

async function collect(page) {
  return page.evaluate(() => {
    const { events, longtasks, shifts, t0, lcp, lcpElement } = window.__perf;
    const byId = new Map();
    for (const e of events) {
      if (e.start < t0) continue;
      const prev = byId.get(e.id);
      if (!prev || e.duration > prev.duration) byId.set(e.id, e);
    }
    const lts = longtasks.filter((t) => t.start >= t0);
    let cls = 0;
    let win = 0;
    let first = 0;
    let last = 0;
    for (const s of shifts.filter((x) => x.start >= t0)) {
      if (win && s.start - last < 1000 && s.start - first < 5000) {
        win += s.value;
      } else {
        win = s.value;
        first = s.start;
      }
      last = s.start;
      cls = Math.max(cls, win);
    }
    return {
      interactions: [...byId.values()].sort((a, b) => a.start - b.start),
      longTasks: {
        count: lts.length,
        total: lts.reduce((s, t) => s + t.duration, 0),
        max: lts.reduce((m, t) => Math.max(m, t.duration), 0),
        blocking: lts.reduce((s, t) => s + Math.max(0, t.duration - 50), 0),
      },
      cls,
      lcp,
      lcpElement,
    };
  });
}

async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(VIEWPORT);
  await page.evaluateOnNewDocument(OBSERVERS);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  return { context, page, cdp };
}

async function openApp(browser) {
  const app = await newPage(browser);
  await app.page.goto(URL, { waitUntil: 'load', timeout: 180000 });
  await settle(app.page, 1500);
  return app;
}

async function scrollToGrid(page) {
  await page.evaluate(() => {
    const grid = document.querySelector('.tutor-grid');
    window.scrollTo(0, grid.getBoundingClientRect().top + window.scrollY - 140);
  });
  await settle(page, 800);
}

async function clickCenter(page, element) {
  const box = await element.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'v8.execute',
  'blink.console',
  'blink.user_timing',
  'latencyInfo',
  'loading',
];

async function compactTrace(file) {
  const trace = JSON.parse(await readFile(file, 'utf8'));
  const events = trace.traceEvents || trace;
  const mainThreads = events.filter(
    (e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain'
  );
  const rendererPids = new Set(mainThreads.map((e) => e.pid));
  const mainTids = new Set(mainThreads.map((e) => `${e.pid}:${e.tid}`));
  const isNoiseTask = (e) =>
    e.name === 'RunTask' && (!mainTids.has(`${e.pid}:${e.tid}`) || (e.dur ?? 0) < 100);
  const kept = events.filter(
    (e) =>
      e.ph === 'M' ||
      e.name === 'TracingStartedInBrowser' ||
      (rendererPids.has(e.pid) && !isNoiseTask(e)) ||
      (e.name !== 'RunTask' && e.cat?.includes('devtools.timeline'))
  );
  const homeInJson = JSON.stringify(os.homedir()).slice(1, -1);
  const json = JSON.stringify({ ...(trace.traceEvents ? trace : {}), traceEvents: kept });
  await writeFile(file, json.split(homeInJson).join('~'));
}

async function withTrace(page, file, fn) {
  if (file) {
    await mkdir(join(OUT, 'traces'), { recursive: true });
    await page.tracing.start({ path: file, categories: TRACE_CATEGORIES });
  }
  try {
    return await fn();
  } finally {
    if (file) {
      await page.tracing.stop();
      await compactTrace(file);
    }
  }
}

const durations = (r) => r.interactions.map((i) => i.duration);

const scenarios = {
  async load(browser, traceFile) {
    const { context, page, cdp } = await newPage(browser);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', FAST_4G);
    let bytes = 0;
    let requests = 0;
    cdp.on('Network.loadingFinished', (e) => {
      bytes += e.encodedDataLength;
      requests += 1;
    });
    await withTrace(page, traceFile, async () => {
      await page.goto(URL, { waitUntil: 'load', timeout: 180000 });
      await page.waitForSelector('.tutor-card', { timeout: 180000 });
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 180000 });
      await settle(page, 1000);
    });
    const r = await collect(page);
    await context.close();
    return {
      lcp: r.lcp,
      cls: r.cls,
      longTasksTotal: r.longTasks.total,
      blocking: r.longTasks.blocking,
      bytes,
      requests,
      lcpElement: r.lcpElement,
    };
  },

  async type(browser, traceFile) {
    const { context, page, cdp } = await openApp(browser);
    const input = await page.$('input[type=search]');
    await clickCenter(page, input);
    await settle(page, 500);
    await markStart(page);
    await withTrace(page, traceFile, async () => {
      for (const ch of QUERY) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await settle(page, 200);
      }
      await settle(page, 500);
    });
    const value = await page.$eval('input[type=search]', (el) => el.value);
    if (value !== QUERY) throw new Error(`type: у полі "${value}", очікувалось "${QUERY}"`);
    const r = await collect(page);
    await context.close();
    return {
      inp: Math.max(16, ...durations(r)),
      keyMedian: median(durations(r)) ?? 16,
      longTasksTotal: r.longTasks.total,
      blocking: r.longTasks.blocking,
    };
  },

  async favorite(browser, traceFile) {
    const { context, page } = await openApp(browser);
    await scrollToGrid(page);
    await markStart(page);
    await withTrace(page, traceFile, async () => {
      for (const [step, i] of [0, 1, 2, 0, 1, 2].entries()) {
        const buttons = await page.$$('.tutor-card__fav');
        await clickCenter(page, buttons[i]);
        await settle(page, 300);
        if (step === 2) {
          const fav = await page.$eval('.header__favorites', (el) => el.textContent);
          if (!fav.includes('3')) throw new Error(`favorite: у шапці "${fav}", очікувалось 3 обраних`);
        }
      }
    });
    const r = await collect(page);
    await context.close();
    return {
      inp: Math.max(16, ...durations(r)),
      clickMedian: median(durations(r)) ?? 16,
      longTasksTotal: r.longTasks.total,
      blocking: r.longTasks.blocking,
    };
  },

  async details(browser, traceFile) {
    const { context, page } = await openApp(browser);
    await scrollToGrid(page);
    await markStart(page);
    await withTrace(page, traceFile, async () => {
      for (const i of [0, 1, 2]) {
        const buttons = await page.$$('.tutor-card .button--ghost');
        await clickCenter(page, buttons[i]);
        await settle(page, 400);
        if (!(await page.$('.drawer'))) throw new Error('details: картка не відкрилась');
        await page.keyboard.press('Escape');
        await settle(page, 400);
        if (await page.$('.drawer')) throw new Error('details: картка не закрилась');
      }
    });
    const r = await collect(page);
    await context.close();
    const isKey = (i) => i.name === 'keydown' || i.name === 'keyup';
    return {
      inp: Math.max(16, ...durations(r)),
      openMedian: median(r.interactions.filter((i) => !isKey(i)).map((i) => i.duration)) ?? 16,
      closeMedian: median(r.interactions.filter(isKey).map((i) => i.duration)) ?? 16,
      longTasksTotal: r.longTasks.total,
      blocking: r.longTasks.blocking,
    };
  },

  async scroll(browser, traceFile) {
    const { context, page } = await openApp(browser);
    await scrollToGrid(page);
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await markStart(page);
    const t0 = Date.now();
    await withTrace(page, traceFile, async () => {
      for (let i = 0; i < 20; i++) {
        await page.mouse.wheel({ deltaY: 300 });
        await sleep(100);
      }
      await settle(page, 500);
    });
    const wall = Date.now() - t0;
    const r = await collect(page);
    await context.close();
    return {
      longTasksTotal: r.longTasks.total,
      longTasksCount: r.longTasks.count,
      longTaskMax: r.longTasks.max,
      blocking: r.longTasks.blocking,
      wallTime: wall,
    };
  },
};

async function runLighthouse(chromePath) {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: HEADLESS,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    const page = await browser.newPage();
    const result = await lighthouse(
      URL,
      { output: 'html', logLevel: 'error', onlyCategories: ['performance'], throttlingMethod: 'devtools' },
      desktopConfig,
      page
    );
    const a = result.lhr.audits;
    return {
      metrics: {
        score: Math.round(result.lhr.categories.performance.score * 100),
        fcp: a['first-contentful-paint'].numericValue,
        lcp: a['largest-contentful-paint'].numericValue,
        tbt: a['total-blocking-time'].numericValue,
        cls: a['cumulative-layout-shift'].numericValue,
        si: a['speed-index'].numericValue,
        bytes: a['total-byte-weight'].numericValue,
      },
      html: result.report,
    };
  } finally {
    await browser.close();
  }
}

function fmt(k, v) {
  if (typeof v !== 'number') return `${k} ${v}`;
  if (k === 'cls') return `${k} ${v.toFixed(3)}`;
  if (k === 'bytes') return `${k} ${(v / 1024).toFixed(0)} KiB`;
  return `${k} ${Math.round(v)}`;
}

function summarize(runs) {
  const keys = Object.keys(runs[0]).filter((k) => typeof runs[0][k] === 'number');
  return Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
}

async function main() {
  const chromePath = findChrome();
  const res = await fetch(URL).catch(() => null);
  if (!res || !res.ok) {
    console.error(`Застосунок не відповідає на ${URL}. Запустіть: npm run build && npm run preview`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: HEADLESS,
    args: ['--no-first-run', '--no-default-browser-check', `--window-size=${VIEWPORT.width},${VIEWPORT.height + 100}`],
  });

  const conditions = {
    date: new Date().toISOString(),
    machine: `${os.cpus()[0].model.trim()}, ${os.cpus().length} потоків, ${(os.totalmem() / 2 ** 30).toFixed(1)} ГБ RAM, ${os.platform()} ${os.release()}`,
    browser: await browser.version(),
    headless: HEADLESS,
    profile: 'чистий тимчасовий профіль без розширень, окремий incognito-контекст на кожен запуск',
    load: `CPU ${CPU_SLOWDOWN}x, мережа Fast 4G (165 ms, 8.1 Mbps), кеш вимкнено, вікно ${VIEWPORT.width}x${VIEWPORT.height}`,
    interactions: `CPU ${CPU_SLOWDOWN}x, без network throttling, вікно ${VIEWPORT.width}x${VIEWPORT.height}`,
    lighthouse: 'Lighthouse Navigation, Desktop, applied (DevTools) throttling: мережа без обмежень, CPU 1x',
    runs: RUNS,
  };
  console.log(`\n[${label}] ${conditions.browser}, ${RUNS} запусків\n`);

  const results = { label, conditions, scenarios: {} };
  try {
    if (ONLY.includes('lighthouse')) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        runs.push(await runLighthouse(chromePath));
        console.log(`  lighthouse #${i + 1}: ${Object.entries(runs.at(-1).metrics).map(([k, v]) => fmt(k, v)).join(', ')}`);
      }
      const med = summarize(runs.map((r) => r.metrics));
      const closest = runs.reduce((best, r) =>
        Math.abs(r.metrics.lcp - med.lcp) < Math.abs(best.metrics.lcp - med.lcp) ? r : best
      );
      await mkdir(join(OUT, 'lighthouse'), { recursive: true });
      await writeFile(join(OUT, 'lighthouse', `${label}.html`), closest.html);
      results.scenarios.lighthouse = { median: med, runs: runs.map((r) => r.metrics) };
    }

    for (const name of ALL.slice(1)) {
      if (!ONLY.includes(name)) continue;
      if (TRACE) {
        await scenarios[name](browser, join(OUT, 'traces', `${label}-${name}.json`));
      }
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        runs.push(await scenarios[name](browser, null));
        console.log(`  ${name} #${i + 1}: ${Object.entries(runs.at(-1)).map(([k, v]) => fmt(k, v)).join(', ')}`);
      }
      results.scenarios[name] = { median: summarize(runs), runs };
    }
  } finally {
    await browser.close();
  }

  await mkdir(join(OUT, 'data'), { recursive: true });
  await writeFile(join(OUT, 'data', `${label}.json`), JSON.stringify(results, null, 2));

  console.log(`\nМедіани [${label}]:`);
  for (const [name, s] of Object.entries(results.scenarios)) {
    console.log(`  ${name.padEnd(10)} ${Object.entries(s.median).map(([k, v]) => fmt(k, v)).join(' | ')}`);
  }
  console.log(`\nЗбережено: report/data/${label}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
