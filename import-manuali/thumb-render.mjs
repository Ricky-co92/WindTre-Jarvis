// Shared PDF-thumbnail renderer, used by both import-to-supabase.mjs and
// regenerate-thumbs.mjs. Renders the first page (650px wide, JPEG) via headless
// Chrome's own built-in PDF viewer (Puppeteer), not pdfjs-dist/@napi-rs/canvas.
//
// That combo was tried first and rejected: pdfjs-dist's fallback glyph-path
// renderer for non-embedded standard fonts (very common in these PDFs) produces
// garbled/wrong text at any @napi-rs/canvas version tested, upgrading canvas
// introduced a separate crash on PDFs with gradients, and node-canvas (the classic
// Cairo binding) has no prebuilt binary for this Node version and needs a full
// native toolchain to compile. Chromium's PDF renderer (PDFium) has none of these
// issues and is what every browser already uses to preview these exact files.
// A Chromium-side crash surfaces as a catchable Puppeteer error, not a host
// process crash, so no child-process isolation is needed here either.

import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const THUMB_WIDTH = 650;

let browserInstance = null;
async function getBrowser() {
  // protocolTimeout lower than Puppeteer's 180s default: a wedged render should
  // fail fast rather than stall the whole batch for 3 minutes per item.
  if (!browserInstance) browserInstance = await puppeteer.launch({ headless: true, protocolTimeout: 30000 });
  return browserInstance;
}
export async function closeBrowser() {
  if (browserInstance) { await browserInstance.close(); browserInstance = null; }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function generateThumb(buf) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wtthumb-'));
  const pdfPath = path.join(dir, 'in.pdf');
  try {
    writeFileSync(pdfPath, buf);
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const { width, height } = doc.getPage(0).getSize();
    const viewportHeight = Math.max(50, Math.ceil(THUMB_WIDTH * (height / width)));

    const browser = await getBrowser();
    const page = await withTimeout(browser.newPage(), 10000, 'newPage');
    try {
      await withTimeout(page.setViewport({ width: THUMB_WIDTH, height: viewportHeight }), 5000, 'setViewport');
      const url = 'file:///' + pdfPath.replace(/\\/g, '/') + '#toolbar=0&navpanes=0&statusbar=0&view=FitH';
      await withTimeout(page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 }), 22000, 'goto');
      await new Promise((r) => setTimeout(r, 300));
      return await withTimeout(page.screenshot({ type: 'jpeg', quality: 88 }), 15000, 'screenshot');
    } finally {
      // Bounded wait, not fire-and-forget: not awaiting close() at all let open
      // pages pile up faster than Chrome could handle, causing newPage()/screenshot()
      // to time out en masse on later items (observed against the real archive) —
      // worse than the original problem. A short timeout still prevents a single
      // wedged page (rare) from stalling the whole batch, while normal closes
      // (the vast majority) complete well within it.
      await withTimeout(page.close(), 5000, 'close').catch(() => {});
    }
  } catch (err) {
    console.warn('  Miniatura non generata:', err.message);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
