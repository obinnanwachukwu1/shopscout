/**
 * Amazon Product Extractor
 *
 * Browser-compatible version of scrape/amazon/extract.js
 * Extracts comprehensive product data from Amazon product pages
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

const getVisibleText = (node) => {
  if (!node) return null;
  const clone = node.cloneNode(true);

  clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());

  const raw = clone.textContent;
  if (!raw) return null;

  const withoutBoilerplate = raw
    .replace(/\bRead (more|less)( of this review)?\b/gi, ' ')
    .replace(/\bTop positive review\b/gi, ' ') // occasionally repeated header
    .replace(/\bTop critical review\b/gi, ' ');

  return clean(withoutBoilerplate) || clean(raw);
};

const textFromSelectors = (selectors) => {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node) {
      const text = clean(node.textContent);
      if (text) return text;
    }
  }
  return null;
};

const collectText = (selectors) => {
  const values = [];
  const seen = new Set();

  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      const value = clean(el.textContent);
      if (value && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    });
  });

  return values;
};

const parsePriceText = (text) => {
  const raw = clean(text);
  if (!raw) return null;

  const currencyMatch = raw.match(/^[^\d-]+/);
  const amountMatch = raw.match(/-?[\d.,]+/);
  const currency = currencyMatch ? clean(currencyMatch[0]) : null;
  const amountString = amountMatch ? amountMatch[0].replace(/,/g, '') : null;
  const amount = amountString ? parseFloat(amountString.replace(/\.([^.]*)\./g, '.$1')) : null;
  const normalizedRaw = currency && amountString ? `${currency}${amountString}` : amountString || raw;

  return { raw: normalizedRaw, currency, amount: Number.isFinite(amount) ? amount : null };
};

const extractPrices = () => {
  const buildPriceFromElement = (priceEl) => {
    if (!priceEl) return null;

    const symbolEl = priceEl.querySelector('.a-price-symbol');
    const wholeEl = priceEl.querySelector('.a-price-whole');

    const symbol = symbolEl ? clean(symbolEl.textContent) : null;
    const wholeRaw = wholeEl ? wholeEl.textContent : null;

    if (!wholeRaw) return null;

    const wholeDigits = wholeRaw.replace(/[^\d]/g, '');
    if (!wholeDigits) return null;

    const fractionEl = priceEl.querySelector('.a-price-fraction');
    const fractionRaw = fractionEl ? fractionEl.textContent : '';
    const fractionDigits = fractionRaw.replace(/[^\d]/g, '');
    const normalizedFraction = fractionDigits.padEnd(fractionDigits.length ? 2 : 0, '0');

    const numeric = parseFloat(
      fractionDigits.length ? `${wholeDigits}.${normalizedFraction.slice(0, 2)}` : wholeDigits
    );

    const raw = `${symbol || ''}${wholeDigits}${fractionDigits.length ? `.${normalizedFraction.slice(0, 2)}` : ''}`;

    return {
      raw: raw.trim(),
      currency: symbol,
      amount: Number.isFinite(numeric) ? numeric : null,
    };
  };

  const currentSelectors = [
    '#corePriceDisplay_desktop_feature_div .a-section.a-spacing-none .aok-offscreen',
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_mobile_feature_div .a-section.a-spacing-none .aok-offscreen',
    '#corePriceDisplay_mobile_feature_div .priceToPay .a-offscreen',
    '#apex_desktop span.a-price span.a-offscreen',
    '#apex_desktop span.a-offscreen',
    '.reinventPricePriceToPayMargin span.a-price span.a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    '#sns-base-price',
  ];

  const listSelectors = [
    '#corePriceDisplay_desktop_feature_div .a-text-price span.a-offscreen',
    '#corePriceDisplay_mobile_feature_div .a-text-price span.a-offscreen',
    '#price .a-text-price span.a-offscreen',
    '.a-price.a-text-price span.a-offscreen',
    '#listPrice',
  ];

  const savingsSelectors = [
    '#regularprice_savings span.a-color-price',
    '#corePriceDisplay_desktop_feature_div .savingsRow span.a-color-price',
    '#corePriceDisplay_mobile_feature_div .savingsRow span.a-color-price',
    '#corePriceDisplay_desktop_feature_div .savingsPercentage',
    '#corePriceDisplay_mobile_feature_div .savingsPercentage',
  ];

  let current = parsePriceText(textFromSelectors(currentSelectors));
  if (!current) {
    const priceToPay = document.querySelector('#corePriceDisplay_desktop_feature_div .priceToPay') ||
                       document.querySelector('#corePriceDisplay_mobile_feature_div .priceToPay');
    current = buildPriceFromElement(priceToPay);
  }

  let list = parsePriceText(textFromSelectors(listSelectors));
  if (!list) {
    const basisPrice = document.querySelector('#corePriceDisplay_desktop_feature_div .basisPrice .a-price');
    list = buildPriceFromElement(basisPrice);
  }

  const savingsText = textFromSelectors(savingsSelectors);
  const additional = collectText([...currentSelectors, ...listSelectors, ...savingsSelectors]);

  let savings = null;
  if (savingsText) {
    const percentageMatch = savingsText.match(/([\d.]+)%/);
    const amountMatch = savingsText.match(/-?[\d.,]+/);
    const hasCurrencySymbol = /[$€£¥₹]/.test(savingsText);

    savings = {
      raw: savingsText,
      amount: hasCurrencySymbol && amountMatch ? parseFloat(amountMatch[0].replace(/,/g, '')) : null,
      percentage: percentageMatch ? parseFloat(percentageMatch[1]) : null,
    };
  }

  return { current, list, savings, additional };
};

const extractBreadcrumbs = () => {
  const items = [];
  document.querySelectorAll('#wayfinding-breadcrumbs_feature_div li').forEach((li) => {
    const link = li.querySelector('a');
    const name = clean(link ? link.textContent : null);
    if (!name) return;

    items.push({
      name,
      url: link ? link.getAttribute('href') : null,
    });
  });
  return items;
};

const extractBullets = () => {
  const bullets = [];
  document.querySelectorAll('#feature-bullets ul li').forEach((li) => {
    const span = li.querySelector('span');
    const text = clean(span ? span.textContent : null);
    if (text) bullets.push(text);
  });
  return bullets;
};

const extractTableSection = (selector) => {
  const table = {};
  const tableEl = document.querySelector(selector);

  if (tableEl) {
    tableEl.querySelectorAll('tr').forEach((row) => {
      const cells = row.querySelectorAll('th, td');
      const header = clean(cells[0] ? cells[0].textContent : null);
      const valueCell = cells.length > 1 ? cells[1] : cells[cells.length - 1];
      const value = clean(valueCell ? valueCell.textContent : null);

      if (header && value) {
        table[header] = value;
      }
    });
  }

  return table;
};

const extractTechSpecs = () => {
  const specs = {};
  Object.assign(specs, extractTableSection('#productDetails_techSpec_section_1'));
  Object.assign(specs, extractTableSection('#productDetails_techSpec_section_2'));
  return specs;
};

const extractProductOverview = () => {
  const overview = {};
  document.querySelectorAll('#productOverview_feature_div tr').forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 2) {
      const key = clean(cells[0].textContent);
      const value = clean(cells[1].textContent);
      if (key && value) overview[key] = value;
    }
  });
  return overview;
};

const extractRatings = () => {
  const ratingText = clean(document.querySelector('#acrPopover .a-icon-alt')?.textContent);
  const ratingValue = ratingText ? parseFloat((ratingText.match(/[\d.]+/) || [])[0]) : null;
  const reviewCountText = clean(document.querySelector('#acrCustomerReviewText')?.textContent);
  const reviewCountMatch = reviewCountText ? reviewCountText.match(/[\d,]+/) : null;

  return {
    text: ratingText,
    value: Number.isFinite(ratingValue) ? ratingValue : null,
    countText: reviewCountText,
    count: reviewCountMatch ? parseInt(reviewCountMatch[0].replace(/,/g, ''), 10) : null,
  };
};

const extractAvailability = () => {
  const availNode = document.querySelector('#availability') || document.querySelector('#outOfStock');
  const text = clean(availNode ? availNode.textContent : null);
  const isInStock = text ? /in stock/i.test(text) : null;
  return { text, inStock: isInStock };
};

const extractBadges = () => {
  const badges = [];
  const seen = new Set();

  const selectors = [
    '#badge_feature_div .badge-link',
    '#badge_feature_div .badge-text',
    '[data-a-badge-type]',
    '.zg-bf-badge-wrapper .mvt-best-seller-badge',
    '#acBadge_feature_div .ac-badge-text-primary',
  ];

  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      const text = clean(el.textContent);
      if (text && !seen.has(text)) {
        seen.add(text);
        badges.push(text);
      }
    });
  });

  return badges;
};

const extractMainImage = () => {
  // Try to get the main landing image
  const landingImage = document.querySelector('#landingImage');
  if (landingImage) {
    // Get the high-res version from data-old-hires attribute
    const highRes = landingImage.getAttribute('data-old-hires');
    if (highRes) return highRes;

    // Fall back to current src
    const src = landingImage.getAttribute('src');
    if (src) return src;
  }

  // Try alternate selectors
  const alternateSelectors = [
    '#imgBlkFront',
    '#main-image',
    '#img-canvas img',
    '.imgTagWrapper img',
  ];

  for (const selector of alternateSelectors) {
    const img = document.querySelector(selector);
    if (img) {
      const src = img.getAttribute('src') || img.getAttribute('data-old-hires');
      if (src && !src.includes('pixel') && !src.includes('transparent')) {
        return src;
      }
    }
  }

  return null;
};

const extractReviewHelpfulCount = (text) => {
  const cleaned = clean(text);
  if (!cleaned) return null;
  if (/One person/i.test(cleaned)) {
    return 1;
  }
  const match = cleaned.match(/([\d,]+)/);
  if (!match) return null;
  const value = parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(value) ? value : null;
};

const extractReviews = () => {
  const reviews = [];
  const reviewNodes = document.querySelectorAll('#cm-cr-dp-review-list li[data-hook="review"]');

  reviewNodes.forEach((node) => {
    const id = node.getAttribute('id') || null;
    const card = node.querySelector('[id^="customer_review-"]') || node;

    const titleNode = node.querySelector('[data-hook="review-title"] span');
    const bodyNode = node.querySelector('[data-hook="review-body"]');
    const ratingNode = node.querySelector('[data-hook="review-star-rating"] span');
    const dateNode = node.querySelector('[data-hook="review-date"]');
    const formatNode = node.querySelector('[data-hook="format-strip-linkless"]');
    const badges = Array.from(node.querySelectorAll('[data-hook="avp-badge-linkless"], .cr-badge-text'))
      .map(el => clean(el.textContent))
      .filter(Boolean);
    const helpfulNode = node.querySelector('[data-hook="helpful-vote-statement"], [data-hook="review-voting-count"]');

    const authorNode = node.querySelector('.a-profile-name');

    const review = {
      id,
      selector: id ? `#${id}` : (card?.id ? `#${card.id}` : null),
      title: getVisibleText(titleNode),
      body: getVisibleText(bodyNode),
      rating: ratingNode ? parseFloat((clean(ratingNode.textContent)?.match(/[\d.]+/) || [])[0]) || null : null,
      date: getVisibleText(dateNode),
      format: getVisibleText(formatNode),
      helpfulCount: extractReviewHelpfulCount(helpfulNode?.textContent || ''),
      badges,
      author: getVisibleText(authorNode)
    };

    // Skip totally empty reviews
    if (review.title || review.body) {
      reviews.push(review);
    }
  });

  return reviews.slice(0, 8);
};

// Export as global for content script
window.extractAmazonProduct = () => {
  try {
    // Extract ASIN from URL
    const asinMatch = window.location.pathname.match(/\/dp\/([A-Z0-9]{10})/);
    const asin = asinMatch ? asinMatch[1] : null;

    if (!asin) {
      return null;
    }

    const title = clean(document.querySelector('#productTitle')?.textContent);
    const subtitle = clean(document.querySelector('#titleSection .a-size-medium')?.textContent);
    const brand = clean(document.querySelector('#bylineInfo')?.textContent);
    const price = extractPrices();
    const breadcrumbs = extractBreadcrumbs();
    const categories = breadcrumbs.map((crumb) => crumb.name);
    const bullets = extractBullets();
    const techSpecs = extractTechSpecs();
    const productOverview = extractProductOverview();
    const ratings = extractRatings();
    const availability = extractAvailability();
    const badges = extractBadges();
    const description = clean(document.querySelector('#productDescription')?.textContent);
    const mainImage = extractMainImage();

    return {
      site: 'amazon',
      productId: asin,
      asin,
      url: window.location.href,
      title,
      subtitle,
      brand,
      price: price.current ? {
        value: price.current.amount,
        currency: price.current.currency || '$',
        formatted: price.current.raw,
        isRange: false
      } : { value: null, currency: '$', formatted: 'N/A', isRange: false },
      listPrice: price.list,
      savings: price.savings,
      rating: ratings.value,
      reviewCount: ratings.count,
      categories,
      specs: techSpecs,
      bullets,
      description,
      reviews: extractReviews(),
      availability,
      variations: { hasVariations: false, types: [] }, // TODO: Extract from twister data
      badges,
      productOverview,
      mainImage,
      scrapedAt: Date.now()
    };
  } catch (error) {
    console.error('Error extracting Amazon product:', error);
    return null;
  }
};

})(); // End IIFE
