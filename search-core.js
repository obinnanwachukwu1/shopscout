import http from 'http';
import { URL } from 'url';

const DEFAULT_PORT = 9000;
const PORT = Number(process.env.SHOPSCOUT_SEARCH_CORE_PORT || DEFAULT_PORT);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const FETCH_TIMEOUT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_TIMEOUT_MS || 10000);
const PLAYWRIGHT_TIMEOUT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT_TIMEOUT_MS || 15000);
const PLAYWRIGHT_NETWORK_IDLE_WAIT_MS = Number(process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT_NETWORK_IDLE_MS || 2000);
const PLAYWRIGHT_ENABLED = process.env.SHOPSCOUT_SEARCH_CORE_PLAYWRIGHT === 'false' ? false : true;

const defaultResponseHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

let chromiumModule = null;
let playwrightBrowser = null;
let playwrightStatus = 'unknown';

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...defaultResponseHeaders,
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(payload));
}

function applyDefaultHeaders(res) {
  Object.entries(defaultResponseHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

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
      console.warn('[SearchCore] Playwright import failed. Falling back to fetch:', error.message);
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
      console.warn('[SearchCore] Playwright launch failed. Falling back to fetch:', error.message);
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
    console.warn('[SearchCore] Playwright fetch error. Falling back to fetch:', error.message);
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

const server = http.createServer(async (req, res) => {
  applyDefaultHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host}`);
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid request URL.' });
    return;
  }

  if (requestUrl.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (requestUrl.pathname !== '/fetch') {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed. Use GET.' });
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { error: 'Missing url query parameter.' });
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(target);
  } catch (error) {
    sendJson(res, 400, { error: 'Invalid target URL.' });
    return;
  }

  if (!ALLOWED_PROTOCOLS.has(upstreamUrl.protocol)) {
    sendJson(res, 400, { error: 'Only http and https protocols are supported.' });
    return;
  }

  const renderMode = requestUrl.searchParams.get('render');

  try {
    const upstream = await forwardRequest(upstreamUrl.toString(), renderMode);

    res.writeHead(
      upstream.status,
      {
        ...defaultResponseHeaders,
        'Content-Type': upstream.contentType,
        'Cache-Control': 'no-store'
      }
    );
    res.end(upstream.body);
  } catch (error) {
    if (error.name === 'AbortError') {
      sendJson(res, 504, { error: `Upstream request timed out after ${FETCH_TIMEOUT_MS}ms.` });
      return;
    }
    sendJson(res, 502, { error: `Upstream request failed: ${error.message}` });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ShopScout Search Core] listening on http://127.0.0.1:${PORT}`);
});

server.on('error', error => {
  console.error('[ShopScout Search Core] Server error:', error);
  process.exitCode = 1;
});

async function closePlaywrightBrowser() {
  if (playwrightBrowser) {
    const browser = playwrightBrowser;
    playwrightBrowser = null;
    try {
      await browser.close();
    } catch (error) {
      console.warn('[SearchCore] Error closing Playwright browser:', error.message);
    }
  }
}

const shutdown = (signal) => {
  closePlaywrightBrowser()
    .catch(() => {})
    .finally(() => {
      if (signal) {
        process.exit(0);
      }
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  if (playwrightBrowser) {
    playwrightBrowser.close().catch(() => {});
  }
});
