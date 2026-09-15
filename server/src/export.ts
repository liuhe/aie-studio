import puppeteer, { type Browser } from 'puppeteer-core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// Render an HTML fragment to PDF or PNG via a headless Chrome controlled by
// puppeteer-core. We deliberately don't ship Chromium — the host's Chrome /
// Chromium binary is used. Set CHROME_EXECUTABLE to override discovery.

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_CHROMES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function resolveChromePath(): string {
  const override = process.env.CHROME_EXECUTABLE;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`CHROME_EXECUTABLE=${override} does not exist`);
    }
    return override;
  }
  if (process.platform === 'darwin' && fs.existsSync(MAC_CHROME)) return MAC_CHROME;
  for (const p of LINUX_CHROMES) if (fs.existsSync(p)) return p;
  throw new Error(
    'Chrome / Chromium not found. Install Chrome or set CHROME_EXECUTABLE to the binary path.',
  );
}

// Fresh browser per request. Earlier we cached a singleton, but on long /
// large-content captures the cached instance accumulated state that triggered
// renderer crashes on subsequent jobs. Cold launch is ~500ms — acceptable
// overhead for the reliability win.
async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: resolveChromePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // /dev/shm on the host can be small or absent on macOS; force tmpfile
      // backing instead so the compositor doesn't run out of memory on tall
      // pages. Standard advice for headless Chrome long-jobs.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--disable-background-timer-throttling',
    ],
  });
}

// Cache the bundled CSS in memory so each export doesn't re-read from disk.
// Invalidate on mtime change so a rebuild during `pnpm dev` is picked up.
let cachedCss: { mtimeMs: number; text: string } | null = null;

function readBundleCss(webDist: string): string {
  const assetsDir = path.join(webDist, 'assets');
  if (!fs.existsSync(assetsDir)) return '';
  const candidates = fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => {
      const full = path.join(assetsDir, f);
      return { full, size: fs.statSync(full).size };
    })
    .sort((a, b) => b.size - a.size);
  if (candidates.length === 0) return '';
  const top = candidates[0].full;
  const stat = fs.statSync(top);
  if (cachedCss && cachedCss.mtimeMs === stat.mtimeMs) return cachedCss.text;
  const text = fs.readFileSync(top, 'utf8');
  cachedCss = { mtimeMs: stat.mtimeMs, text };
  return text;
}

export type RenderOpts = {
  html: string;
  theme: 'dark' | 'light' | 'dim';
  fontScale?: string;
  format: 'pdf' | 'png';
  webDist: string;
};

function buildPage(opts: RenderOpts): string {
  const css = readBundleCss(opts.webDist);
  const fontScale = opts.fontScale ?? 'normal';
  // Force explicit CJK-capable font stacks. The app's CSS uses `-apple-system`
  // which resolves to SF Pro and falls back through CoreText on a normal Mac;
  // headless Chrome's PDF backend doesn't always pick those fallbacks up, so
  // CJK content renders as boxes. Adding explicit PingFang / Hiragino / etc.
  // entries to the body cascade makes the fallback explicit and stable.
  return `<!doctype html>
<html data-theme="${opts.theme}" data-font-scale="${fontScale}">
<head>
<meta charset="utf-8">
<style>${css}</style>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "Segoe UI", Roboto, sans-serif;
  }
  body, body * { -webkit-font-smoothing: antialiased; }
  pre, code, .tool-field-value {
    font-family: ui-monospace, SFMono-Regular, "Menlo", "DejaVu Sans Mono", "PingFang SC", "Hiragino Sans GB", monospace;
  }
  body > div[data-export-root] { margin: 0 auto; }
</style>
</head>
<body>
${opts.html}
</body>
</html>`;
}

// Per-slice viewport height. We scroll the page in steps of this size and snap
// the visible viewport each time, so the renderer never has to keep a
// multi-thousand-pixel bitmap in memory at once. Keep small enough that even
// pages well past 30K px capture reliably.
const PNG_SLICE_HEIGHT = 2000;

export async function renderExport(opts: RenderOpts): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 });
    await page.setContent(buildPage(opts), { waitUntil: 'load' });
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    });
    if (opts.format === 'png') {
      return await capturePng(page);
    }
    const buf = await page.pdf({
      printBackground: true,
      format: 'A4',
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });
    return Buffer.from(buf);
  } finally {
    // close the whole browser, not just the page — fresh per request.
    try {
      await browser.close();
    } catch {
      // already dead from a renderer crash; nothing to do.
    }
  }
}

async function capturePng(page: import('puppeteer-core').Page): Promise<Buffer> {
  const dims = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  const { width, height } = dims;
  if (height <= PNG_SLICE_HEIGHT) {
    // Short-path: bump dsf for crispness here too so output matches the tall
    // path's resolution.
    await page.setViewport({
      width: Math.max(width, 900),
      height: Math.max(height, 1000),
      deviceScaleFactor: 2,
    });
    const buf = await page.screenshot({ type: 'png', fullPage: true });
    return Buffer.from(buf);
  }
  // For very long pages Chrome's screenshot path can crash the renderer when
  // asked to capture a tall clip in one shot. Switch to "scrolling viewport":
  // resize the viewport to one slice tall, scroll, snap the visible area, move
  // on. Each snapshot is a single viewport buffer — the renderer never has to
  // hold a multi-thousand-px bitmap.
  const viewportW = Math.max(width, 900);
  // dsf=2 for crisp text; the output canvas is described in CSS px so sharp
  // does the right thing as long as we feed it `width × height` (CSS px) and
  // tag the input buffers with `density: 2` via .extract metadata implicitly
  // by stitching at the doubled raster size.
  const DSF = 2;
  await page.setViewport({ width: viewportW, height: PNG_SLICE_HEIGHT, deviceScaleFactor: DSF });
  type Slice = { input: Buffer; top: number; left: number };
  const slices: Slice[] = [];
  const seen = new Set<number>();
  for (let y = 0; y < height; y += PNG_SLICE_HEIGHT) {
    await page.evaluate((sy) => window.scrollTo(0, sy), y);
    // Give the compositor a frame to settle after the scroll before snapping.
    await new Promise((r) => setTimeout(r, 60));
    // Browser clamps scrollTo to `documentHeight - viewportHeight`. Read the
    // ACTUAL scroll position so the last (clamped) slice lands at the right
    // y instead of overflowing the bottom of the canvas.
    const actualY = await page.evaluate(() => Math.round(window.scrollY));
    if (seen.has(actualY)) break;
    seen.add(actualY);
    const buf = await page.screenshot({ type: 'png', captureBeyondViewport: false });
    slices.push({ input: Buffer.from(buf), top: actualY * DSF, left: 0 });
  }
  // Canvas in raster pixels = CSS px × DSF on both axes.
  return sharp({
    create: {
      width: width * DSF,
      height: height * DSF,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(slices)
    .png()
    .toBuffer();
}
