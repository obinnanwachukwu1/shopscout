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
import { WebSearch } from './src/modules/web-search.js';
import { DealSense } from './src/modules/dealsense.js';

// Global state
let currentAnalysis = null;
let analysisCache = new Map();
let pendingAnalyses = new Map();

const ANALYSIS_CACHE_TTL = 5 * 60 * 1000;
const EXTERNAL_REVIEW_TTL = 15 * 60 * 1000;

const externalReviewCache = new Map();
const externalReviewPending = new Map();

function cloneProductData(productData) {
  if (productData == null) {
    return productData;
  }

  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(productData);
    } catch (error) {
      console.warn('[Background] structuredClone failed, falling back to JSON clone:', error);
    }
  }

  try {
    return JSON.parse(JSON.stringify(productData));
  } catch (error) {
    console.error('[Background] Failed to clone product data:', error);
    return productData;
  }
}

function normalizeSpecAnalysis(raw, defaultConfidence = 0.6) {
  if (!raw || typeof raw !== 'object') {
    return {
      conflicts: [],
      redFlags: [],
      hasNewerModel: false,
      confidence: defaultConfidence
    };
  }

  return {
    conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
    redFlags: Array.isArray(raw.redFlags) ? raw.redFlags : [],
    hasNewerModel: Boolean(raw.hasNewerModel),
    confidence: typeof raw.confidence === 'number' ? raw.confidence : defaultConfidence
  };
}

function normalizeSentimentAnalysis(raw, mode, defaultConfidence = 0.6) {
  const focus = ClaudeAPI.getFocusAreaForMode(mode);

  if (!raw || typeof raw !== 'object') {
    return {
      focus,
      pros: [],
      cons: [],
      confidence: defaultConfidence
    };
  }

  return {
    focus: raw.focus || focus,
    pros: Array.isArray(raw.pros) ? raw.pros : [],
    cons: Array.isArray(raw.cons) ? raw.cons : [],
    confidence: typeof raw.confidence === 'number' ? raw.confidence : defaultConfidence
  };
}

function normalizeBeautyAnalysis(raw, defaultConfidence = 0.5) {
  if (!raw || typeof raw !== 'object') {
    return {
      summary: 'Analysis unavailable.',
      suitableFor: [],
      concerns: [],
      pros: [],
      cons: [],
      confidence: defaultConfidence
    };
  }

  return {
    summary: raw.summary || 'Analysis unavailable.',
    suitableFor: Array.isArray(raw.suitableFor) ? raw.suitableFor : [],
    concerns: Array.isArray(raw.concerns) ? raw.concerns : [],
    pros: Array.isArray(raw.pros) ? raw.pros : [],
    cons: Array.isArray(raw.cons) ? raw.cons : [],
    confidence: typeof raw.confidence === 'number' ? raw.confidence : defaultConfidence
  };
}

async function fetchExternalReviewIntel(productData) {
  if (!productData?.title) {
    return null;
  }

  const query = `${productData.title} reviews`;
  const cacheKey = `${productData.site || 'unknown'}::${query.toLowerCase()}`;

  const cached = externalReviewCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < EXTERNAL_REVIEW_TTL) {
    return cached.data;
  }

  if (externalReviewPending.has(cacheKey)) {
    try {
      return await externalReviewPending.get(cacheKey);
    } catch (error) {
      return null;
    }
  }

  const fetchPromise = (async () => {
    try {
      const searchResult = await WebSearch.smartSearch(query, {
        maxResults: 12,
        analysisResultCount: 5,
        useClaude: true
      });

      const payload = {
        query,
        ...searchResult
      };

      externalReviewCache.set(cacheKey, {
        data: payload,
        timestamp: Date.now()
      });

      return payload;
    } catch (error) {
      console.error('[Background] External review intel failed:', error);
      return null;
    } finally {
      externalReviewPending.delete(cacheKey);
    }
  })();

  externalReviewPending.set(cacheKey, fetchPromise);
  return await fetchPromise;
}

async function performAnalysis(productData, cacheKey) {
  const productSnapshot = cloneProductData(productData);

  // Step 1: Check stop conditions
  const stopCondition = StopConditionChecker.check(productData);
  if (stopCondition.shouldStop) {
    const result = {
      status: 'stopped',
      reason: stopCondition.reason,
      message: stopCondition.message,
      productData: productSnapshot,
      rawProductData: productSnapshot
    };

    analysisCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    return result;
  }

  // Step 2: Detect category and select mode
  const category = CategoryDetector.detect(productData);
  console.log('Detected category:', category);

  // Step 3: Run analysis based on mode
  const analysisResult = await runAnalysisByMode(productData, category);
  analysisResult.productData = productSnapshot;
  analysisResult.rawProductData = productSnapshot;

  analysisCache.set(cacheKey, {
    data: analysisResult,
    timestamp: Date.now()
  });

  return analysisResult;
}

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
        pendingAnalyses.clear();
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
    if (Date.now() - cached.timestamp < ANALYSIS_CACHE_TTL) {
      console.log('Returning cached analysis');
      currentAnalysis = cached.data;
      sendResponse({ success: true, data: cached.data });
      broadcastToSidepanel({ type: 'ANALYSIS_UPDATED', data: cached.data });
      return;
    }
  }

  let analysisPromise = pendingAnalyses.get(cacheKey);
  let isOwner = false;

  if (!analysisPromise) {
    isOwner = true;
    analysisPromise = performAnalysis(productData, cacheKey)
      .catch(error => {
        // Ensure the error propagates to awaiting callers
        throw error;
      });
    pendingAnalyses.set(cacheKey, analysisPromise);
  }

  try {
    const analysisResult = await analysisPromise;
    currentAnalysis = analysisResult;
    sendResponse({ success: true, data: analysisResult });

    if (isOwner) {
      broadcastToSidepanel({ type: 'ANALYSIS_UPDATED', data: analysisResult });
    }
  } catch (error) {
    console.error('Analysis pipeline failed:', error);
    sendResponse({ success: false, error: error.message });
  } finally {
    if (isOwner) {
      pendingAnalyses.delete(cacheKey);
    }
  }
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

  // Fetch price data only - removed external review search and spec analysis for speed
  const priceData = await PriceComparison.fetchComparables(productData);

  const bundle = await ClaudeAPI.analyzeProductBundle(productData, 'ELECTRONICS', {
    externalInsights: null
  });

  const sentimentAnalysis = normalizeSentimentAnalysis(bundle?.sentiment, 'ELECTRONICS', bundle?.confidence || 0.6);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  // Calculate Buy Score (without spec analysis)
  const buyScore = BuyScoreCalculator.calculate({
    productData,
    priceData,
    specAnalysis: null,
    sentimentAnalysis
  });

  // Add DealSense for eBay listings with auction/best offer
  let dealSense = null;
  if (productData.site === 'ebay') {
    dealSense = DealSense.analyze(productData, priceData);
  }

  return {
    ...result,
    priceData,
    specAnalysis: null,
    sentimentAnalysis,
    externalReviews: null,
    summary: bundle?.recommendation || null,
    buyScore,
    recommendation: generateRecommendation(buyScore),
    dealSense
  };
}

/**
 * Fashion Mode - No Buy Score, focus on Fit & Sizing
 */
async function runFashionMode(result, productData) {
  console.log('Running Fashion Mode');

  // Fetch price data only - removed external review search for speed
  const priceData = await PriceComparison.fetchComparables(productData);

  const bundle = await ClaudeAPI.analyzeProductBundle(productData, 'FASHION', {
    externalInsights: null
  });

  const fitAnalysis = normalizeSentimentAnalysis(bundle?.sentiment, 'FASHION', bundle?.confidence || 0.6);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  // Add DealSense for eBay listings with auction/best offer
  let dealSense = null;
  if (productData.site === 'ebay') {
    dealSense = DealSense.analyze(productData, priceData);
  }

  return {
    ...result,
    priceData,
    fitAnalysis,
    externalReviews: null,
    summary: bundle?.recommendation || null,
    buyScore: null, // Disabled for fashion
    verdict: {
      type: 'fit_sizing',
      data: fitAnalysis
    },
    dealSense
  };
}

/**
 * Beauty Mode - Ingredient analysis and skin type matching
 */
async function runBeautyMode(result, productData) {
  console.log('Running Beauty Mode');

  // Fetch price data only - removed external review search for speed
  const priceData = await PriceComparison.fetchComparables(productData);

  const bundle = await ClaudeAPI.analyzeProductBundle(productData, 'BEAUTY', {
    externalInsights: null
  });

  const beautyAnalysis = normalizeBeautyAnalysis(bundle?.beauty, bundle?.confidence || 0.5);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  // Add DealSense for eBay listings with auction/best offer
  let dealSense = null;
  if (productData.site === 'ebay') {
    dealSense = DealSense.analyze(productData, priceData);
  }

  return {
    ...result,
    priceData,
    beautyAnalysis,
    externalReviews: null,
    summary: bundle?.recommendation || null,
    buyScore: null, // Disabled for beauty
    verdict: {
      type: 'beauty_analysis',
      data: beautyAnalysis
    },
    dealSense
  };
}

/**
 * Collectibles Mode - Sold comps instead of active listings
 */
async function runCollectiblesMode(result, productData) {
  console.log('Running Collectibles Mode');

  // Fetch sold comps only - removed external review search for speed
  const soldComps = await PriceComparison.fetchSoldListings(productData);

  const bundle = await ClaudeAPI.analyzeProductBundle(productData, 'COLLECTIBLES', {
    externalInsights: null
  });

  const sentimentAnalysis = normalizeSentimentAnalysis(bundle?.sentiment, 'COLLECTIBLES', bundle?.confidence || 0.6);

  // Add DealSense for eBay listings with auction/best offer (use sold comps as price data)
  let dealSense = null;
  if (productData.site === 'ebay') {
    dealSense = DealSense.analyze(productData, soldComps);
  }

  return {
    ...result,
    soldComps,
    sentimentAnalysis,
    externalReviews: null,
    summary: bundle?.recommendation || null,
    buyScore: null, // Disabled for collectibles
    verdict: {
      type: 'sold_comps',
      data: soldComps
    },
    dealSense
  };
}

/**
 * Generic Mode - Fallback price score with basic analysis
 */
async function runGenericMode(result, productData) {
  console.log('Running Generic Mode');

  // Fetch price data only - removed external review search and spec analysis for speed
  const priceData = await PriceComparison.fetchComparables(productData);

  const bundle = await ClaudeAPI.analyzeProductBundle(productData, 'GENERIC_HOME_GOODS', {
    externalInsights: null
  });

  const sentimentAnalysis = normalizeSentimentAnalysis(bundle?.sentiment, 'GENERIC', bundle?.confidence || 0.6);

  // Add current price to priceData
  priceData.currentPrice = productData.price?.value || null;

  // Use fallback price score (percentile rank)
  const buyScore = BuyScoreCalculator.calculateFallback({
    productData,
    priceData,
    sentimentAnalysis
  });

  // Add DealSense for eBay listings with auction/best offer
  let dealSense = null;
  if (productData.site === 'ebay') {
    dealSense = DealSense.analyze(productData, priceData);
  }

  return {
    ...result,
    priceData,
    sentimentAnalysis,
    specAnalysis: null,
    externalReviews: null,
    summary: bundle?.recommendation || null,
    buyScore,
    recommendation: generateRecommendation(buyScore),
    dealSense
  };
}

/**
 * Handle user questions with grounded Q&A
 */
async function handleUserQuestion(question, context, sendResponse) {
  console.log('Handling user question:', question);

  const productData =
    context?.productData ||
    context?.rawProductData ||
    context?.analysis?.rawProductData ||
    context?.analysis?.productData ||
    currentAnalysis?.rawProductData ||
    currentAnalysis?.productData;
  if (!productData) {
    sendResponse({ success: false, error: 'No product context available' });
    return;
  }

  const externalReviews =
    context?.externalReviews ||
    context?.analysis?.externalReviews ||
    currentAnalysis?.externalReviews ||
    null;

  const progressHandler = (event) => {
    if (!event || typeof event !== 'object') {
      return;
    }

    broadcastToSidepanel({
      type: 'CHAT_PROGRESS',
      data: {
        question,
        ...event
      }
    });
  };

  try {
    // Use Claude to answer with RAG-style context and optional smart search
    const answer = await ClaudeAPI.answerQuestion(
      question,
      productData,
      externalReviews,
      {
        onProgress: progressHandler
      }
    );

    const streamId = generateId('answer');
    streamAnswerToSidepanel(streamId, answer).catch((error) => {
      console.error('[Background] Failed to stream answer:', error);
      broadcastToSidepanel({
        type: 'CHAT_STREAM_ERROR',
        data: {
          streamId,
          message: 'Failed to stream answer. Showing complete response instead.'
        }
      });
      broadcastToSidepanel({
        type: 'QUESTION_ANSWERED',
        data: {
          ...answer,
          streamed: false
        }
      });
    });

    sendResponse({
      success: true,
      data: {
        ...answer,
        streamed: true,
        streamId
      }
    });

    // Ensure other parts of the extension receive the final answer payload
    broadcastToSidepanel({
      type: 'QUESTION_ANSWERED',
      data: {
        ...answer,
        streamed: true,
        streamId
      }
    });
  } catch (error) {
    console.error('Error answering question:', error);
    broadcastToSidepanel({
      type: 'CHAT_STREAM_ERROR',
      data: {
        message: 'Unable to answer that question right now.'
      }
    });
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Generate recommendation based on Buy Score
 */
function generateRecommendation(buyScore) {
  const score =
    typeof buyScore === 'number'
      ? buyScore
      : typeof buyScore === 'object' && buyScore !== null && typeof buyScore.total === 'number'
        ? buyScore.total
        : null;

  if (score === null) {
    return {
      verdict: 'Score Unavailable',
      color: '#6b7280',
      message: 'Not enough data yet to generate a Buy Score verdict'
    };
  }

  if (score >= 8) {
    return {
      verdict: 'Strong Buy',
      color: '#22c55e',
      message: 'Excellent value with strong ratings and fair price'
    };
  } else if (score >= 6) {
    return {
      verdict: 'Good Buy',
      color: '#3b82f6',
      message: 'Good value, minor concerns to consider'
    };
  } else if (score >= 4) {
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


function generateId(prefix = 'evt') {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function streamAnswerToSidepanel(streamId, answerPayload) {
  const fullAnswer = answerPayload?.answer || '';
  const source = answerPayload?.source || null;
  const search = answerPayload?.search || null;

  broadcastToSidepanel({
    type: 'CHAT_STREAM_START',
    data: {
      streamId,
      source,
      search
    }
  });

  const chunks = chunkTextForStream(fullAnswer);

  if (chunks.length === 0) {
    broadcastToSidepanel({
      type: 'CHAT_STREAM_END',
      data: {
        streamId,
        fullAnswer,
        source,
        search
      }
    });
    return;
  }

  for (const chunk of chunks) {
    broadcastToSidepanel({
      type: 'CHAT_STREAM_CHUNK',
      data: {
        streamId,
        chunk
      }
    });
    await delay(45 + Math.floor(Math.random() * 60));
  }

  broadcastToSidepanel({
    type: 'CHAT_STREAM_END',
    data: {
      streamId,
      fullAnswer,
      source,
      search
    }
  });
}

function chunkTextForStream(text, chunkSize = 55) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const chunks = [];

  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  pendingAnalyses.clear();
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
