/**
 * Claude API Integration Module
 *
 * Handles all interactions with Anthropic's Claude API
 * Uses Haiku for fast analysis and Sonnet for complex Q&A
 */

// Import config at the top level
import { CLAUDE_API_KEY as IMPORTED_API_KEY } from '../../config.local.js';

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
   * Analyze product specifications for contradictions
   */
  static async analyzeSpecs(productData) {
    const prompt = `You are a product specification analyzer. Analyze the following product data and identify any contradictions, inconsistencies, or red flags in the specifications.

Product: ${productData.title}

Specifications:
${JSON.stringify(productData.specs, null, 2)}

Product Bullets:
${productData.bullets?.join('\n') || 'N/A'}

Description:
${productData.description || 'N/A'}

Return your analysis as a JSON object with this exact structure:
{
  "conflicts": ["array of specific conflicts or contradictions found"],
  "redFlags": ["array of red flags or concerns"],
  "hasNewerModel": false,
  "confidence": 0.95
}

If no conflicts are found, return an empty conflicts array. Be specific and cite what contradicts what.`;

    return await this.callClaude(prompt, HAIKU_MODEL, { conflicts: [], redFlags: [], hasNewerModel: false, confidence: 1.0 });
  }

  /**
   * Analyze review sentiment with mode-specific focus
   */
  static async analyzeSentiment(productData, mode) {
    const focusArea = this.getFocusAreaForMode(mode);

    const reviewText = productData.reviews
      ?.slice(0, 10)
      .map(r => `${r.rating}/5 - ${r.title}: ${r.body}`)
      .join('\n\n') || 'No reviews available';

    const prompt = `You are a product review analyzer. Analyze these reviews and extract key pros and cons, focusing on: ${focusArea}

Product: ${productData.title}

Reviews:
${reviewText}

Return your analysis as a JSON object with this exact structure:
{
  "pros": ["array of 3-5 key positive points from reviews"],
  "cons": ["array of 3-5 key negative points or concerns from reviews"],
  "confidence": 0.95
}

Focus specifically on: ${focusArea}. Extract real insights from the reviews, not generic statements.`;

    return await this.callClaude(prompt, HAIKU_MODEL, { pros: [], cons: [], confidence: 1.0 });
  }

  /**
   * Analyze beauty products (ingredients, skin type, etc.)
   */
  static async analyzeBeautyProduct(productData) {
    const prompt = `You are a beauty product expert. Analyze this product for skin type compatibility and potential irritants.

Product: ${productData.title}

Specifications:
${JSON.stringify(productData.specs, null, 2)}

Ingredients (if listed):
${productData.description || 'Not specified'}

Reviews (sample):
${productData.reviews?.slice(0, 5).map(r => r.body).join('\n\n') || 'No reviews'}

Return your analysis as a JSON object:
{
  "summary": "Brief 2-3 sentence overview of the product for different skin types",
  "suitableFor": ["array of skin types this works well for"],
  "concerns": ["array of potential irritants or concerns"],
  "pros": ["key benefits mentioned in reviews"],
  "cons": ["common complaints"],
  "confidence": 0.95
}`;

    return await this.callClaude(prompt, HAIKU_MODEL, {
      summary: 'Analysis in progress...',
      suitableFor: [],
      concerns: [],
      pros: [],
      cons: [],
      confidence: 1.0
    });
  }

  /**
   * Answer user questions with grounded context (RAG-style)
   */
  static async answerQuestion(question, productContext) {
    // Extract relevant snippets from product data
    const context = this.extractRelevantContext(question, productContext);

    const prompt = `You are a helpful shopping assistant. Answer the user's question ONLY based on the provided product information. If the information is not in the context, say so.

Product: ${productContext.title}

Context:
${context}

User Question: ${question}

Provide a concise, direct answer based ONLY on the information above. If you cite specific information, note which section it came from (e.g., "According to the product description..." or "Based on the reviews...").

Return your response as JSON:
{
  "answer": "Your answer here",
  "source": "CSS selector or section name where the info came from (e.g., '#productDescription' or null)",
  "confidence": 0.95
}`;

    return await this.callClaude(prompt, SONNET_MODEL, {
      answer: 'I could not find that information in the product details.',
      source: null,
      confidence: 0.5
    });
  }

  /**
   * Extract relevant context for Q&A
   */
  static extractRelevantContext(question, productData) {
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
