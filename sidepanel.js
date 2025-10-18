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
    }
  });

  // Poll for tab changes every 2 seconds
  let lastTabUrl = null;
  setInterval(async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url !== lastTabUrl) {
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
          await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });

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
    const response = await chrome.runtime.sendMessage({
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
  const maxAttempts = 10; // Poll for up to 10 seconds

  const pollInterval = setInterval(async () => {
    attempts++;

    const response = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_ANALYSIS' });

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
  refreshBtn.textContent = '🔄 Refreshing...';

  try {
    await chrome.runtime.sendMessage({ type: 'REFRESH_ANALYSIS' });
    showLoading();
  } catch (error) {
    console.error('Error refreshing:', error);
    showError('Failed to refresh analysis.');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '🔄 Refresh';
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
  contentDiv.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>Analyzing product...</p>
    </div>
  `;
}

/**
 * Render error message
 */
function showError(message) {
  contentDiv.innerHTML = `
    <div class="error">
      <strong>Error:</strong> ${message}
    </div>
  `;
}

/**
 * Render empty state
 */
function showEmptyState() {
  contentDiv.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">📦</div>
      <div class="empty-title">No Product Detected</div>
      <div class="empty-message">
        Navigate to an Amazon or eBay product page to see analysis.
      </div>
    </div>
  `;
}

/**
 * Render stop message (out of stock, variations, etc.)
 */
function renderStopMessage(analysis) {
  contentDiv.innerHTML = `
    <div class="stop-message">
      <strong>${analysis.reason}</strong>
      <p>${analysis.message}</p>
    </div>
    ${renderProductInfo(analysis.productData)}
  `;
}

/**
 * Render complete analysis
 */
function renderAnalysis(analysis) {
  const html = [];

  // Product info
  html.push(renderProductInfo(analysis.productData));

  // Mode-specific rendering
  switch (analysis.mode) {
    case 'ELECTRONICS':
      html.push(renderBuyScore(analysis.buyScore, analysis.recommendation));
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderSentimentAnalysis(analysis.sentimentAnalysis));
      html.push(renderSpecAnalysis(analysis.specAnalysis));
      break;

    case 'FASHION':
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderFitAnalysis(analysis.fitAnalysis));
      break;

    case 'BEAUTY':
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderBeautyAnalysis(analysis.beautyAnalysis));
      break;

    case 'COLLECTIBLES':
      html.push(renderSoldComps(analysis.soldComps));
      html.push(renderSentimentAnalysis(analysis.sentimentAnalysis));
      break;

    case 'GENERIC_HOME_GOODS':
    default:
      html.push(renderBuyScore(analysis.buyScore, analysis.recommendation));
      html.push(renderPriceComparison(analysis.priceData));
      html.push(renderSentimentAnalysis(analysis.sentimentAnalysis));
      break;
  }

  // Q&A section (always shown)
  html.push(renderQASection());

  contentDiv.innerHTML = html.join('');
  attachQAEventListeners();
}

/**
 * Render product info card
 */
function renderProductInfo(product) {
  if (!product) return '';

  const imageHtml = product.mainImage
    ? `<div style="display: flex; justify-content: center;">
         <img src="${product.mainImage}" alt="${product.title}" style="width: 100%; max-width: 200px; height: auto; border-radius: 8px; margin-bottom: 12px;">
       </div>`
    : '';

  // Auction info for eBay listings
  let auctionHtml = '';
  if (product.listing?.auction) {
    const auction = product.listing.auction;
    auctionHtml = `
      <div style="margin-top: 12px; padding: 10px; background: #fff3cd; border-radius: 6px; border: 1px solid #ffc107;">
        <div style="font-weight: 600; margin-bottom: 6px; color: #856404;">⚡ Auction</div>
        <div style="font-size: 12px; line-height: 1.8; color: #856404;">
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
      <div class="card-title">
        <span class="card-icon">📦</span>
        Product Info
      </div>
      ${imageHtml}
      <div style="font-size: 13px; line-height: 1.6;">
        <strong>${product.title}</strong><br>
        <span class="badge ${product.site === 'amazon' ? 'badge-warning' : 'badge-success'}">
          ${product.site.toUpperCase()}
        </span>
        ${product.price?.formatted ? `<span style="margin-left: 12px; font-weight: 600;">${product.price.formatted}</span>` : ''}
        ${listingBadges}
      </div>
      ${auctionHtml}
    </div>
  `;
}

/**
 * Render Buy Score card
 */
function renderBuyScore(buyScore, recommendation) {
  if (!buyScore || !recommendation) return '';

  const score = buyScore.total || 0;
  const color = recommendation.color || '#6b7280';

  return `
    <div class="buy-score-card">
      <div class="score-circle" style="background: ${color};">
        ${score.toFixed(1)}
      </div>
      <div class="score-label" style="color: ${color};">
        ${recommendation.verdict}
      </div>
      <div class="score-message">
        ${recommendation.message}
      </div>
    </div>
  `;
}

/**
 * Render price comparison
 */
function renderPriceComparison(priceData) {
  if (!priceData) return '';

  // Format price values
  const formatPrice = (price) => {
    if (price == null) return 'N/A';
    return `$${price.toFixed(2)}`;
  };

  return `
    <div class="card">
      <div class="card-title">
        <span class="card-icon">💰</span>
        Price Comparison
      </div>
      <div class="price-comparison">
        <div class="price-item">
          <div class="price-label">Current Price</div>
          <div class="price-value">${formatPrice(priceData.currentPrice)}</div>
        </div>
        <div class="price-item">
          <div class="price-label">Market Median</div>
          <div class="price-value">${formatPrice(priceData.median)}</div>
        </div>
        <div class="price-item">
          <div class="price-label">Best Price</div>
          <div class="price-value">${formatPrice(priceData.min)}</div>
        </div>
        <div class="price-item">
          <div class="price-label">Comparables</div>
          <div class="price-value">${priceData.compCount || 0}</div>
        </div>
      </div>
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
      <div class="card-title">
        <span class="card-icon">💭</span>
        Review Analysis
      </div>
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

/**
 * Render spec analysis
 */
function renderSpecAnalysis(specAnalysis) {
  if (!specAnalysis || !specAnalysis.conflicts) return '';

  const conflicts = specAnalysis.conflicts || [];

  return `
    <div class="card">
      <div class="card-title">
        <span class="card-icon">📋</span>
        Specification Analysis
      </div>
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
      <div class="card-title">
        <span class="card-icon">👕</span>
        Fit & Sizing Analysis
      </div>
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
      <div class="card-title">
        <span class="card-icon">💄</span>
        Beauty Product Analysis
      </div>
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
      <div class="card-title">
        <span class="card-icon">📊</span>
        Sold Comparables
      </div>
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
 * Render Q&A section
 */
function renderQASection() {
  return `
    <div class="card qa-section">
      <div class="card-title">
        <span class="card-icon">💬</span>
        Ask a Question
      </div>
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
    const response = await chrome.runtime.sendMessage({
      type: 'USER_QUESTION',
      question,
      context: currentAnalysis?.productData
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

  qaAnswer.innerHTML = `
    <div class="qa-answer">
      ${data.answer}
      ${sourceHtml}
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
