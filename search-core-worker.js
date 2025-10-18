import { parentPort } from 'node:worker_threads';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const FETCH_TIMEOUT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_TIMEOUT_MS || 10000);
const PLAYWRIGHT_TIMEOUT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT_TIMEOUT_MS || 15000);
const PLAYWRIGHT_NETWORK_IDLE_WAIT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT_NETWORK_IDLE_MS || 2000);
const PLAYWRIGHT_ENABLED = process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT === 'false' ? false : true;

let chromiumModule = null;
let playwrightBrowser = null;
let playwrightStatus = 'unknown';

async function ensurePlaywrightBrowser() {
  if (!PLAYWRIGHT_ENABLED) {
    return null;
  }

  if (playwrightStatus === 'unavailable') {
    return null;
  }

  if (!chromiumModule) {
    try {
      ({ chromium: chromiumModule } = await import('playwright'));
      playwrightStatus = 'available';
    } catch (error) {
      console.warn('[SearchCoreWorker] Playwright import failed. Falling back to fetch:', error.message);
      playwrightStatus = 'unavailable';
      return null;
    }
  }

  if (!playwrightBrowser) {
    try {
      playwrightBrowser = await chromiumModule.launch({
        headless: true,
        args: [
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ]
      });
      playwrightBrowser.on('disconnected', () => {
        playwrightBrowser = null;
      });
    } catch (error) {
      console.warn('[SearchCoreWorker] Playwright launch failed. Falling back to fetch:', error.message);
      playwrightStatus = 'unavailable';
      playwrightBrowser = null;
      return null;
    }
  }

  return playwrightBrowser;
}

async function fetchWithPlaywright(targetUrl) {
  const browser = await ensurePlaywrightBrowser();
  if (!browser) {
    return null;
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-US',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  let response;

  try {
    response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: PLAYWRIGHT_TIMEOUT_MS
    });

    try {
      await page.waitForLoadState('networkidle', { timeout: PLAYWRIGHT_NETWORK_IDLE_WAIT_MS });
    } catch (_) {
      // networkidle timing out is acceptable for pages with continuous polling
    }

    const html = await page.content();

    return {
      status: response?.status() ?? 200,
      statusText: response?.statusText() ?? 'OK',
      contentType: response?.headers()['content-type'] || 'text/html; charset=utf-8',
      body: Buffer.from(html)
    };
  } catch (error) {
    console.warn('[SearchCoreWorker] Playwright fetch error. Falling back to fetch:', error.message);
    return null;
  } finally {
    await context.close();
  }
}

async function fetchWithNode(targetUrl) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available in this Node runtime.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'ShopScoutSearchCore/1.0 (+https://github.com/)',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    return {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') || 'text/html; charset=utf-8',
      body: Buffer.from(await response.arrayBuffer())
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardRequest(targetUrl, renderMode) {
  const preferBrowser = renderMode === 'browser' || (renderMode !== 'fetch' && PLAYWRIGHT_ENABLED);

  if (preferBrowser) {
    const browserResult = await fetchWithPlaywright(targetUrl);
    if (browserResult) {
      return browserResult;
    }
  }

  return fetchWithNode(targetUrl);
}

async function closePlaywrightBrowser() {
  if (playwrightBrowser) {
    const browser = playwrightBrowser;
    playwrightBrowser = null;
    try {
      await browser.close();
    } catch (error) {
      console.warn('[SearchCoreWorker] Error closing Playwright browser:', error.message);
    }
  }
}

function toTransferableBuffer(buffer) {
  if (!buffer) {
    return { transferable: null, arrayBuffer: null };
  }

  if (buffer instanceof ArrayBuffer) {
    return { transferable: buffer, arrayBuffer: buffer };
  }

  const uint8 = buffer instanceof Uint8Array ? buffer : Buffer.from(buffer);
  const ab = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
  return { transferable: ab, arrayBuffer: ab };
}

parentPort.on('message', async (message) => {
  if (!message) {
    return;
  }

  if (message.command === 'shutdown') {
    await closePlaywrightBrowser();
    parentPort.postMessage({ command: 'ready' });
    return;
  }

  const { id, payload } = message;
  if (typeof id !== 'number' || !payload || payload.type !== 'forwardRequest') {
    parentPort.postMessage({ id, success: false, error: 'Invalid worker payload' });
    return;
  }

  try {
    const targetUrl = payload.targetUrl;
    const urlObj = new URL(targetUrl);
    if (!ALLOWED_PROTOCOLS.has(urlObj.protocol)) {
      throw new Error('Unsupported protocol');
    }

    const result = await forwardRequest(targetUrl, payload.renderMode);
    const { transferable, arrayBuffer } = toTransferableBuffer(result.body);

    const responsePayload = {
      id,
      success: true,
      result: {
        status: result.status,
        statusText: result.statusText,
        contentType: result.contentType,
        body: arrayBuffer
      }
    };

    if (transferable) {
      parentPort.postMessage(responsePayload, [transferable]);
    } else {
      parentPort.postMessage(responsePayload);
    }
  } catch (error) {
    const messageText = error?.message || String(error);
    parentPort.postMessage({ id, success: false, error: messageText });
  }
});

parentPort.postMessage({ command: 'ready' });

process.on('exit', () => {
  closePlaywrightBrowser().catch(() => {});
});
