/**
 * ShopScout Content Script
 *
 * Runs on Amazon and eBay product pages to scrape product data
 * and send it to the background service worker for analysis.
 */

// Detect which site we're on
const SITE = window.location.hostname.includes('amazon.com') ? 'amazon' : 'ebay';
console.log('[Content Script] Loaded on site:', SITE, 'URL:', window.location.href);

// Track if we've already scraped to avoid duplicates
let hasScraped = false;
let highlightedElement = null;

/**
 * Main scraping function - delegates to site-specific scrapers
 */
function scrapeProductData() {
  console.log('[Content Script] scrapeProductData called, hasScraped:', hasScraped);

  if (hasScraped) {
    console.log('[Content Script] Already scraped, skipping');
    return;
  }

  let productData;
  if (SITE === 'amazon') {
    productData = scrapeAmazonProduct();
  } else {
    productData = scrapeEbayProduct();
  }

  console.log('[Content Script] Product data extracted:', !!productData);

  if (productData) {
    hasScraped = true;
    // Send to background worker
    chrome.runtime.sendMessage({
      type: 'PRODUCT_DATA_SCRAPED',
      data: productData
    });
    console.log('[Content Script] Product data sent to background');
  } else {
    console.warn('[Content Script] No product data to send');
  }
}

/**
 * Amazon Product Scraper
 */
function scrapeAmazonProduct() {
  try {
    // Use the comprehensive extractor (loaded from amazon-extractor.js)
    if (typeof window.extractAmazonProduct !== 'function') {
      return null;
    }

    return window.extractAmazonProduct();
  } catch (error) {
    console.error('Error scraping Amazon product:', error);
    return null;
  }
}

/**
 * eBay Product Scraper
 */
function scrapeEbayProduct() {
  try {
    // Use the comprehensive extractor (loaded from ebay-extractor.js)
    console.log('[Content Script] Checking for window.extractEbayProduct...');
    console.log('[Content Script] window.extractEbayProduct exists?', typeof window.extractEbayProduct);
    console.log('[Content Script] window object keys:', Object.keys(window).filter(k => k.includes('extract')));

    if (typeof window.extractEbayProduct !== 'function') {
      console.error('[Content Script] window.extractEbayProduct not available');
      return null;
    }

    return window.extractEbayProduct();
  } catch (error) {
    console.error('Error scraping eBay product:', error);
    return null;
  }
}

/**
 * Highlight element on page (for Q&A source citations)
 */
function highlightElement(selector) {
  // Remove previous highlight
  if (highlightedElement) {
    highlightedElement.style.outline = '';
    highlightedElement.style.backgroundColor = '';
  }

  // Add new highlight
  const element = document.querySelector(selector);
  if (element) {
    element.style.outline = '3px solid #3b82f6';
    element.style.backgroundColor = '#dbeafe';
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    highlightedElement = element;

    // Remove highlight after 5 seconds
    setTimeout(() => {
      element.style.outline = '';
      element.style.backgroundColor = '';
      highlightedElement = null;
    }, 5000);
  }
}

/**
 * Listen for messages from background worker
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Content Script] Received message:', message.type);

  if (message.type === 'RE_SCRAPE') {
    console.log('[Content Script] RE_SCRAPE received, resetting hasScraped');
    hasScraped = false;
    scrapeProductData();
    sendResponse({ success: true });
  } else if (message.type === 'HIGHLIGHT_ELEMENT') {
    highlightElement(message.selector);
    sendResponse({ success: true });
  }
  return true;
});

// Run scraper when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scrapeProductData);
} else {
  scrapeProductData();
}

// Also listen for dynamic content changes (SPAs)
let debounceTimer;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (!hasScraped) {
      scrapeProductData();
    }
  }, 1000);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
