/**
 * ShopScout Sidepanel UI Controller
 *
 * Handles rendering and user interactions in the sidepanel
 */

let currentAnalysis = null;

// DOM elements
const contentDiv = document.getElementById('content');
const refreshBtn = document.getElementById('refreshBtn');
const openChatBtn = document.getElementById('openChatBtn');

const REFRESH_ICON_HTML = '<span aria-hidden="true">⟳</span>';
const REFRESH_LOADING_HTML = '<span aria-hidden="true">…</span>';
const CONNECTION_ERROR_SNIPPET = 'Could not establish connection';
const SHOPSCOUT_ICON_SRC_48 = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
  ? chrome.runtime.getURL('icons/icon48.png')
  : 'icons/icon48.png';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeRuntimeSendMessage(message, { retries = 2, delayMs = 200 } = {}) {
  let attempt = 0;

  while (attempt <= retries) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      const messageText = (error && error.message) || '';
      const isConnectionError = messageText.includes(CONNECTION_ERROR_SNIPPET);
      if (!isConnectionError || attempt === retries) {
        throw error;
      }

      console.warn(
        `[Sidepanel] Runtime message retry ${attempt + 1} for ${message?.type || 'unknown type'}`
      );
      await sleep(delayMs * (attempt + 1));
      attempt += 1;
    }
  }

  return null;
}

function setContent(html, { preserveScroll = true } = {}) {
  const scrollY = preserveScroll ? window.scrollY : 0;
  contentDiv.innerHTML = html;

  requestAnimationFrame(() => {
    if (preserveScroll) {
      window.scrollTo(0, scrollY);
    } else {
      window.scrollTo(0, 0);
    }
  });
}

// Ensure refresh button starts with the expected icon markup
if (refreshBtn) {
  refreshBtn.innerHTML = REFRESH_ICON_HTML;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadCurrentAnalysis();
  setupEventListeners();
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
  refreshBtn.addEventListener('click', handleRefresh);
  openChatBtn.addEventListener('click', handleOpenChat);

  // Listen for updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ANALYSIS_UPDATED') {
      currentAnalysis = message.data;
      render();
    } else if (message.type === 'QUESTION_ANSWERED') {
      displayAnswer(message.data);
    } else if (message.type === 'ANALYSIS_RESET') {
      console.log('[Sidepanel] Analysis reset:', message.data);
      currentAnalysis = null;
      showLoading();
    }
  });

  // Poll for tab changes every 2 seconds
  let lastTabUrl = null;
  let hasInitializedTabWatcher = false;
  setInterval(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url !== lastTabUrl) {
        if (!hasInitializedTabWatcher) {
          // First observation establishes baseline without forcing a refresh
          hasInitializedTabWatcher = true;
          lastTabUrl = tab.url;

          const isProductPage = (tab.url.includes('amazon.com/') && tab.url.includes('/dp/')) ||
                               tab.url.includes('ebay.com/itm/');

          if (!isProductPage) {
            showEmptyState();
          }
          return;
        }

        console.log('[Sidepanel] Tab URL changed:', lastTabUrl, '->', tab.url);
        lastTabUrl = tab.url;

        // Check if it's a product page
        const isProductPage = (tab.url.includes('amazon.com/') && tab.url.includes('/dp/')) ||
                             tab.url.includes('ebay.com/itm/');

        if (isProductPage) {
          // Clear current analysis to force reload
          currentAnalysis = null;
          showLoading();

          // Request the background to clear its cache for this product
          await safeRuntimeSendMessage({ type: 'CLEAR_CACHE' });

          // Wait a moment then trigger scraping
          setTimeout(() => {
            triggerScrapeOnCurrentTab();
          }, 500);
        } else {
          showEmptyState();
        }
      }
    } catch (error) {
      console.error('[Sidepanel] Error checking tab:', error);
    }
  }, 2000); // Check every 2 seconds

  // Also listen for window focus (when user comes back to the window)
  window.addEventListener('focus', () => {
    console.log('[Sidepanel] Window focused, checking current tab');
    setTimeout(() => {
      loadCurrentAnalysis();
    }, 500);
  });
}

/**
 * Load current analysis from background
 */
async function loadCurrentAnalysis() {
  showLoading();

  try {
    const response = await safeRuntimeSendMessage({
      type: 'GET_CURRENT_ANALYSIS'
    });

    if (response.success && response.data) {
      currentAnalysis = response.data;
      render();
    } else {
      // No analysis yet - trigger scraping on current tab
      console.log('[Sidepanel] No analysis found, triggering scrape on current tab');
      await triggerScrapeOnCurrentTab();
    }
  } catch (error) {
    console.error('Error loading analysis:', error);
    showError('Failed to load analysis. Please refresh the page.');
  }
}

/**
 * Trigger scraping on the current tab
 */
async function triggerScrapeOnCurrentTab() {
  try {
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      console.log('[Sidepanel] No active tab found');
      showEmptyState();
      return;
    }

    console.log('[Sidepanel] Current tab URL:', tab.url);

    // Check if it's an Amazon or eBay product page
    const isAmazon = tab.url.includes('amazon.com/') && tab.url.includes('/dp/');
    const isEbay = tab.url.includes('ebay.com/itm/');

    if (!isAmazon && !isEbay) {
      console.log('[Sidepanel] Not a product page');
      showEmptyState();
      return;
    }

    console.log('[Sidepanel] Attempting to communicate with content script');

    // Try to send message to content script
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'RE_SCRAPE' });
      console.log('[Sidepanel] RE_SCRAPE response:', response);

      // Keep showing loading state - will update when analysis completes
      showLoading();

      // Poll for analysis completion
      pollForAnalysis();
    } catch (err) {
      console.log('[Sidepanel] Content script not loaded yet, injecting scripts...');

      // Content script not loaded - inject it manually
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/modules/amazon-extractor.js']
        });

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/modules/ebay-extractor.js']
        });

        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-script.js']
        });

        console.log('[Sidepanel] Scripts injected, waiting for scraping...');

        // Wait a moment for scripts to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Try sending the message again
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'RE_SCRAPE' });
          pollForAnalysis();
        } catch (retryErr) {
          console.log('[Sidepanel] Script will auto-scrape, polling for results...');
          // Even if the message fails, the content script should auto-scrape on load
          pollForAnalysis();
        }
      } catch (injectErr) {
        console.error('[Sidepanel] Error injecting scripts:', injectErr);
        showError('Unable to analyze this page. Please refresh and try again.');
      }
    }
  } catch (error) {
    console.error('[Sidepanel] Error triggering scrape:', error);
    showEmptyState();
  }
}

/**
 * Poll for analysis completion
 */
function pollForAnalysis() {
  let attempts = 0;
  const maxAttempts = 30; // Poll for up to 30 seconds (increased from 10)

  const pollInterval = setInterval(async () => {
    attempts++;

    let response;
    try {
      response = await safeRuntimeSendMessage({ type: 'GET_CURRENT_ANALYSIS' });
    } catch (error) {
      console.warn('[Sidepanel] Poll attempt failed:', error);
      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        console.log('[Sidepanel] No analysis after', maxAttempts, 'attempts');
        showEmptyState();
      }
      return;
    }

    if (response.success && response.data) {
      clearInterval(pollInterval);
      currentAnalysis = response.data;
      render();
      console.log('[Sidepanel] Analysis received after', attempts, 'attempts');
    } else if (attempts >= maxAttempts) {
      clearInterval(pollInterval);
      console.log('[Sidepanel] No analysis after', maxAttempts, 'attempts');
      showEmptyState();
    }
  }, 1000); // Check every second
}

/**
 * Handle refresh button click
 */
async function handleRefresh() {
  refreshBtn.disabled = true;
  refreshBtn.innerHTML = REFRESH_LOADING_HTML;

  try {
    await safeRuntimeSendMessage({ type: 'REFRESH_ANALYSIS' });
    showLoading();
  } catch (error) {
    console.error('Error refreshing:', error);
    showError('Failed to refresh analysis.');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.innerHTML = REFRESH_ICON_HTML;
  }
}

/**
 * Handle open chat button click
 */
async function handleOpenChat() {
  try {
    // Open side panel directly (must be called in response to user gesture)
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: currentWindow.id });

    // Close the popup
    self.close();
  } catch (error) {
    console.error('Error opening chat:', error);
  }
}

/**
 * Main render function
 */
function render() {
  if (!currentAnalysis) {
    showEmptyState();
    return;
  }

  if (currentAnalysis.status === 'stopped') {
    renderStopMessage(currentAnalysis);
    return;
  }

  if (currentAnalysis.status === 'completed') {
    renderAnalysis(currentAnalysis);
  }
}

/**
 * Render loading state
 */
function showLoading() {
  setContent(`
    <div class="loading">
      <div class="spinner"></div>
      <p>Analyzing product...</p>
    </div>
  `, { preserveScroll: false });
}

/**
 * Render error message
 */
function showError(message) {
  setContent(`
    <div class="error">
      <strong>Error:</strong> ${message}
    </div>
  `, { preserveScroll: false });
}

/**
 * Render empty state
 */
function showEmptyState() {
  setContent(`
    <div class="empty-state">
      <div class="empty-icon">
        <img src="${SHOPSCOUT_ICON_SRC_48}" alt="">
      </div>
      <div class="empty-title">No Product Detected</div>
      <div class="empty-message">
        Navigate to an Amazon or eBay product page to see analysis.
      </div>
    </div>
  `, { preserveScroll: false });
}

/**
 * Render stop message (out of stock, variations, etc.)
 */
function renderStopMessage(analysis) {
  setContent(`
    <div class="stop-message">
      <strong>${analysis.reason}</strong>
      <p>${analysis.message}</p>
    </div>
    ${renderProductInfo(analysis.productData)}
  `, { preserveScroll: false });
}

/**
 * Render complete analysis
 */
function renderAnalysis(analysis) {
  const html = [];

  // Product info
  html.push(renderProductInfo(analysis.productData));

  // Check if DealSense blocked the listing (hide everything except warning)
  const dealSenseBlocked = analysis.dealSense?.blocked;

  if (dealSenseBlocked) {
    // Only show the DealSense critical warning - hide all other analysis
    html.push(renderDealSense(analysis.dealSense, analysis.productData, analysis.buyScore, analysis.recommendation));
    setContent(html.join(''));
    return; // Stop rendering - don't show any other analysis
  }

  // Mode-specific rendering (only if not blocked by DealSense)
  // DealSense is the brand name - show for both Amazon and eBay
  switch (analysis.mode) {
    case 'ELECTRONICS':
      html.push(renderDealSense(analysis.dealSense, analysis.productData, analysis.buyScore, analysis.recommendation));
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderSentimentAnalysis(analysis.sentimentAnalysis));
      html.push(renderReviewHighlights(analysis.productData));
      break;

    case 'FASHION':
      html.push(renderDealSense(analysis.dealSense, analysis.productData, analysis.buyScore, analysis.recommendation));
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderFitAnalysis(analysis.fitAnalysis));
      html.push(renderReviewHighlights(analysis.productData));
      break;

    case 'BEAUTY':
      html.push(renderDealSense(analysis.dealSense, analysis.productData, analysis.buyScore, analysis.recommendation));
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderBeautyAnalysis(analysis.beautyAnalysis));
      html.push(renderReviewHighlights(analysis.productData));
      break;

    case 'COLLECTIBLES':
      html.push(renderDealSense(analysis.dealSense, analysis.productData, analysis.buyScore, analysis.recommendation));
      html.push(renderSoldComps(analysis.soldComps));
      html.push(renderSentimentAnalysis(analysis.sentimentAnalysis));
      html.push(renderReviewHighlights(analysis.productData));
      break;

    case 'GENERIC_HOME_GOODS':
    default:
      html.push(renderDealSense(analysis.dealSense, analysis.productData, analysis.buyScore, analysis.recommendation));
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderSentimentAnalysis(analysis.sentimentAnalysis));
      html.push(renderReviewHighlights(analysis.productData));
      break;
  }

  setContent(html.join(''));
  attachQAEventListeners();
  attachReviewHighlightHandlers();
  attachDealSenseEventListeners();
  attachComparablesEventListeners();
  attachBuyScoreInfoHandlers();
}

/**
 * Render product info card
 */
function renderProductInfo(product) {
  if (!product) return '';

  const imageHtml = product.mainImage
    ? `<div style="display: flex; justify-content: center;">
         <img src="${product.mainImage}" alt="${product.title}" style="width: 100%; max-width: 220px; max-height: 180px; object-fit: contain; border-radius: var(--radius-md); margin-bottom: 12px;">
       </div>`
    : '';

  const priceHtml = product.price?.formatted
    ? `<div style="margin-top: 8px; font-weight: 600; font-size: 16px;">${product.price.formatted}</div>`
    : '';

  // Auction info for eBay listings
  let auctionHtml = '';
  if (product.listing?.auction) {
    const auction = product.listing.auction;
    auctionHtml = `
      <div class="alert alert-warning" style="margin-top: 12px;">
        <h4>⚡ Auction</h4>
        <div style="font-size: 12px; line-height: 1.8;">
          ${auction.currentBid ? `<div><strong>Current Bid:</strong> ${auction.currentBid.raw}</div>` : ''}
          ${auction.bidCount ? `<div><strong>Bids:</strong> ${auction.bidCount}</div>` : ''}
          ${auction.timeLeft ? `<div><strong>Time Left:</strong> ${auction.timeLeft}</div>` : ''}
        </div>
      </div>
    `;
  }

  // Listing type badges
  let listingBadges = '';
  if (product.listing) {
    const badges = [];
    if (product.listing.buyItNow) badges.push('<span class="badge badge-success">Buy It Now</span>');
    if (product.listing.bestOffer) badges.push('<span class="badge badge-info">Best Offer</span>');
    if (badges.length > 0) {
      listingBadges = `<div style="margin-top: 8px;">${badges.join(' ')}</div>`;
    }
  }

  return `
    <div class="card">
      <div class="card-title">Product Info</div>
      ${imageHtml}
      <div style="font-size: 13px; line-height: 1.6;">
        <strong>${product.title}</strong>
        ${priceHtml}
        ${listingBadges}
      </div>
      ${auctionHtml}
    </div>
  `;
}

const BUY_SCORE_FACTOR_DETAILS = {
  price: {
    label: 'Price Fairness',
    description: 'Compares the current price to recent market listings to gauge if you are paying below, at, or above market value.'
  },
  sentiment: {
    label: 'Review Sentiment',
    description: 'Looks at average customer ratings and feedback volume to judge how satisfied buyers are with this item.'
  },
  seller: {
    label: 'Seller Reliability',
    description: 'Evaluates seller ratings and feedback to estimate trustworthiness and fulfillment risk.'
  },
  spec: {
    label: 'Spec Confidence',
    description: 'Checks specification matches, conflicts, and missing details to ensure the item aligns with expectations.'
  }
};

function buildBuyScoreInfoWidgets(buyScore) {
  if (!buyScore || typeof buyScore !== 'object') {
    return { buttonHtml: '', panelHtml: '' };
  }

  const breakdown = buyScore.breakdown || {};
  const weights = buyScore.weights || {};
  const keys = Object.keys(breakdown);

  if (!keys.length) {
    return { buttonHtml: '', panelHtml: '' };
  }

  const infoId = `buyScoreInfo_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const scoreTotal = typeof buyScore.total === 'number' ? buyScore.total : null;

  const rowsHtml = keys
    .map((key) => {
      const value = typeof breakdown[key] === 'number' ? breakdown[key] : null;
      if (value == null) return '';
      const weight = typeof weights[key] === 'number' ? weights[key] : null;
      const factor = BUY_SCORE_FACTOR_DETAILS[key] || {
        label: key.charAt(0).toUpperCase() + key.slice(1),
        description: ''
      };
      const weightLabel = weight != null ? `${Math.round(weight * 100)}% weight` : 'Not weighted';
      const scoreOutOfTen = (value * 10).toFixed(1);
      const scorePercent = Math.max(0, Math.min(100, Math.round(value * 100)));
      return `
        <div class="buy-score-info-item">
          <div class="buy-score-info-row">
            <span>${factor.label}</span>
            <span>${scoreOutOfTen}/10 • ${weightLabel}</span>
          </div>
          <div class="buy-score-info-bar">
            <div class="buy-score-info-bar-fill" style="width:${scorePercent}%;"></div>
          </div>
          <div class="buy-score-info-description">${factor.description}</div>
        </div>
      `;
    })
    .filter(Boolean)
    .join('');

  const fallbackNote = buyScore.isFallback
    ? '<div class="buy-score-info-note">Fallback scoring is enabled because we could not find enough exact matches. We lean more on price trends and sentiment.</div>'
    : '';

  const panelHtml = `
    <div id="${infoId}" class="buy-score-info-modal" role="dialog" aria-modal="true" aria-hidden="true" data-visible="false">
      <div class="buy-score-info-card" role="document" tabindex="-1">
        <div class="buy-score-info-header">
          <span>How this score was calculated${scoreTotal != null ? ` (${scoreTotal.toFixed(1)}/10)` : ''}</span>
          <button type="button" class="buy-score-info-close" data-close-modal aria-label="Close Buy Score breakdown">&times;</button>
        </div>
        <div class="buy-score-info-body">
          ${fallbackNote}
          ${rowsHtml || '<div class="buy-score-info-description">No detailed breakdown available.</div>'}
        </div>
      </div>
    </div>
  `;

  const buttonHtml = `
    <button class="buy-score-info-btn" type="button" aria-label="Show Buy Score breakdown" aria-expanded="false" data-target="${infoId}">
      <span aria-hidden="true">ⓘ</span>
    </button>
  `;

  return { buttonHtml, panelHtml };
}

/**
 * Render Buy Score card
 */
function renderBuyScore(buyScore, recommendation) {
  if (!buyScore || !recommendation) return '';

  const score = buyScore.total || 0;
  const percentage = (score / 10) * 100; // Convert 0-10 score to 0-100%

  // Calculate rotation for the needle (0% = -90deg, 100% = 90deg)
  const rotation = -90 + (percentage * 1.8);
  const infoWidgets = buildBuyScoreInfoWidgets(buyScore);

  return `
    <div class="buy-score-card">
      <div class="speedometer" style="display: flex; flex-direction: column; align-items: center;">
        <svg viewBox="0 0 200 120" style="width: 100%; max-width: 300px; display: block; margin: 0 auto;">
          <!-- Gradient definition -->
          <defs>
            <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#ef4444;stop-opacity:1" />
              <stop offset="50%" style="stop-color:#f59e0b;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#22c55e;stop-opacity:1" />
            </linearGradient>
          </defs>

          <!-- Gray background arc -->
          <path d="M 30 100 A 70 70 0 0 1 170 100"
                fill="none"
                stroke="var(--border)"
                stroke-width="20"
                stroke-linecap="round"/>

          <!-- Colored arc with gradient -->
          <path d="M 30 100 A 70 70 0 0 1 170 100"
                fill="none"
                stroke="url(#scoreGradient)"
                stroke-width="20"
                stroke-linecap="round"
                stroke-dasharray="${percentage * 2.2}, 220"
                style="transition: stroke-dasharray 0.5s ease;"/>

          <!-- Needle -->
          <g transform="translate(100, 100)">
            <line x1="0" y1="0" x2="0" y2="-60"
                  stroke="#374151"
                  stroke-width="3"
                  stroke-linecap="round"
                  transform="rotate(${rotation})"
                  style="transition: transform 0.5s ease;"/>
            <circle cx="0" cy="0" r="6" fill="#374151"/>
          </g>
        </svg>

        <!-- Score value display -->
        <div style="text-align: center; margin-top: 0px;">
          <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
            <div style="font-size: 36px; font-weight: 700; color: ${recommendation.color};">
              ${score.toFixed(1)}
            </div>
            ${infoWidgets.buttonHtml}
          </div>
          <div style="font-size: 16px; font-weight: 600; color: ${recommendation.color}; margin-top: 4px;">
            ${recommendation.verdict}
          </div>
          <div style="font-size: 13px; color: var(--text-secondary); margin-top: 8px; line-height: 1.4;">
            ${recommendation.message}
          </div>
        </div>
      </div>
      ${infoWidgets.panelHtml}
    </div>
  `;
}

/**
 * Render price comparison with number line visualization
 */
function renderPriceComparison(priceData) {
  if (!priceData) return '';

  // Format price values
  const formatPrice = (price) => {
    if (price == null) return 'N/A';
    return `$${price.toFixed(2)}`;
  };

  const current = priceData.currentPrice;
  const median = priceData.median;
  const min = priceData.min;
  const max = priceData.max;

  const parsePriceValue = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (!value) return null;
    if (typeof value === 'string') {
      const numeric = parseFloat(value.replace(/[^0-9.]/g, ''));
      return Number.isFinite(numeric) ? numeric : null;
    }
    if (typeof value === 'object') {
      return parsePriceValue(value.amount ?? value.value ?? value.raw ?? value.formatted ?? value.price);
    }
    return null;
  };

  const rawComparables = Array.isArray(priceData.comparables) ? priceData.comparables.filter(Boolean) : [];
  const normalizedComparables = rawComparables.map((comp, index) => {
    const priceValue = parsePriceValue(comp.price ?? comp.priceValue ?? comp.amount ?? comp.avgPrice);
    const priceLabel = typeof priceValue === 'number'
      ? `$${priceValue.toFixed(2)}`
      : (comp.priceFormatted || comp.formattedPrice || comp.price || 'N/A');
    const listingFormat = comp.listingFormat || comp.format || comp.listingType || null;
    const normalizedFormat =
      typeof listingFormat === 'string' && listingFormat.length ? listingFormat.toLowerCase() : null;
    const bidCount =
      typeof comp.bidCount === 'number'
        ? comp.bidCount
        : typeof comp.bids === 'number'
          ? comp.bids
          : null;
    const timeLeft = comp.timeLeft || comp.endsIn || comp.expiresIn || null;

    return {
      title: comp.title || comp.name || comp.label || `Listing ${index + 1}`,
      priceLabel,
      priceValue: typeof priceValue === 'number' ? priceValue : null,
      condition: comp.condition || comp.subtitle || comp.note || '',
      source: comp.source || comp.marketplace || comp.site || '',
      url: comp.url || comp.link || '',
      description: comp.description || '',
      type: 'listing',
      listingFormat: normalizedFormat || (comp.isAuction ? 'auction' : null),
      bidCount: typeof bidCount === 'number' ? bidCount : null,
      timeLeft: typeof timeLeft === 'string' ? timeLeft : null,
      isAuction: normalizedFormat === 'auction' || comp.isAuction === true
    };
  }).filter(item => item.title || item.priceLabel);

  let comparablesForUi = normalizedComparables;

  if (!comparablesForUi.length) {
    const derived = [];
    if (min != null) {
      derived.push({
        title: 'Lowest Recent Price',
        priceLabel: formatPrice(min),
        priceValue: min,
        condition: 'Best observed price',
        source: 'Market data',
        description: 'Lowest price seen across recent listings.',
        type: 'stat'
      });
    }
    if (median != null) {
      derived.push({
        title: 'Median Market Price',
        priceLabel: formatPrice(median),
        priceValue: median,
        condition: 'Typical going rate',
        source: 'Market data',
        description: 'Median price calculated from available comparables.',
        type: 'stat'
      });
    }
    if (max != null && max !== min) {
      derived.push({
        title: 'Highest Recent Price',
        priceLabel: formatPrice(max),
        priceValue: max,
        condition: 'Highest observed price',
        source: 'Market data',
        description: 'Upper bound seen across recent listings.',
        type: 'stat'
      });
    }

    comparablesForUi = derived;
  }

  const comparablesCountDisplay = comparablesForUi.length || priceData.compCount || 0;
  const comparablesDataAttr = JSON.stringify(comparablesForUi).replace(/'/g, '&apos;');
  const formatBreakdown = priceData.formatBreakdown || null;
  const buyNowCount = formatBreakdown?.buyItNow ?? 0;
  const auctionCount = formatBreakdown?.auction ?? 0;
  const unknownCount = formatBreakdown?.unknown ?? 0;
  const usedAuctionPrices = Boolean(priceData.usedAuctionPrices);

  let comparablesMixNote = '';
  const summaryParts = [];
  if (buyNowCount) {
    summaryParts.push(`${buyNowCount} Buy It Now`);
  }
  if (auctionCount) {
    summaryParts.push(`${auctionCount} auction${auctionCount === 1 ? '' : 's'}`);
  }
  if (!summaryParts.length && unknownCount && comparablesCountDisplay) {
    summaryParts.push(`${comparablesCountDisplay} listings`);
  }

  if (summaryParts.length) {
    const auctionDetail = auctionCount
      ? usedAuctionPrices
        ? 'Auctions included because there were limited fixed-price results.'
        : 'Auctions excluded from price stats; shown for context only.'
      : '';
    comparablesMixNote = `
      <div style="margin-top: 12px; font-size: 11px; color: var(--text-secondary); text-align: center; line-height: 1.5;">
        Comparables mix: ${summaryParts.join(' • ')}${auctionDetail ? `<br>${auctionDetail}` : ''}
      </div>
    `;
  }

  const matchDescription = priceData.matchDescription || '';
  const mismatchWarning = priceData.mismatchWarning || '';
  let matchQualityNote = '';

  if (matchDescription) {
    matchQualityNote += `
      <div style="margin-top: 8px; font-size: 11px; color: var(--text-secondary); text-align: center; line-height: 1.5;">
        ${matchDescription}
      </div>
    `;
  }

  if (mismatchWarning) {
    matchQualityNote += `
      <div style="margin-top: 8px; font-size: 11px; color: #b45309; background: rgba(251, 191, 36, 0.18); border: 1px solid rgba(251, 191, 36, 0.4); padding: 8px 10px; border-radius: 6px;">
        ${mismatchWarning}
      </div>
    `;
  }

  // Calculate positions on the number line
  let lineHtml = '';
  if (current != null && median != null && min != null && max != null) {
    // Determine the range for the number line with padding and current price inclusion
    const numericValues = [min, max, median, current].filter(
      (value) => typeof value === 'number' && Number.isFinite(value)
    );

    if (numericValues.length >= 2) {
      let rangeMinValue = Math.min(...numericValues);
      let rangeMaxValue = Math.max(...numericValues);

      if (rangeMinValue === rangeMaxValue) {
        rangeMaxValue = rangeMinValue + Math.max(Math.abs(rangeMinValue) * 0.1, 1);
      }

      const padding = Math.max((rangeMaxValue - rangeMinValue) * 0.12, 1);
      const rangeMin = Math.max(0, rangeMinValue - padding);
      const rangeMax = rangeMaxValue + padding;
      const range = rangeMax - rangeMin;

      const hasComparableMin = typeof min === 'number' && Number.isFinite(min);
      const hasComparableMax = typeof max === 'number' && Number.isFinite(max);

      const displayBestValue = Math.min(
        hasComparableMin ? min : current,
        current
      );
      const displayWorstValue = Math.max(
        hasComparableMax ? max : current,
        current
      );

      // Calculate percentage positions
      const currentPos = ((current - rangeMin) / range) * 100;
      const medianPos = ((median - rangeMin) / range) * 100;
      const minPos = ((displayBestValue - rangeMin) / range) * 100;
      const maxPos = ((displayWorstValue - rangeMin) / range) * 100;

      const clampPos = (value) => Math.max(0, Math.min(100, value));
      const currentClamped = clampPos(currentPos);
      const medianClamped = clampPos(medianPos);
      const minClamped = clampPos(minPos);
      const maxClamped = clampPos(maxPos);

      const diffFromMedian = current - median;
      const tolerance = median != null ? Math.max(median * 0.015, 2) : 3;
      const withinTolerance = Math.abs(diffFromMedian) <= tolerance;

      let priceStatus = 'Above Market';
      let priceStatusClass = 'badge-danger';
      let currentColor = 'var(--negative-strong)';

      if (withinTolerance) {
        priceStatus = 'At Market';
        priceStatusClass = 'badge-info';
        currentColor = 'var(--accent-strong)';
      } else if (current < median - tolerance) {
        priceStatus = 'Below Market';
        priceStatusClass = 'badge-success';
        currentColor = 'var(--positive-strong)';
      }

      const minOverlapOffset = Math.abs(minClamped - medianClamped) < 6 ? 8 : 0;
      const maxOverlapOffset = Math.abs(maxClamped - medianClamped) < 6 ? 8 : 0;

      lineHtml = `
      <div style="margin: 20px 0 24px 0;">
        <!-- Status badge -->
        <div style="text-align: center; margin-bottom: 12px;">
          <span class="badge ${priceStatusClass}" style="font-size: 12px;">
            ${priceStatus}
          </span>
        </div>

        <!-- Number line container -->
        <div style="position: relative; height: 90px; margin: 0 20px;">
          <!-- Segmented bar with median divider -->
          <div style="position: absolute; top: 44px; left: 0; right: 0; height: 12px;">
            <div style="position: absolute; inset: 0; border-radius: 8px; background: var(--border);"></div>
            <div style="position: absolute; top: 0; bottom: 0; left: 0; width: ${medianClamped}%; background: var(--positive-fill); border-radius: 8px 0 0 8px;"></div>
            <div style="position: absolute; top: 0; bottom: 0; left: ${medianClamped}%; width: ${Math.max(0, 100 - medianClamped)}%; background: var(--negative-fill); border-radius: 0 8px 8px 0;"></div>
            <div style="position: absolute; top: -8px; bottom: -8px; left: ${medianClamped}%; width: 3px; background: var(--accent-strong); border-radius: 2px; transform: translateX(-50%);"></div>
          </div>

          <!-- Min marker -->
          <div style="position: absolute; left: ${minClamped}%; top: 64px; transform: translateX(-50%);">
            <div style="width: 2px; height: 8px; background: var(--text-secondary); margin: 0 auto;"></div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-top: ${4 + minOverlapOffset}px; white-space: nowrap;">Best<br>${formatPrice(displayBestValue)}</div>
          </div>

          <!-- Max marker -->
          <div style="position: absolute; left: ${maxClamped}%; top: 64px; transform: translateX(-50%);">
            <div style="width: 2px; height: 8px; background: var(--text-secondary); margin: 0 auto;"></div>
            <div style="font-size: 10px; color: var(--text-secondary); margin-top: ${4 + maxOverlapOffset}px; white-space: nowrap;">Worst<br>${formatPrice(displayWorstValue)}</div>
          </div>

          <!-- Median marker -->
          <div style="position: absolute; left: ${medianClamped}%; top: 64px; transform: translateX(-50%);">
            <div style="width: 3px; height: 8px; background: var(--accent-strong); margin: 0 auto; border-radius: 2px;"></div>
            <div style="font-size: 11px; font-weight: 600; color: var(--accent-strong); margin-top: 4px; white-space: nowrap;">Median<br>${formatPrice(median)}</div>
          </div>

          <!-- Current price marker (circle) -->
          <div style="position: absolute; left: ${currentClamped}%; top: 16px; transform: translateX(-50%);">
            <div style="width: 14px; height: 14px; background: ${currentColor}; border: 3px solid var(--surface); border-radius: 50%; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,0.2);"></div>
            <div style="font-size: 13px; font-weight: 700; color: ${currentColor}; margin-top: -32px; white-space: nowrap; text-align: center;">
              ${formatPrice(current)}
            </div>
          </div>
        </div>
      </div>

      <!-- Stats row -->
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 28px;">
        <div class="comparables-btn" data-comparables='${comparablesDataAttr}' style="text-align: center; padding: 10px; background: var(--surface-muted); border-radius: 6px; cursor: pointer; border: 1px solid var(--border); transition: all 0.2s;">
          <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px;">Comparables</div>
          <div style="font-size: 16px; font-weight: 600;">${comparablesCountDisplay}</div>
        </div>
        <div style="text-align: center; padding: 10px; background: var(--surface-muted); border-radius: 6px; border: 1px solid transparent;">
          <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 4px;">vs Median</div>
          <div style="font-size: 16px; font-weight: 600; color: ${currentColor};">
            ${withinTolerance ? '≈$0.00' : `${diffFromMedian < 0 ? '-' : '+'}$${Math.abs(diffFromMedian).toFixed(2)}`}
          </div>
        </div>
      </div>

      ${comparablesMixNote}${matchQualityNote}

      <!-- Comparables list (initially hidden) -->
      <div id="comparablesList" style="display: none;"></div>
    `;
    } else {
      lineHtml = `
        <div class="price-comparison">
          <div class="price-item">
            <div class="price-label">Current Price</div>
            <div class="price-value">${formatPrice(current)}</div>
          </div>
          <div class="price-item">
            <div class="price-label">Market Median</div>
            <div class="price-value">${formatPrice(median)}</div>
          </div>
          <div class="price-item">
            <div class="price-label">Best Price</div>
            <div class="price-value">${formatPrice(min)}</div>
          </div>
        <div class="price-item">
          <div class="price-label">Comparables</div>
          <div class="price-value">${comparablesCountDisplay}</div>
        </div>
      </div>
      `;
    }
  } else {
    // Fallback to grid layout if we don't have enough data for the line
    lineHtml = `
      <div class="price-comparison">
        <div class="price-item">
          <div class="price-label">Current Price</div>
          <div class="price-value">${formatPrice(current)}</div>
        </div>
        <div class="price-item">
          <div class="price-label">Market Median</div>
          <div class="price-value">${formatPrice(median)}</div>
        </div>
        <div class="price-item">
          <div class="price-label">Best Price</div>
          <div class="price-value">${formatPrice(min)}</div>
        </div>
      <div class="price-item">
        <div class="price-label">Comparables</div>
        <div class="price-value">${comparablesCountDisplay}</div>
      </div>
    </div>
    ${comparablesMixNote}${matchQualityNote}
  `;
  }

  return `
    <div class="card">
      <div class="card-title">Price Comparison</div>
      ${lineHtml}
    </div>
  `;
}

/**
 * Render sentiment analysis (Pros/Cons)
 */
function renderSentimentAnalysis(sentiment) {
  if (!sentiment) return '';

  const pros = sentiment.pros || [];
  const cons = sentiment.cons || [];

  return `
    <div class="card">
      <div class="card-title">Review Analysis</div>
      <div class="pros-cons">
        <div class="pros">
          <h4>Pros</h4>
          <ul>
            ${pros.length > 0 ? pros.map(pro => `<li>${pro}</li>`).join('') : '<li>No pros found</li>'}
          </ul>
        </div>
        <div class="cons">
          <h4>Cons</h4>
          <ul>
            ${cons.length > 0 ? cons.map(con => `<li>${con}</li>`).join('') : '<li>No cons found</li>'}
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderReviewHighlights(product) {
  if (!product?.reviews?.length) return '';

  const reviewItems = product.reviews.slice(0, 5).map(review => {
    const numberRating = typeof review.rating === 'number' ? review.rating : null;
    const ratingLabel = numberRating != null ? `${numberRating.toFixed(1)}/5` : '';
    const ratingDisplay = ratingLabel || 'Rating unavailable';
    const helpful = typeof review.helpfulCount === 'number' && review.helpfulCount > 0
      ? `${review.helpfulCount} found helpful`
      : '';
    const bodyText = review.body || 'No review text available.';
    const normalizedTitle = (review.title || '').trim();
    const titleLooksLikeRating = normalizedTitle && normalizedTitle.toLowerCase().includes('out of 5');
    const titleSpan = normalizedTitle && !titleLooksLikeRating
      ? `<span class="review-summary-title">${normalizedTitle}</span>`
      : '';

    const metaParts = [];
    if (review.author) metaParts.push(`by ${review.author}`);
    if (helpful) metaParts.push(helpful);
    const metaLine = metaParts.length
      ? `<div class="review-summary-meta">${metaParts.map(part => `<span>${part}</span>`).join('<span>•</span>')}</div>`
      : '';

    const badgeElements = (review.badges || []).map(badge => `<span class="badge badge-info">${badge}</span>`).join('');
    const badgeLine = badgeElements
      ? `<div class="review-summary-badges">${badgeElements}</div>`
      : '';

    const formattedDate = formatReviewDate(review.date);
    const dateHtml = formattedDate
      ? `<span class="review-summary-date">${formattedDate}</span>`
      : '';

    const highlightButton = review.selector
      ? `<button class="review-highlight-btn" data-highlight-selector="${review.selector}">View this section on the page</button>`
      : '';

    return `
      <details class="review-highlight">
        <summary class="review-summary">
          <span class="review-summary-chevron" aria-hidden="true">▸</span>
          <div class="review-summary-content">
            <div class="review-summary-header">
              <div class="review-summary-header-main">
                <span class="review-rating-badge">${ratingDisplay}</span>
                ${titleSpan}
              </div>
              ${dateHtml}
            </div>
            ${metaLine}
            ${badgeLine}
            <div class="review-summary-hint">Click to expand and read the full review</div>
          </div>
        </summary>
        <div class="review-body">${bodyText}</div>
        ${highlightButton ? `<div class="review-actions">${highlightButton}</div>` : ''}
      </details>
    `;
  }).join('');

  return `
    <div class="card">
      <div class="card-title">Top On-Page Reviews</div>
      <div>${reviewItems}</div>
    </div>
  `;
}

function formatReviewDate(rawDate) {
  if (!rawDate || typeof rawDate !== 'string') {
    return '';
  }

  const trimmed = rawDate.trim();
  const stripped = trimmed.replace(/^Reviewed in\s.+\son\s+/i, '').trim();
  const candidate = stripped || trimmed;

  const parsed = Date.parse(candidate);
  if (!Number.isNaN(parsed)) {
    try {
      return new Date(parsed).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } catch {
      return candidate;
    }
  }

  return candidate;
}

function renderExternalReviewIntel(externalReviews) {
  if (!externalReviews?.analysis) return '';

  const { analysis, query } = externalReviews;
  const keyFindings = (analysis.keyFindings || []).slice(0, 5).map(finding => `<li>${finding}</li>`).join('') || '<li>No external findings captured.</li>';
  const bestLinks = (analysis.bestLinks || []).slice(0, 3).map(link => `
    <li>
      <a href="${link.url}" target="_blank" rel="noopener" class="link-button">${link.title}</a>
      <div style="font-size: 12px; color: #6b7280; margin-top: 2px;">${link.reason || 'Relevant insight'}</div>
    </li>
  `).join('') || '<li>No suggested sources yet.</li>';

  return `
    <div class="card">
      <div class="card-title">Web Consensus</div>
      <div style="font-size: 13px; line-height: 1.6;">
        <div style="margin-bottom: 8px; color: #6b7280;">Search query: <strong>${query}</strong></div>
        <div style="margin-bottom: 12px;">${analysis.summary || 'No summary available.'}</div>
        <div>
          <strong>Key findings</strong>
          <ul style="margin: 6px 0 12px 20px;">${keyFindings}</ul>
        </div>
        <div>
          <strong>Helpful sources</strong>
          <ul style="margin: 6px 0 0 20px;">${bestLinks}</ul>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render spec analysis
 */
function renderSpecAnalysis(specAnalysis) {
  if (!specAnalysis || !specAnalysis.conflicts) return '';

  const conflicts = specAnalysis.conflicts || [];

  return `
    <div class="card">
      <div class="card-title">Specification Analysis</div>
      ${conflicts.length > 0
        ? `<div class="error" style="margin-top: 12px;">
            <strong>Conflicts Found:</strong>
            <ul style="margin-left: 20px; margin-top: 8px;">
              ${conflicts.map(c => `<li>${c}</li>`).join('')}
            </ul>
          </div>`
        : `<div style="color: #16a34a; font-size: 13px;">✓ No specification conflicts detected</div>`
      }
    </div>
  `;
}

/**
 * Render fit analysis (Fashion mode)
 */
function renderFitAnalysis(fitAnalysis) {
  if (!fitAnalysis) return '';

  return `
    <div class="card">
      <div class="card-title">Fit & Sizing Analysis</div>
      <div class="pros-cons">
        <div class="pros">
          <h4>Fit Insights</h4>
          <ul>
            ${fitAnalysis.pros?.map(p => `<li>${p}</li>`).join('') || '<li>No data</li>'}
          </ul>
        </div>
        <div class="cons">
          <h4>Sizing Concerns</h4>
          <ul>
            ${fitAnalysis.cons?.map(c => `<li>${c}</li>`).join('') || '<li>No data</li>'}
          </ul>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render beauty analysis
 */
function renderBeautyAnalysis(beautyAnalysis) {
  if (!beautyAnalysis) return '';

  return `
    <div class="card">
      <div class="card-title">Beauty Product Analysis</div>
      <div style="font-size: 13px; line-height: 1.6;">
        ${beautyAnalysis.summary || 'Analysis in progress...'}
      </div>
    </div>
  `;
}

/**
 * Render sold comps (Collectibles mode)
 */
function renderSoldComps(soldComps) {
  if (!soldComps) return '';

  return `
    <div class="card">
      <div class="card-title">Sold Comparables</div>
      <div class="price-comparison">
        <div class="price-item">
          <div class="price-label">Avg Sold Price</div>
          <div class="price-value">${soldComps.avgPrice || 'N/A'}</div>
        </div>
        <div class="price-item">
          <div class="price-label">Recent Sales</div>
          <div class="price-value">${soldComps.count || 0}</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render DealSense blocked warning for critical red flags
 */
function renderDealSenseBlocked(dealSense) {
  if (!dealSense?.redFlags?.length) return '';

  let html = `
    <div class="card" style="border: 3px solid #ef4444; background: linear-gradient(to bottom, #ffffff, #fef2f2);">
      <div class="card-title">Critical Warning - DO NOT BID</div>
      <div style="padding: 14px; background: #fee2e2; border-radius: 8px; border: 2px solid #ef4444; margin-bottom: 16px;">
        <div style="font-weight: 700; font-size: 16px; color: #dc2626; margin-bottom: 8px;">
          ⚠️ SERIOUS ISSUES DETECTED
        </div>
        <div style="font-size: 13px; color: #991b1b; line-height: 1.6;">
          DealSense has blocked bidding recommendations due to critical problems with this listing.
        </div>
      </div>
  `;

  dealSense.redFlags.forEach(flag => {
    html += `
      <div style="border: 2px solid #dc2626; border-radius: 8px; padding: 14px; margin-bottom: 12px; background: #ffffff;">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
          <span style="font-size: 24px;">❌</span>
          <div style="font-weight: 700; font-size: 15px; color: #dc2626;">${flag.message}</div>
        </div>
        <div style="padding: 10px; background: #fef2f2; border-radius: 6px; border: 1px solid #fecaca; margin-top: 10px;">
          <div style="font-weight: 600; font-size: 13px; color: #991b1b; margin-bottom: 4px;">Recommendation:</div>
          <div style="font-size: 13px; color: #7f1d1d; line-height: 1.5;">${flag.action}</div>
        </div>
      </div>
    `;
  });

  html += `
    <div style="margin-top: 16px; padding: 12px; background: #fffbeb; border-radius: 6px; border: 1px solid #fbbf24; font-size: 12px; color: #92400e;">
      <strong>Why is DealSense blocked?</strong><br>
      These issues make the item unsuitable for purchase at any price. DealSense protects you by refusing to recommend bids on problematic listings.
    </div>
  </div>
  `;

  return html;
}

/**
 * Render DealSense Analysis (Buy Score + eBay strategies)
 * Shows for both Amazon and eBay - it's the brand name
 */
function renderDealSense(dealSense, productData, buyScore, recommendation) {
  // Skip if no data to show
  if (!buyScore && !dealSense) return '';

  // Handle blocked state (critical red flags)
  if (dealSense?.blocked) {
    return renderDealSenseBlocked(dealSense);
  }

  const hasAuction = !!dealSense?.snipeBids;
  const hasBestOffer = !!dealSense?.offerTiers;

  // DealSense card can now show even without auction/offer if there's a Buy Score
  let html = `
    <div class="card dealsense-card">
      <div class="card-title">DealSense Analysis</div>
  `;

  // Buy Score Speedometer (if available)
  if (buyScore && recommendation) {
    const score = buyScore.total || 0;
    const percentage = (score / 10) * 100; // Convert 0-10 score to 0-100%
    const rotation = -90 + (percentage * 1.8);
    const infoWidgets = buildBuyScoreInfoWidgets(buyScore);

    html += `
      <div style="margin-bottom: 20px;">
        <div class="speedometer" style="display: flex; flex-direction: column; align-items: center;">
          <svg viewBox="0 0 200 120" style="width: 100%; max-width: 300px; display: block; margin: 0 auto;">
            <!-- Gradient definition -->
            <defs>
              <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" style="stop-color:#ef4444;stop-opacity:1" />
                <stop offset="50%" style="stop-color:#f59e0b;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#22c55e;stop-opacity:1" />
              </linearGradient>
            </defs>

            <!-- Gray background arc -->
            <path d="M 30 100 A 70 70 0 0 1 170 100"
                  fill="none"
                stroke="var(--border)"
                  stroke-width="20"
                  stroke-linecap="round"/>

            <!-- Colored arc with gradient -->
            <path d="M 30 100 A 70 70 0 0 1 170 100"
                  fill="none"
                  stroke="url(#scoreGradient)"
                  stroke-width="20"
                  stroke-linecap="round"
                  stroke-dasharray="${percentage * 2.2}, 220"
                  style="transition: stroke-dasharray 0.5s ease;"/>

            <!-- Needle -->
            <g transform="translate(100, 100)">
              <line x1="0" y1="0" x2="0" y2="-60"
                    stroke="#374151"
                    stroke-width="3"
                    stroke-linecap="round"
                    transform="rotate(${rotation})"
                    style="transition: transform 0.5s ease;"/>
              <circle cx="0" cy="0" r="6" fill="#374151"/>
            </g>
          </svg>

          <!-- Score value display -->
          <div style="text-align: center; margin-top: 0px;">
            <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
              <div style="font-size: 36px; font-weight: 700; color: ${recommendation.color};">
                ${score.toFixed(1)}
              </div>
              ${infoWidgets.buttonHtml}
            </div>
            <div style="font-size: 16px; font-weight: 600; color: ${recommendation.color}; margin-top: 4px;">
              ${recommendation.verdict}
            </div>
            <div style="font-size: 13px; color: #6b7280; margin-top: 8px; line-height: 1.4;">
              ${recommendation.message}
            </div>
          </div>
        </div>
      </div>
      ${infoWidgets.panelHtml}
    `;
  }

  // Show strategy reason if both auction and offer exist
  const strategyReason = dealSense?.strategyReason;
  if (strategyReason) {
    html += `
      <div style="padding: 10px; background: #e0f2fe; border-radius: 6px; border: 1px solid #0284c7; margin-bottom: 16px; font-size: 13px;">
        <strong>💡 ${strategyReason}</strong>
      </div>
    `;
  }

  // AFP Summary
  if (dealSense?.afp) {
    const confidenceBadge = (dealSense.confidence || 0) >= 70
      ? '<span class="badge badge-success">High Confidence</span>'
      : (dealSense.confidence || 0) >= 50
        ? '<span class="badge badge-info">Medium Confidence</span>'
        : '<span class="badge badge-warning">Low Confidence</span>';

    html += `
      <div style="margin-bottom: 16px; padding: 12px; background: #f0f9ff; border-radius: 8px; border: 1px solid #3b82f6;">
        <div style="font-weight: 600; margin-bottom: 6px;">Fair Market Value</div>
        <div style="font-size: 24px; font-weight: 700; color: #3b82f6; margin-bottom: 6px;">
          $${dealSense.afp.value.toFixed(2)}
        </div>
        <div style="font-size: 12px; color: #6b7280;">
          Based on ${dealSense.afp.source} • ${confidenceBadge}
        </div>
      </div>
    `;
  }

  // Auction Snipe Bids
  if (hasAuction) {
    html += renderSnipeBids(dealSense.snipeBids, dealSense.auctionTiming);
  }

  // Best Offer Tiers
  if (hasBestOffer) {
    html += renderBestOfferTiers(dealSense.offerTiers, dealSense.negotiationMessages, dealSense.sellerSignals);
  }

  // Competition & Insights
  if (dealSense && (dealSense.competitionScore || dealSense.listingQuality)) {
    html += renderDealSenseInsights(dealSense);
  }

  html += `</div>`;
  return html;
}

/**
 * Render snipe bid recommendations
 */
function renderSnipeBids(snipeBids, auctionTiming) {
  if (!snipeBids?.bids) return '';

  const recommended = snipeBids.recommended;
  const bids = snipeBids.bids;

  // Urgency indicator
  let urgencyBadge = '';
  let timingMessage = snipeBids.timing || 'Wait until final 5-10 seconds to place your bid';

  if (auctionTiming) {
    if (auctionTiming.urgency === 'critical') {
      urgencyBadge = '<span class="badge" style="background: #ef4444; color: white;">ENDING NOW</span>';
      timingMessage = auctionTiming.message;
    } else if (auctionTiming.urgency === 'high') {
      urgencyBadge = '<span class="badge" style="background: #f59e0b; color: white;">ENDING SOON</span>';
      timingMessage = auctionTiming.message;
    } else if (auctionTiming.urgency === 'medium') {
      urgencyBadge = '<span class="badge badge-info">ENDING TODAY</span>';
    }
  }

  let html = `
    <div style="margin-bottom: 16px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h4 style="margin: 0; font-size: 14px; font-weight: 600;">⚡ Snipe Bid Strategy</h4>
        ${urgencyBadge}
      </div>
      <div style="padding: 10px; background: #fff3cd; border-radius: 6px; border: 1px solid #ffc107; margin-bottom: 12px; font-size: 13px;">
        <strong>🎯 ${timingMessage}</strong>
      </div>
  `;

  // Render bid tiers
  Object.keys(bids).forEach(key => {
    const bid = bids[key];
    const isRecommended = key === recommended;
    const borderColor = isRecommended ? '#3b82f6' : '#e5e7eb';
    const bgColor = isRecommended ? '#eff6ff' : '#ffffff';

    html += `
      <div style="border: 2px solid ${borderColor}; background: ${bgColor}; border-radius: 8px; padding: 12px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="font-weight: 600;">${bid.label}</div>
          <div style="font-size: 20px; font-weight: 700; color: #3b82f6;">${bid.formatted}</div>
        </div>
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 8px;">${bid.reasoning}</div>
        <div style="font-size: 12px; color: #6b7280;">${bid.description}</div>
        ${isRecommended ? '<div style="margin-top: 8px;"><span class="badge badge-success">✓ Recommended</span></div>' : ''}
        <button class="copy-bid-btn" data-amount="${bid.formatted}" style="margin-top: 8px; padding: 6px 12px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">
          📋 Copy Bid Amount
        </button>
      </div>
    `;
  });

  html += `</div>`;
  return html;
}

/**
 * Render Best Offer tiers
 */
function renderBestOfferTiers(offerTiers, negotiationMessages, sellerSignals) {
  if (!offerTiers?.offers) return '';

  const recommended = offerTiers.recommended;
  const offers = offerTiers.offers;

  let html = `
    <div style="margin-bottom: 16px;">
      <h4 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600;">💬 Best Offer Strategy</h4>
  `;

  // Seller signals
  if (sellerSignals?.signals?.length > 0) {
    html += `
      <div style="padding: 10px; background: #f0fdf4; border-radius: 6px; border: 1px solid #22c55e; margin-bottom: 12px; font-size: 12px;">
        <strong>💡 Seller Insights:</strong>
        <ul style="margin: 6px 0 0 20px; padding: 0;">
          ${sellerSignals.signals.map(signal => `<li>${signal}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  // Render offer tiers
  Object.keys(offers).forEach(key => {
    const offer = offers[key];
    const isRecommended = key === recommended;
    const borderColor = isRecommended ? '#22c55e' : '#e5e7eb';
    const bgColor = isRecommended ? '#f0fdf4' : '#ffffff';
    const message = negotiationMessages?.[key] || '';

    html += `
      <div style="border: 2px solid ${borderColor}; background: ${bgColor}; border-radius: 8px; padding: 12px; margin-bottom: 10px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <div style="font-weight: 600;">${offer.label}</div>
          <div style="font-size: 20px; font-weight: 700; color: #22c55e;">${offer.formatted}</div>
        </div>
        <div style="font-size: 12px; color: #6b7280; margin-bottom: 6px;">${offer.description}</div>
        <div style="font-size: 12px; color: #6b7280;">Acceptance chance: <strong>${offer.acceptance}</strong></div>
        ${isRecommended ? '<div style="margin-top: 8px;"><span class="badge badge-success">✓ Recommended</span></div>' : ''}
        ${message ? `
          <details style="margin-top: 10px;">
            <summary style="cursor: pointer; font-size: 12px; font-weight: 600; color: #3b82f6;">💬 View Message Template</summary>
            <div style="margin-top: 8px; padding: 10px; background: #f8fafc; border-radius: 6px; font-size: 12px; line-height: 1.5; border: 1px solid #e5e7eb;">
              ${message}
              <button class="copy-message-btn" data-message="${message.replace(/"/g, '&quot;')}" style="margin-top: 8px; padding: 6px 12px; background: #22c55e; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; width: 100%;">
                📋 Copy Message
              </button>
            </div>
          </details>
        ` : ''}
      </div>
    `;
  });

  html += `</div>`;
  return html;
}

/**
 * Render DealSense insights
 */
function renderDealSenseInsights(dealSense) {
  const insights = [];

  // Competition insight
  if (dealSense.competitionScore === 'low') {
    insights.push({
      icon: '🎁',
      title: 'Low Competition',
      message: 'Fewer bidders means better chance for below-market price'
    });
  } else if (dealSense.competitionScore === 'high') {
    insights.push({
      icon: '⚠️',
      title: 'High Competition',
      message: 'Many bidders detected - consider aggressive bid or alternative listings'
    });
  }

  // Listing quality insights
  if (dealSense.listingQuality?.hiddenGem) {
    insights.push({
      icon: '💎',
      title: 'Hidden Gem Detected',
      message: 'Poor listing quality = fewer competitors. Great opportunity!'
    });
  }

  if (dealSense.listingQuality?.insights?.length > 0) {
    dealSense.listingQuality.insights.forEach(insight => {
      insights.push({
        icon: '📝',
        title: 'Listing Note',
        message: insight
      });
    });
  }

  if (insights.length === 0) return '';

  let html = `
    <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
      <h4 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600;">💡 Smart Insights</h4>
  `;

  insights.forEach(insight => {
    html += `
      <div style="padding: 10px; background: #f8fafc; border-radius: 6px; border: 1px solid #e5e7eb; margin-bottom: 8px; font-size: 12px;">
        <div style="font-weight: 600; margin-bottom: 4px;">${insight.icon} ${insight.title}</div>
        <div style="color: #6b7280;">${insight.message}</div>
      </div>
    `;
  });

  html += `</div>`;
  return html;
}

/**
 * Render Q&A section
 */
function renderQASection() {
  return `
    <div class="card qa-section">
      <div class="card-title">Ask a Question</div>
      <div class="qa-input-container">
        <input
          type="text"
          class="qa-input"
          id="qaInput"
          placeholder="Ask anything about this product..."
        >
        <button class="qa-btn" id="qaBtn">Ask</button>
      </div>
      <div id="qaAnswer"></div>
    </div>
  `;
}

/**
 * Attach Q&A event listeners
 */
function attachQAEventListeners() {
  const qaInput = document.getElementById('qaInput');
  const qaBtn = document.getElementById('qaBtn');

  if (qaInput && qaBtn) {
    qaBtn.addEventListener('click', handleQuestionSubmit);
    qaInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleQuestionSubmit();
    });
  }
}

function attachReviewHighlightHandlers() {
  document.querySelectorAll('[data-highlight-selector]').forEach(button => {
    button.addEventListener('click', () => {
      const selector = button.getAttribute('data-highlight-selector');
      if (selector) {
        highlightSource(selector);
      }
    });
  });
}

/**
 * Attach comparables event listeners
 */
function attachComparablesEventListeners() {
  const comparablesBtn = document.querySelector('.comparables-btn');
  if (!comparablesBtn) return;

  let isExpanded = false;

  comparablesBtn.addEventListener('click', () => {
    const comparablesData = comparablesBtn.getAttribute('data-comparables');
    const comparablesList = document.getElementById('comparablesList');

    if (!comparablesList || !comparablesData) return;

    if (isExpanded) {
      // Collapse the list
      comparablesList.style.display = 'none';
      isExpanded = false;
    } else {
      // Expand and show the list
      try {
        const comparables = JSON.parse(comparablesData);

        if (!Array.isArray(comparables) || comparables.length === 0) {
          comparablesList.innerHTML = `
            <div class="comparables-list">
              <div style="text-align: center; color: var(--text-secondary); font-size: 13px;">No comparable listings found</div>
            </div>
          `;
        } else {
          const itemsHtml = comparables.map((comp, index) => {
            const title = comp.title || `Listing ${index + 1}`;
            const priceLabel = comp.priceLabel || (typeof comp.priceValue === 'number' ? `$${comp.priceValue.toFixed(2)}` : 'N/A');
            const condition = comp.condition || (comp.type === 'stat' ? 'Derived insight' : '—');
            const url = comp.url && comp.url !== '#' ? comp.url : null;
            const source = comp.source ? `<div style="color: var(--text-secondary); font-size: 11px; margin-top: 2px;">${comp.source}</div>` : '';
            const description = comp.description ? `<div style="margin-top: 6px; font-size: 12px; color: var(--text-secondary);">${comp.description}</div>` : '';
            const isStat = comp.type === 'stat';
            let formatLabel = '';
            if (!isStat) {
              if (comp.listingFormat === 'auction' || comp.isAuction) {
                const bidsLabel =
                  typeof comp.bidCount === 'number'
                    ? ` · ${comp.bidCount} bid${comp.bidCount === 1 ? '' : 's'}`
                    : '';
                formatLabel = `Auction${bidsLabel}`;
              } else if (comp.listingFormat === 'buy_it_now') {
                formatLabel = 'Buy It Now';
              } else if (comp.listingFormat === 'best_offer') {
                formatLabel = 'Buy It Now / Best Offer';
              }
            }
            const timeLeftLabel = !isStat && comp.timeLeft ? `Time left ${comp.timeLeft}` : '';
            const formatParts = [formatLabel, timeLeftLabel].filter(Boolean);
            const formatLine = formatParts.length
              ? `<div style="margin-top: 6px; font-size: 12px; color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: 10px;">
                ${formatParts.map(part => `<span>${part}</span>`).join('')}
              </div>`
              : '';
            const titleContent = url
              ? `<a href="${url}" target="_blank" rel="noopener" style="color: #1d4ed8; text-decoration: none;">${title}</a>`
              : `<span style="color: #1f2937;">${title}</span>`;

            return `
              <div class="comparable-item">
                <div style="font-weight: 600; margin-bottom: 4px; font-size: 13px;">${titleContent}</div>
                ${source}
                <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px;">
                  <span style="color: var(--text-secondary);">Price:</span>
                  <span style="font-weight: 600; color: var(--positive-strong);">${priceLabel}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 12px;">
                  <span style="color: var(--text-secondary);">Condition:</span>
                  <span style="font-weight: 500;">${condition}</span>
                </div>
                ${formatLine}
                ${description}
              </div>
            `;
          }).join('');

          comparablesList.innerHTML = `
            <div class="comparables-list">
              <div style="font-weight: 600; margin-bottom: 10px; font-size: 13px; color: #1f2937;">
                📊 ${comparables.length} Comparable Listings
              </div>
              ${itemsHtml}
            </div>
          `;
        }

        comparablesList.style.display = 'block';
        isExpanded = true;
      } catch (error) {
        console.error('Error parsing comparables data:', error);
      }
    }
  });
}

/**
 * Attach DealSense event listeners (copy buttons)
 */
function attachDealSenseEventListeners() {
  // Copy bid amount buttons
  document.querySelectorAll('.copy-bid-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const amount = button.getAttribute('data-amount');
      if (amount) {
        try {
          await navigator.clipboard.writeText(amount);
          const originalText = button.textContent;
          button.textContent = '✓ Copied!';
          button.style.background = '#22c55e';
          setTimeout(() => {
            button.textContent = originalText;
            button.style.background = '#3b82f6';
          }, 2000);
        } catch (error) {
          console.error('Failed to copy bid amount:', error);
          button.textContent = '❌ Failed';
          setTimeout(() => {
            button.textContent = '📋 Copy Bid Amount';
          }, 2000);
        }
      }
    });
  });

  // Copy negotiation message buttons
  document.querySelectorAll('.copy-message-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const message = button.getAttribute('data-message');
      if (message) {
        try {
          // Decode HTML entities
          const decodedMessage = message.replace(/&quot;/g, '"');
          await navigator.clipboard.writeText(decodedMessage);
          const originalText = button.textContent;
          button.textContent = '✓ Copied!';
          button.style.background = '#10b981';
          setTimeout(() => {
            button.textContent = originalText;
            button.style.background = '#22c55e';
          }, 2000);
        } catch (error) {
          console.error('Failed to copy message:', error);
          button.textContent = '❌ Failed';
          setTimeout(() => {
            button.textContent = '📋 Copy Message';
          }, 2000);
        }
      }
    });
  });
}

function attachBuyScoreInfoHandlers() {
  const buttons = document.querySelectorAll('.buy-score-info-btn');
  const panels = document.querySelectorAll('.buy-score-info-modal');

  if (!buttons.length || !panels.length) {
    return;
  }

  let escListener = null;

  const teardownEsc = () => {
    if (escListener) {
      document.removeEventListener('keydown', escListener);
      escListener = null;
    }
  };

  const hideAllPanels = () => {
    panels.forEach((panel) => {
      panel.dataset.visible = 'false';
      panel.setAttribute('aria-hidden', 'true');
    });
    buttons.forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
    teardownEsc();
    document.body.style.removeProperty('overflow');
  };

  const showPanel = (panel, button) => {
    hideAllPanels();
    panel.dataset.visible = 'true';
    panel.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';

    const focusTarget = panel.querySelector('.buy-score-info-card');
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
    }

    if (!escListener) {
      escListener = (event) => {
        if (event.key === 'Escape') {
          hideAllPanels();
        }
      };
      document.addEventListener('keydown', escListener);
    }
  };

  buttons.forEach((button) => {
    const targetId = button.getAttribute('data-target');
    const panel = targetId ? document.getElementById(targetId) : null;
    if (!panel) {
      return;
    }

    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (panel.dataset.visible === 'true') {
        hideAllPanels();
      } else {
        showPanel(panel, button);
      }
    });

    panel.addEventListener('click', (event) => {
      if (event.target === panel) {
        hideAllPanels();
      }
    });

    const closeBtn = panel.querySelector('[data-close-modal]');
    if (closeBtn) {
      closeBtn.addEventListener('click', (event) => {
        event.preventDefault();
        hideAllPanels();
      });
    }
  });

  hideAllPanels();
}

/**
 * Handle question submission
 */
async function handleQuestionSubmit() {
  const qaInput = document.getElementById('qaInput');
  const qaBtn = document.getElementById('qaBtn');
  const question = qaInput.value.trim();

  if (!question) return;

  qaBtn.disabled = true;
  qaBtn.textContent = 'Thinking...';

  try {
    const response = await safeRuntimeSendMessage({
      type: 'USER_QUESTION',
      question,
      context: currentAnalysis
    });

    if (response.success) {
      displayAnswer(response.data);
    } else {
      displayAnswer({ answer: 'Sorry, I could not answer that question.', source: null });
    }
  } catch (error) {
    console.error('Error asking question:', error);
    displayAnswer({ answer: 'An error occurred. Please try again.', source: null });
  } finally {
    qaBtn.disabled = false;
    qaBtn.textContent = 'Ask';
    qaInput.value = '';
  }
}

/**
 * Display Q&A answer
 */
function displayAnswer(data) {
  const qaAnswer = document.getElementById('qaAnswer');
  if (!qaAnswer) return;

  const sourceHtml = data.source
    ? `<div class="qa-source" onclick="highlightSource('${data.source}')">📍 View source on page</div>`
    : '';

  const searchHtml = data.search?.summary
    ? `
      <div class="qa-search-context">
        <div style="font-weight: 600; margin-top: 12px;">Web Findings</div>
        <div style="font-size: 12px; color: #6b7280; margin-top: 4px;">${data.search.summary}</div>
        ${(data.search.bestLinks || []).slice(0, 3).map(link => `
          <div style="margin-top: 6px;">
            <a class="link-button" href="${link.url}" target="_blank" rel="noopener">${link.title}</a>
          </div>
        `).join('')}
      </div>
    `
    : '';

  qaAnswer.innerHTML = `
    <div class="qa-answer">
      ${data.answer}
      ${sourceHtml}
      ${searchHtml}
    </div>
  `;
}

/**
 * Highlight source on product page
 */
window.highlightSource = async function(selector) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'HIGHLIGHT_ELEMENT',
        selector
      });
    }
  } catch (error) {
    console.error('Error highlighting source:', error);
  }
};

console.log('ShopScout sidepanel loaded');
