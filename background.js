/**
 * ShopScout Background Service Worker - "The Brain"
 *
 * This service worker handles:
 * 1. Data triage and category detection
 * 2. Mode switching based on product type
 * 3. Price comparison scraping
 * 4. Claude API calls for analysis
 * 5. Buy Score calculation
 * 6. Communication between content script and sidepanel
 */

import { ClaudeAPI } from './src/modules/claude-api.js';
import { CategoryDetector } from './src/modules/category-detector.js';
import { BuyScoreCalculator } from './src/modules/buy-score-calculator.js';
import { PriceComparison } from './src/modules/price-comparison.js';
import { StopConditionChecker } from './src/modules/stop-condition-checker.js';

// Global state
let currentAnalysis = null;
let analysisCache = new Map();

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  console.log('ShopScout installed successfully');
});

// Listen for messages from content script and sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Required for async sendResponse
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.type) {
      case 'PRODUCT_DATA_SCRAPED':
        await handleProductDataScraped(message.data, sendResponse);
        break;

      case 'USER_QUESTION':
        await handleUserQuestion(message.question, message.context, sendResponse);
        break;

      case 'REFRESH_ANALYSIS':
        await refreshAnalysis(sendResponse);
        break;

      case 'GET_CURRENT_ANALYSIS':
        sendResponse({ success: true, data: currentAnalysis });
        break;

      case 'CLEAR_CACHE':
        console.log('[Background] Clearing cache and current analysis');
        analysisCache.clear();
        currentAnalysis = null;
        sendResponse({ success: true });
        break;

      case 'OPEN_CHAT_PANEL':
        await handleOpenChatPanel(sender, sendResponse);
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Main analysis pipeline - triggered when content script scrapes product data
 */
async function handleProductDataScraped(productData, sendResponse) {
  console.log('Received product data:', productData);

  // Check cache first
  const cacheKey = `${productData.site}_${productData.productId}`;
  if (analysisCache.has(cacheKey)) {
    const cached = analysisCache.get(cacheKey);
    // Cache for 5 minutes
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
      console.log('Returning cached analysis');
      currentAnalysis = cached.data;
      sendResponse({ success: true, data: cached.data });
      broadcastToSidepanel({ type: 'ANALYSIS_UPDATED', data: cached.data });
      return;
    }
  }

  // Step 1: Check stop conditions
  const stopCondition = StopConditionChecker.check(productData);
  if (stopCondition.shouldStop) {
    const result = {
      status: 'stopped',
      reason: stopCondition.reason,
      message: stopCondition.message,
      productData
    };
    currentAnalysis = result;
    sendResponse({ success: true, data: result });
    broadcastToSidepanel({ type: 'ANALYSIS_UPDATED', data: result });
    return;
  }

  // Step 2: Detect category and select mode
  const category = CategoryDetector.detect(productData);
  console.log('Detected category:', category);

  // Step 3: Run analysis based on mode
  const analysisResult = await runAnalysisByMode(productData, category);

  // Cache the result
  analysisCache.set(cacheKey, {
    data: analysisResult,
    timestamp: Date.now()
  });

  currentAnalysis = analysisResult;
  sendResponse({ success: true, data: analysisResult });
  broadcastToSidepanel({ type: 'ANALYSIS_UPDATED', data: analysisResult });
}

/**
 * Mode-specific analysis pipeline
 */
async function runAnalysisByMode(productData, category) {
  const result = {
    status: 'completed',
    category: category.name,
    mode: category.mode,
    productData,
    timestamp: Date.now()
  };

  switch (category.mode) {
    case 'ELECTRONICS':
      return await runElectronicsMode(result, productData);

    case 'FASHION':
      return await runFashionMode(result, productData);

    case 'BEAUTY':
      return await runBeautyMode(result, productData);

    case 'COLLECTIBLES':
      return await runCollectiblesMode(result, productData);

    case 'GENERIC_HOME_GOODS':
    default:
      return await runGenericMode(result, productData);
  }
}

/**
 * Electronics Mode - Full Buy Score with spec analysis
 */
async function runElectronicsMode(result, productData) {
  console.log('Running Electronics Mode');

  // Parallel execution of independent tasks
  const [priceData, specAnalysis, sentimentAnalysis] = await Promise.all([
    PriceComparison.fetchComparables(productData),
    ClaudeAPI.analyzeSpecs(productData),
    ClaudeAPI.analyzeSentiment(productData, 'ELECTRONICS')
  ]);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  // Calculate Buy Score
  const buyScore = BuyScoreCalculator.calculate({
    productData,
    priceData,
    specAnalysis,
    sentimentAnalysis
  });

  return {
    ...result,
    priceData,
    specAnalysis,
    sentimentAnalysis,
    buyScore,
    recommendation: generateRecommendation(buyScore)
  };
}

/**
 * Fashion Mode - No Buy Score, focus on Fit & Sizing
 */
async function runFashionMode(result, productData) {
  console.log('Running Fashion Mode');

  const [priceData, fitAnalysis] = await Promise.all([
    PriceComparison.fetchComparables(productData),
    ClaudeAPI.analyzeSentiment(productData, 'FASHION')
  ]);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  return {
    ...result,
    priceData,
    fitAnalysis,
    buyScore: null, // Disabled for fashion
    verdict: {
      type: 'fit_sizing',
      data: fitAnalysis
    }
  };
}

/**
 * Beauty Mode - Ingredient analysis and skin type matching
 */
async function runBeautyMode(result, productData) {
  console.log('Running Beauty Mode');

  const [priceData, beautyAnalysis] = await Promise.all([
    PriceComparison.fetchComparables(productData),
    ClaudeAPI.analyzeBeautyProduct(productData)
  ]);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  return {
    ...result,
    priceData,
    beautyAnalysis,
    buyScore: null, // Disabled for beauty
    verdict: {
      type: 'beauty_analysis',
      data: beautyAnalysis
    }
  };
}

/**
 * Collectibles Mode - Sold comps instead of active listings
 */
async function runCollectiblesMode(result, productData) {
  console.log('Running Collectibles Mode');

  const [soldComps, sentimentAnalysis] = await Promise.all([
    PriceComparison.fetchSoldListings(productData),
    ClaudeAPI.analyzeSentiment(productData, 'COLLECTIBLES')
  ]);

  return {
    ...result,
    soldComps,
    sentimentAnalysis,
    buyScore: null, // Disabled for collectibles
    verdict: {
      type: 'sold_comps',
      data: soldComps
    }
  };
}

/**
 * Generic Mode - Fallback price score with basic analysis
 */
async function runGenericMode(result, productData) {
  console.log('Running Generic Mode');

  const [priceData, sentimentAnalysis] = await Promise.all([
    PriceComparison.fetchComparables(productData),
    ClaudeAPI.analyzeSentiment(productData, 'GENERIC')
  ]);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  // Use fallback price score (percentile rank)
  const buyScore = BuyScoreCalculator.calculateFallback({
    productData,
    priceData,
    sentimentAnalysis
  });

  return {
    ...result,
    priceData,
    sentimentAnalysis,
    buyScore,
    recommendation: generateRecommendation(buyScore)
  };
}

/**
 * Handle user questions with grounded Q&A
 */
async function handleUserQuestion(question, context, sendResponse) {
  console.log('Handling user question:', question);

  // Use Claude to answer with RAG-style context
  const answer = await ClaudeAPI.answerQuestion(question, context);

  sendResponse({ success: true, data: answer });
  broadcastToSidepanel({ type: 'QUESTION_ANSWERED', data: answer });
}

/**
 * Generate recommendation based on Buy Score
 */
function generateRecommendation(buyScore) {
  if (buyScore >= 8) {
    return {
      verdict: 'Strong Buy',
      color: '#22c55e',
      message: 'Excellent value with strong ratings and fair price'
    };
  } else if (buyScore >= 6) {
    return {
      verdict: 'Good Buy',
      color: '#3b82f6',
      message: 'Good value, minor concerns to consider'
    };
  } else if (buyScore >= 4) {
    return {
      verdict: 'Proceed with Caution',
      color: '#f59e0b',
      message: 'Some concerns detected, review carefully'
    };
  } else {
    return {
      verdict: 'Not Recommended',
      color: '#ef4444',
      message: 'Significant concerns found, consider alternatives'
    };
  }
}

/**
 * Refresh analysis (clear cache and re-run)
 */
async function refreshAnalysis(sendResponse) {
  if (!currentAnalysis) {
    sendResponse({ success: false, error: 'No active analysis to refresh' });
    return;
  }

  analysisCache.clear();
  // Trigger re-scrape from content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'RE_SCRAPE' });
    }
  });

  sendResponse({ success: true });
}

/**
 * Open chat side panel
 */
async function handleOpenChatPanel(sender, sendResponse) {
  try {
    // Get the current window
    const window = await chrome.windows.getCurrent();

    // Open the side panel
    await chrome.sidePanel.open({ windowId: window.id });

    sendResponse({ success: true });
  } catch (error) {
    console.error('Error opening chat panel:', error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Broadcast message to sidepanel
 */
function broadcastToSidepanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Sidepanel might not be open, ignore error
  });
}

// Popup opens automatically when extension icon is clicked (no code needed)

console.log('ShopScout background service worker loaded');
