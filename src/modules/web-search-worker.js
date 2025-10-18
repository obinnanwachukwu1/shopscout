import { parentPort } from 'node:worker_threads';

const DEFAULT_MAX_CHARS = 8000;

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(html) {
  if (!html) return '';
  let stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');

  stripped = stripped.replace(/<[^>]+>/g, ' ');
  return stripped;
}

async function fetchPageHtml({ url, maxChars = DEFAULT_MAX_CHARS, proxyUrl }) {
  const sources = [];

  if (proxyUrl) {
    sources.push({
      type: 'proxy',
      url: `${proxyUrl}${encodeURIComponent(url)}`,
      headers: {
        Accept: 'text/html,application/xhtml+xml'
      }
    });
  }

  sources.push({
    type: 'direct',
    url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  for (const source of sources) {
    try {
      const response = await fetch(source.url, {
        headers: source.headers
      });

      if (!response.ok) {
        continue;
      }

      const html = await response.text();
      if (!html) {
        continue;
      }

      return html.length > maxChars ? html.slice(0, maxChars) : html;
    } catch (_) {
      // ignore and fall back to next source
    }
  }

  return null;
}

async function fetchPageSnippet({ url, maxChars = DEFAULT_MAX_CHARS, proxyUrl }) {
  const html = await fetchPageHtml({ url, maxChars, proxyUrl });
  if (!html) {
    return null;
  }

  const plainText = cleanText(stripHtml(html));
  if (!plainText) {
    return null;
  }

  return plainText.slice(0, 12000);
}

parentPort.on('message', async (message) => {
  if (!message) {
    return;
  }

  if (message.command === 'shutdown') {
    parentPort.postMessage({ command: 'ready' });
    return;
  }

  const { id, payload } = message;
  if (typeof id !== 'number' || !payload) {
    parentPort.postMessage({ id, success: false, error: 'Invalid worker payload' });
    return;
  }

  try {
    let result = null;
    switch (payload.type) {
      case 'fetchPageHtml':
        result = await fetchPageHtml(payload);
        break;
      case 'fetchPageSnippet':
        result = await fetchPageSnippet(payload);
        break;
      default:
        throw new Error(`Unknown task type: ${payload.type}`);
    }

    parentPort.postMessage({ id, success: true, result });
  } catch (error) {
    parentPort.postMessage({ id, success: false, error: error?.message || String(error) });
  }
});

parentPort.postMessage({ command: 'ready' });
