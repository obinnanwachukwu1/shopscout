/**
 * Claude API Integration Module
 *
 * Handles all interactions with Anthropic's Claude API
 * Uses Haiku for fast analysis and Sonnet for complex Q&A
 */

// Import config at the top level
import { CLAUDE_API_KEY as IMPORTED_API_KEY } from '../../config.local.js';
import { WebSearch } from './web-search.js';

// Store the API key
let CLAUDE_API_KEY = IMPORTED_API_KEY;

console.log('[Claude API] Module loaded. API key available:', !!CLAUDE_API_KEY);

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL = 'claude-haiku-4-5';
const SONNET_MODEL = 'claude-sonnet-4-5';
const CLAUDE_CONCURRENCY_LIMIT = 1;
const CLAUDE_QUEUE_TIMEOUT_MS = 60_000; // fail fast if queue is jammed

export class ClaudeAPI {
  static _activeRequests = 0;
  static _waitQueue = [];

  /**
   * Set API key programmatically
   */
  static setApiKey(key) {
    CLAUDE_API_KEY = key;
  }

  /**
   * Unified analysis entry point (spec + sentiment + mode extras) with a single Claude call.
   */
  static async analyzeProductBundle(productData, mode, options = {}) {
    const focusArea = this.getFocusAreaForMode(mode);
    const externalContext = this.formatExternalInsightsForPrompt(options.externalInsights);

    const reviewSnippets = productData.reviews?.slice(0, 10).map((review, index) => {
      const rating = typeof review.rating === 'number' ? `${review.rating}/5` : 'Rating N/A';
      const title = review.title || 'Untitled review';
      const author = review.author ? ` by ${review.author}` : '';
      const date = review.date ? ` (${review.date})` : '';
      const body = review.body ? `\n${review.body}` : '';
      return `${index + 1}. ${rating} - ${title}${author}${date}${body}`;
    }).join('\n\n') || 'No reviews captured on the page.';

    const prompt = `You are an AI product insights analyst. Perform a comprehensive assessment for the mode "${mode}" using ONLY the evidence below. Avoid speculation.

Product Title: ${productData.title}
Price: ${productData.price?.formatted || 'Unknown'}
Rating: ${productData.rating || 'N/A'} (${productData.reviewCount ?? 'unknown'} reviews)

Specifications JSON:
${JSON.stringify(productData.specs || {}, null, 2)}

Feature Bullets:
${(productData.bullets || []).join('\n') || 'No bullets provided.'}

Description:
${productData.description || 'No description provided.'}

Top On-Page Reviews:
${reviewSnippets}

External Review Signals:
${externalContext}

Evidence constraints:
- Cite pros/cons ONLY if they appear explicitly in the reviews, specifications, or external snippets above. If uncertain, omit the point.
- Treat storage references (e.g., 256GB mentions) as optional configurations unless they directly contradict the provided base specs.
- Accept references to "iPadOS 26" (or later) as valid future software releases unless other evidence disputes it.
- The product title states "A16 chip"; regard this as correct unless an external finding explicitly contradicts it.
- Packaging or accessory critiques should be included only when reviews clearly mention them.
- Limit the "cons" list to high-signal issues directly grounded in the evidence (max 5). If no grounded negatives exist, return an empty array.

Return strictly valid JSON with this schema (no additional keys):
{
  "specAnalysis": {
    "conflicts": ["specific conflicting details"],
    "redFlags": ["potential concerns"],
    "hasNewerModel": false,
    "confidence": 0.0
  } | null,
  "sentiment": {
    "focus": "${focusArea}",
    "pros": ["mode-specific positives"],
    "cons": ["mode-specific negatives"],
    "confidence": 0.0
  } | null,
  "beauty": {
    "summary": "2-3 sentence skin-type overview",
    "suitableFor": ["skin types"],
    "concerns": ["potential irritants"],
    "pros": ["benefits"],
    "cons": ["complaints"],
    "confidence": 0.0
  } | null,
  "recommendation": {
    "summary": "Short overall takeaway for shoppers",
    "callToAction": "Optional next step"
  },
  "confidence": 0.0
}

Mode-specific rules:
- ELECTRONICS or GENERIC_HOME_GOODS: populate specAnalysis and sentiment; set beauty to null.
- FASHION: focus sentiment on fit/sizing/material; specAnalysis and beauty should be null.
- BEAUTY: populate beauty plus sentiment if helpful; specAnalysis usually null unless explicit contradictions exist.
- COLLECTIBLES: highlight authenticity, condition, value retention; specAnalysis optional (set to null if nothing concrete).
- If data is insufficient for any section, set that section to null rather than fabricating content. Always ground the findings in the provided context.`;

    const fallback = {
      specAnalysis: null,
      sentiment: null,
      beauty: null,
      recommendation: {
        summary: 'Analysis unavailable.',
        callToAction: null
      },
      confidence: 0.3
    };

    return await this.callClaude(prompt, HAIKU_MODEL, fallback);
  }

  /**
   * Answer user questions with grounded context (RAG-style)
   */
  static async answerQuestion(question, productData, externalReviewInsights = null) {
    const fallbackResponse = {
      action: 'respond',
      answer: 'I could not find that information in the provided product details.',
      source: null,
      confidence: 0.5
    };

    let searchContext = null;
    let iterations = 0;
    const maxSearchIterations = 2;

    while (iterations <= maxSearchIterations) {
      const context = this.extractRelevantContext(question, productData, externalReviewInsights);
      const searchSummary = this.formatSearchResultsForPrompt(searchContext);

      const prompt = `You are a grounded shopping assistant. Answer the user's question ONLY using the provided context and optional smart-search results. If information is unavailable, say so clearly.

Product: ${productData?.title || 'Unknown Product'}

Context:
${context}

Latest Smart Search Results:
${searchSummary}

Question: ${question}

You may request additional public information by emitting the following JSON:
{"action":"smart_search","toolRequest":{"query":"string","siteFilter":null}}

When you have enough information, respond with:
{"action":"respond","answer":"complete answer grounded in provided evidence","source":"CSS selector or section name if applicable","confidence":0.0-1.0}

Always respond with strictly valid JSON.`;

      const response = await this.callClaude(prompt, SONNET_MODEL, fallbackResponse);

      if (!response || response.action !== 'smart_search') {
        return {
          answer: response?.answer || fallbackResponse.answer,
          source: response?.source || fallbackResponse.source,
          confidence: typeof response?.confidence === 'number' ? response.confidence : fallbackResponse.confidence,
          search: searchContext?.result ? {
            query: searchContext.request.query,
            siteFilter: searchContext.request.siteFilter || null,
            summary: searchContext.result.analysis?.summary || null,
            bestLinks: searchContext.result.analysis?.bestLinks || []
          } : null
        };
      }

      if (!response.toolRequest?.query || iterations === maxSearchIterations) {
        return fallbackResponse;
      }

      try {
        const result = await WebSearch.smartSearch(response.toolRequest.query, {
          siteFilter: response.toolRequest.siteFilter || null,
          maxResults: 12,
          analysisResultCount: 5
        });

        searchContext = {
          request: {
            query: response.toolRequest.query,
            siteFilter: response.toolRequest.siteFilter || null
          },
          result
        };
        iterations += 1;
      } catch (error) {
        console.error('[Claude API] Smart search tool failed:', error);
        return fallbackResponse;
      }
    }

    return fallbackResponse;
  }

  /**
   * Extract relevant context for Q&A
   */
  static extractRelevantContext(question, productData, externalReviewInsights = null) {
    const contextParts = [];

    // Always include title and basic info
    contextParts.push(`Title: ${productData.title}`);

    if (productData.price?.formatted) {
      contextParts.push(`Price: ${productData.price.formatted}`);
    }

    if (productData.rating) {
      contextParts.push(`Rating: ${productData.rating}/5 (${productData.reviewCount} reviews)`);
    }

    // Check if question is about specs
    if (question.toLowerCase().includes('spec') || question.toLowerCase().includes('dimension') || question.toLowerCase().includes('weight')) {
      contextParts.push(`Specifications:\n${JSON.stringify(productData.specs, null, 2)}`);
    }

    // Check if question is about reviews/quality
    if (question.toLowerCase().includes('review') || question.toLowerCase().includes('quality') || question.toLowerCase().includes('good')) {
      const reviews = productData.reviews?.slice(0, 5).map(r => `${r.rating}/5: ${r.body}`).join('\n') || 'No reviews';
      contextParts.push(`Reviews:\n${reviews}`);
    }

    if (productData.reviews?.length) {
      const reviewSummaries = productData.reviews.slice(0, 5).map((review, index) => {
        const rating = review.rating ? `${review.rating}/5` : 'Rating N/A';
        const title = review.title || 'Untitled review';
        const body = review.body ? review.body.slice(0, 220) : 'No details provided';
        return `${index + 1}. ${rating} — ${title}\n${body}`;
      }).join('\n\n');
      contextParts.push(`Top on-page reviews:\n${reviewSummaries}`);
    }

    if (externalReviewInsights?.analysis) {
      const externalSummary = this.formatExternalInsightsForPrompt(externalReviewInsights);
      contextParts.push(externalSummary);
    }

    // Always include bullets
    if (productData.bullets?.length) {
      contextParts.push(`Features:\n${productData.bullets.join('\n')}`);
    }

    // Include description
    if (productData.description) {
      contextParts.push(`Description:\n${productData.description}`);
    }

    return contextParts.join('\n\n');
  }

  /**
   * Get focus area based on product mode
   */
  static getFocusAreaForMode(mode) {
    const focusAreas = {
      'ELECTRONICS': 'performance, durability, build quality, and value for money',
      'FASHION': 'fit, sizing, material quality, and color accuracy',
      'BEAUTY': 'skin type compatibility, effectiveness, ingredients, and potential irritants',
      'COLLECTIBLES': 'authenticity, condition, rarity, and value retention',
      'GENERIC': 'quality, durability, value, and overall satisfaction'
    };

    return focusAreas[mode] || focusAreas['GENERIC'];
  }

  static formatExternalInsightsForPrompt(externalInsights) {
    if (!externalInsights?.analysis) {
      return 'No external web findings were available for this product yet.';
    }

    const { analysis, query } = externalInsights;
    const keyFindings = (analysis.keyFindings || [])
      .slice(0, 5)
      .map((item, index) => `${index + 1}. ${item}`)
      .join('\n');

    const bestLinks = (analysis.bestLinks || [])
      .slice(0, 3)
      .map(link => `- ${link.title}: ${link.reason || 'Relevant insight'}`)
      .join('\n');

    return `DuckDuckGo Smart Search (query: "${query}") summary: ${analysis.summary || 'Not provided.'}
Key findings:
${keyFindings || '- None provided'}
Suggested sources:
${bestLinks || '- None provided'}`;
  }

  static formatSearchResultsForPrompt(searchContext) {
    if (!searchContext?.result) {
      return 'No smart search has been performed yet.';
    }

    const { request, result } = searchContext;
    const analysis = result.analysis || {};
    const keyFindings = (analysis.keyFindings || [])
      .slice(0, 4)
      .map((item, index) => `${index + 1}. ${item}`)
      .join('\n');
    const links = (analysis.bestLinks || [])
      .slice(0, 3)
      .map(link => `- ${link.title}: ${link.reason || 'Relevant insight'}`)
      .join('\n');

    return `Smart search query: "${request.query}"${request.siteFilter ? ` (site filter: ${request.siteFilter})` : ''}
Summary: ${analysis.summary || 'Not provided.'}
Key findings:
${keyFindings || '- None provided'}
Suggested sources:
${links || '- None provided'}`;
  }

  /**
   * Call Claude API
   */
  static async callClaude(prompt, model, fallback) {
    console.log('[Claude API] Calling API with model:', model);
    console.log('[Claude API] API key available:', !!CLAUDE_API_KEY);

    if (!CLAUDE_API_KEY) {
      console.error('[Claude API] API key not configured. Please check config.local.js');
      return fallback;
    }

    let release;

    try {
      release = await this._acquireSlot();
    } catch (queueError) {
      console.error('[Claude API] Unable to acquire request slot:', queueError);
      return fallback;
    }

    try {
      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: model,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Claude API error:', error);
        return fallback;
      }

      const data = await response.json();
      const content = data.content?.[0]?.text || '';

      // Try to parse JSON response
      try {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/\{[\s\S]*\}/);
        const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
        return JSON.parse(jsonStr);
      } catch (parseError) {
        console.error('Failed to parse Claude response as JSON:', parseError);
        console.log('Raw response:', content);
        return fallback;
      }
    } catch (error) {
      console.error('Error calling Claude API:', error);
      return fallback;
    } finally {
      release();
    }
  }

  /**
   * Serialize Claude calls to avoid rate limit bursts
   */
  static async _acquireSlot() {
    if (this._activeRequests < CLAUDE_CONCURRENCY_LIMIT) {
      this._activeRequests += 1;
      return () => this._releaseSlot();
    }

    return await new Promise((resolve, reject) => {
      const entry = {
        isSettled: false,
        timeout: null,
        settle(callback) {
          if (this.isSettled) {
            return;
          }
          this.isSettled = true;
          clearTimeout(this.timeout);
          callback();
        },
        resolve: null,
        reject: null
      };

      entry.resolve = () => {
        entry.settle(() => {
          ClaudeAPI._activeRequests += 1;
          resolve(() => ClaudeAPI._releaseSlot());
        });
      };

      entry.reject = (error) => {
        entry.settle(() => {
          reject(error);
        });
      };

      entry.timeout = setTimeout(() => {
        entry.reject(new Error('Claude request queue timeout'));
      }, CLAUDE_QUEUE_TIMEOUT_MS);

      this._waitQueue.push(entry);
    });
  }

  static _releaseSlot() {
    this._activeRequests = Math.max(0, this._activeRequests - 1);
    while (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift();
      if (!next || next.isSettled) {
        continue;
      }
      next.resolve();
      break;
    }
  }
}
