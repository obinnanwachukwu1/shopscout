/**
 * ShopScout Web Fetch Proxy Server
 *
 * A local proxy server that uses Playwright to fetch web pages and bypass CORS restrictions.
 * Runs in headful mode (minimized) for better rendering and debugging.
 *
 * Usage:
 *   node proxy-server.js
 *
 * Endpoints:
 *   GET /fetch?url=<encoded-url>&render=browser
 */

import express from 'express';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 9000;
const TIMEOUT = 15000; // 15 second timeout per request

let browser = null;
let context = null;

const app = express();

// Initialize Playwright browser (headless, undetectable)
async function initBrowser() {
  if (browser) {
    return;
  }

  console.log('[Proxy] Launching undetectable headless browser...');

  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials'
    ],
    // Disable automation indicators
    devtools: false
  });

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
    // Add extra headers to appear more real
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    }
  });

  // Add script to mask automation
  await context.addInitScript(() => {
    // Overwrite the `navigator.webdriver` property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });

    // Overwrite the `plugins` property to add fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    // Overwrite the `languages` property
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // Add chrome object
    window.chrome = {
      runtime: {}
    };

    // Permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  });

  // Block images and media to speed up loading (optional)
  await context.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  console.log('[Proxy] Browser ready (headless, undetectable)');
}

// Fetch endpoint
app.get('/fetch', async (req, res) => {
  const targetUrl = req.query.url;
  const renderMode = req.query.render || 'browser';

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL encoding' });
  }

  console.log(`[Proxy] Fetching: ${decodedUrl}`);

  try {
    await initBrowser();

    const page = await context.newPage();

    try {
      // Navigate to the page with timeout
      await page.goto(decodedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT
      });

      // Wait a bit for dynamic content to load
      if (renderMode === 'browser') {
        await page.waitForTimeout(2000);
      }

      // Get the HTML content
      const html = await page.content();

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(html);

      console.log(`[Proxy] ✓ Success: ${decodedUrl} (${html.length} bytes)`);
    } catch (error) {
      console.error(`[Proxy] ✗ Error fetching ${decodedUrl}:`, error.message);

      // Return 502 Bad Gateway for fetch errors
      res.status(502).json({
        error: 'Failed to fetch URL',
        message: error.message,
        url: decodedUrl
      });
    } finally {
      await page.close();
    }
  } catch (error) {
    console.error('[Proxy] ✗ Browser error:', error.message);
    res.status(500).json({
      error: 'Browser initialization failed',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browser: browser ? 'running' : 'not initialized',
    mode: 'headless'
  });
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Proxy] Shutting down...');
  if (context) {
    await context.close();
  }
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[Proxy] Shutting down...');
  if (context) {
    await context.close();
  }
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`[Proxy] Server running on http://127.0.0.1:${PORT}`);
  console.log(`[Proxy] Mode: headless (undetectable)`);
  console.log(`[Proxy] Example: http://127.0.0.1:${PORT}/fetch?render=browser&url=https%3A%2F%2Fexample.com`);
});
