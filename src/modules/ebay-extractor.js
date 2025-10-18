/**
 * eBay Product Extractor
 *
 * Browser-compatible version of scrape/ebay/extract.js
 * Extracts comprehensive product data from eBay product pages
 */

(function() {
  'use strict';

const clean = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u00a0\u200e\u200f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length ? normalized : null;
};

const parseNumber = (value) => {
  if (!value) return null;
  const digits = value.toString().match(/[\d.,]+/);
  if (!digits) return null;
  const parsed = parseFloat(digits[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const parsePrice = (text) => {
  const raw = clean(text);
  if (!raw) return null;
  const currencyMatch = raw.match(/^[^\d-]+/);
  const amountMatch = raw.match(/-?[\d.,]+/);
  let currency = currencyMatch ? clean(currencyMatch[0]) : null;

  // Normalize common USD formats
  if (currency) {
    const normalized = currency.replace(/\s+/g, '').toUpperCase();
    if (normalized === 'US$' || normalized === '$') {
      currency = 'USD';
    }
  }

  const amount = amountMatch ? parseFloat(amountMatch[0].replace(/,/g, '')) : null;
  return {
    raw,
    currency,
    amount: Number.isFinite(amount) ? amount : null,
  };
};

const compactObject = (obj) => {
  const output = { ...obj };
  Object.entries(output).forEach(([key, value]) => {
    if (
      value == null ||
      (typeof value === 'string' && value.length === 0) ||
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    ) {
      delete output[key];
    }
  });
  return output;
};

const extractLabelValueMap = () => {
  const normalizeValue = (value) =>
    clean(
      value
        .replace(/Read\s+moreabout[\s\S]*?(?=Read\s+Less|$)/gi, '')
        .replace(/Read\s+lessabout[\s\S]*$/gi, '')
        .replace(/Read\s+more/gi, '')
        .replace(/Read\s+less/gi, '')
        .replace(/See\s+detailsfor/gi, 'See details for')
        .replace(/See\s+details\s*-\s*/gi, 'See details - ')
    );

  const map = new Map();
  document.querySelectorAll('.ux-labels-values').forEach((block) => {
    const label = clean(block.querySelector('.ux-labels-values__labels')?.textContent);
    const value = normalizeValue(block.querySelector('.ux-labels-values__values')?.textContent || '');
    if (!label || !value) return;
    const normalizedLabel = label.replace(/:$/, '');
    map.set(normalizedLabel, value);
  });
  return map;
};

const extractSeller = () => {
  const card = document.querySelector('[data-testid="x-sellercard-atf"]');
  if (!card) return {};

  const name = clean(card.querySelector('a span.ux-textspans--BOLD')?.textContent);

  const feedbackElements = card.querySelectorAll('[data-testid="x-sellercard-atf__about-seller"] span.ux-textspans');
  let feedbackCount = null;
  feedbackElements.forEach((el) => {
    if (/\(\d/.test(el.textContent)) {
      feedbackCount = parseNumber(el.textContent);
    }
  });

  const ratingText = clean(card.querySelector('[data-testid="x-sellercard-atf__data-item"] span.ux-textspans')?.textContent);
  const ratingPercent = ratingText ? parseNumber(ratingText) : null;
  const storeUrl = card.querySelector('a')?.getAttribute('href') || null;

  return compactObject({
    name,
    feedbackCount,
    positivePercent: ratingPercent,
    ratingText,
    storeUrl,
  });
};

const cleanCondition = (text) => {
  if (!text) return null;
  return clean(
    text
      .replace(/Read moreabout.*$/i, '')
      .replace(/See all condition definitions.*$/i, '')
  );
};

const extractEngagement = () => {
  const watchers = parseNumber(document.querySelector('.x-watch-heart-btn-text')?.textContent);
  const carts = parseNumber(document.querySelector('[data-testid="x-ebay-signal"]')?.textContent);
  return compactObject({
    watchers,
    inCarts: carts,
  });
};

const extractListingInfo = (price) => {
  const ctaText = clean(document.querySelector('[data-testid="x-buybox-cta"]')?.textContent);
  const hasBuyItNow = !!(ctaText && /buy it now/i.test(ctaText));
  const hasAuction = document.querySelector('[data-testid="x-bid-price"]') || /place bid/i.test(ctaText || '');
  const hasBestOffer = !!document.querySelector('[data-testid="x-offer-action"]');

  let auction = null;
  if (hasAuction) {
    const bidPriceText = document.querySelector('[data-testid="x-bid-price"] .ux-textspans')?.textContent;
    const bidCountText = document.querySelector('[data-testid="x-bid-count"]')?.textContent;
    let timeLeft = clean(document.querySelector('[data-testid="ux-timer_timer"]')?.textContent);
    if (timeLeft) {
      timeLeft = timeLeft.replace(/^Ends in\s*/i, '');
    }
    auction = compactObject({
      currentBid: parsePrice(bidPriceText) || price?.current || null,
      bidCount: parseNumber(bidCountText),
      timeLeft,
    });
  }

  const listing = compactObject({
    buyItNow: hasBuyItNow || undefined,
    bestOffer: hasBestOffer || undefined,
    auction,
  });

  return Object.keys(listing).length ? listing : null;
};

const buildItemSpecifics = (labelMap) => {
  const specifics = {};
  const excluded = new Set([
    'List price',
    'Item price',
    'Estimated total',
    'Shipping',
    'Shipping:',
    'Delivery',
    'Delivery:',
    'Returns',
    'Returns:',
    'Payments',
    'Payments:',
    'Condition',
  ]);
  labelMap.forEach((value, key) => {
    if (excluded.has(key)) return;
    specifics[key] = value;
  });
  return specifics;
};

const buildShipping = (labelMap) =>
  compactObject({
    summary: clean(
      (labelMap.get('Shipping') || labelMap.get('Shipping:') || '').replace(/detailsfor/gi, 'details for')
    ),
    delivery: clean(labelMap.get('Delivery') || labelMap.get('Delivery:')),
    returns: clean(labelMap.get('Returns') || labelMap.get('Returns:')),
  });

const buildPrice = (labelMap) => {
  const primary = parsePrice(document.querySelector('.x-price-primary span.ux-textspans')?.textContent);
  const itemPrice = parsePrice(labelMap.get('Item price'));
  const listPrice = parsePrice(labelMap.get('List price'));
  const estimatedTotal = parsePrice(labelMap.get('Estimated total'));

  return compactObject({
    current: primary || itemPrice || null,
    list: listPrice || null,
    estimatedTotal: estimatedTotal || null,
  });
};

const extractMainImage = () => {
  // Try main product image
  const mainImage = document.querySelector('.ux-image-carousel-item.active img, .ux-image-carousel-item.image img');
  if (mainImage) {
    const src = mainImage.getAttribute('src');
    if (src && !src.includes('s-l64') && !src.includes('placeholder')) {
      return src.replace(/s-l\d+/g, 's-l1600'); // Get high-res version
    }
  }

  // Fallback to any product image
  const anyImage = document.querySelector('.ux-image-carousel img');
  if (anyImage) {
    const src = anyImage.getAttribute('src');
    if (src) {
      return src.replace(/s-l\d+/g, 's-l1600');
    }
  }

  return null;
};

const extractCategories = () => {
  const categories = [];
  document.querySelectorAll('.breadcrumbs li a, nav[aria-label="Breadcrumb"] a').forEach((link) => {
    const text = clean(link.textContent);
    if (text && text !== 'Back to previous page') {
      categories.push(text);
    }
  });
  return categories;
};

// Export as global for content script
console.log('[eBay Extractor] Script loaded');

window.extractEbayProduct = () => {
  console.log('[eBay Extractor] extractEbayProduct called');
  try {
    // Extract item ID from URL
    const itemIdMatch = window.location.pathname.match(/\/itm\/(\d+)/);
    const itemId = itemIdMatch ? itemIdMatch[1] : null;

    if (!itemId) {
      return null;
    }

    const title = clean(document.querySelector('h1')?.textContent);
    const subtitle = clean(document.querySelector('#subtitle')?.textContent) || null;

    const labelMap = extractLabelValueMap();
    const price = buildPrice(labelMap);
    const condition = cleanCondition(labelMap.get('Condition'));
    const shipping = buildShipping(labelMap);
    const specifics = buildItemSpecifics(labelMap);
    const seller = extractSeller();
    const engagement = extractEngagement();
    const listing = extractListingInfo(price);
    const mainImage = extractMainImage();
    const categories = extractCategories();

    const description = clean(
      document.querySelector('[data-testid="ux-section__item--description"]')?.textContent
        ?.replace(/Show more$/i, '')
    );

    // Format for ShopScout compatibility
    return {
      site: 'ebay',
      productId: itemId,
      itemId,
      url: window.location.href,
      title,
      subtitle,
      price: price.current ? {
        value: price.current.amount,
        currency: price.current.currency || 'USD',
        formatted: price.current.raw,
        isRange: false
      } : { value: null, currency: 'USD', formatted: 'N/A', isRange: false },
      listPrice: price.list,
      condition,
      shipping,
      seller,
      engagement,
      listing,
      specs: specifics,
      itemSpecifics: specifics,
      categories,
      description,
      mainImage,
      scrapedAt: Date.now()
    };
  } catch (error) {
    console.error('Error extracting eBay product:', error);
    return null;
  }
};

})(); // End IIFE
