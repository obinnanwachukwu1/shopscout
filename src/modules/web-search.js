import { ClaudeAPI } from './claude-api.js';

const ANALYSIS_HTML_MAX_LENGTH = 60000;
const RAG_CHUNK_SIZE = 1200; // Increased for better context
const RAG_CHUNK_OVERLAP = 200; // More overlap to preserve context
const RAG_MAX_CHUNKS_PER_RESULT = 4; // Get more top chunks
const RAG_CHUNK_PROMPT_LIMIT = 900; // Allow more text per chunk
const RAG_MIN_SCORE = 0.15; // Higher threshold to filter noise
const RAG_FALLBACK_PROMPT_LIMIT = 2000;
const LOCAL_SEARCH_PROXY_URL = 'http://127.0.0.1:9000/fetch?render=browser&url=';
const isNodeEnvironment = typeof process !== 'undefined' && !!process.versions?.node;
const WEB_SEARCH_WORKER_PATH = new URL('./web-search-worker.js', import.meta.url);
let webSearchWorkerPoolPromise = null;
let webSearchWorkerShutdownHookRegistered = false;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'about', 'near',
  'best', 'type', 'what', 'does', 'will', 'when', 'have', 'has', 'are', 'was', 'were', 'can',
  'where', 'which', 'does', 'its', 'than', 'also', 'more', 'info', 'information', 'overview',
  'guide', 'latest', 'news', 'review', 'reviews'
]);

const PRICE_KEYWORDS = new Set([
  'price', 'prices', 'pricing', 'cost', 'value', 'worth', 'sale', 'deals', 'deal',
  'offer', 'offers', 'refurbished', 'used', 'market', 'listing', 'listings'
]);

/**
 * Web Search Module
 *
 * General-purpose DuckDuckGo search functionality
 * Can be used by AI agents for research and information gathering
 */

export class WebSearch {
  /**
   * Search DuckDuckGo for general queries
   * Returns search results with titles, snippets, and URLs
   */
  static async searchDuckDuckGo(query, options = {}) {
    const {
      maxResults = 10,
      siteFilter = null, // Optional: 'amazon.com', 'ebay.com', etc.
    } = options;

    try {
      // Build search query
      let searchQuery = query;
      if (siteFilter) {
        searchQuery = `${query} site:${siteFilter}`;
      }

      const encodedQuery = encodeURIComponent(searchQuery);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      console.log('[WebSearch] DuckDuckGo search:', {
        query: searchQuery,
        url: searchUrl
      });

      const response = await fetch(searchUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) {
        console.error('[WebSearch] DuckDuckGo search failed:', response.status);
        return { results: [], success: false };
      }

      const html = await response.text();
      console.log('[WebSearch] Response HTML length:', html.length);

      // Extract search results
      const results = this.parseSearchResults(html, maxResults);
      console.log('[WebSearch] Extracted results:', results.length);

      return {
        results,
        success: true,
        query: searchQuery
      };
    } catch (error) {
      console.error('[WebSearch] Error:', error);
      return { results: [], success: false, error: error.message };
    }
  }

  /**
   * Perform a smart search that summarizes results with Claude Haiku
   */
  static async smartSearch(query, options = {}) {
    const {
      maxResults = 10,
      siteFilter = null,
      analysisResultCount = 5,
      useClaude = true
    } = options;

    const searchResponse = await this.searchDuckDuckGo(query, { maxResults, siteFilter });
    const analyzedResults = (searchResponse.results || []).slice(0, analysisResultCount);

    if (!searchResponse.success || analyzedResults.length === 0) {
      const summaryMessage = !searchResponse.success
        ? `Search failed: ${searchResponse.error || 'Unknown error'}.`
        : 'No DuckDuckGo results were found to analyze.';

      return {
        ...searchResponse,
        analysis: this.normalizeSmartAnalysis(
          this.buildFallbackAnalysis(analyzedResults, summaryMessage),
          analyzedResults
        ),
        analyzedResults
      };
    }

    await this.populateAnalysisHtml(analyzedResults, analysisResultCount, ANALYSIS_HTML_MAX_LENGTH, query);

    const fallbackAnalysis = this.buildFallbackAnalysis(analyzedResults);
    const prompt = this.buildAnalysisPrompt(query, analyzedResults);

    if (!useClaude) {
      return {
        ...searchResponse,
        analysis: this.normalizeSmartAnalysis(fallbackAnalysis, analyzedResults),
        analyzedResults
      };
    }

    const haikuAnalysis = await ClaudeAPI.callClaude(
      prompt,
      'claude-haiku-4-5',
      fallbackAnalysis
    );

    const analysis = this.normalizeSmartAnalysis(haikuAnalysis, analyzedResults);
    this.applyAnalysisSnippets(analyzedResults, analysis);
    await this.fillSnippetsFromPages(analyzedResults);

    console.log('[WebSearch] Smart search output:', {
      query,
      analysis,
      analyzedResults: analyzedResults.map(result => ({
        title: result.title,
        url: result.url,
        snippetPreview: result.snippet ? `${result.snippet.slice(0, 200)}${result.snippet.length > 200 ? '…' : ''}` : null,
        snippetLength: result.snippet ? result.snippet.length : 0,
        ragChunks: Array.isArray(result.ragChunks) ? result.ragChunks.length : 0,
        ragTopScore: Array.isArray(result.ragChunks) && result.ragChunks[0] ? result.ragChunks[0].score : null
      }))
    });

    return {
      ...searchResponse,
      analysis,
      analyzedResults
    };
  }

  /**
   * Parse DuckDuckGo HTML to extract search results
   */
  static parseSearchResults(html, maxResults) {
    const results = [];

    try {
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const nodeList = doc.querySelectorAll('.result');

        nodeList.forEach(node => {
          if (results.length >= maxResults) {
            return;
          }

          const titleAnchor = node.querySelector('a.result__a');
          if (!titleAnchor || !titleAnchor.textContent) {
            return;
          }

          const snippetNode = node.querySelector('.result__snippet');
          const urlNode = node.querySelector('.result__url');

          const rawUrl = titleAnchor.getAttribute('href') || urlNode?.getAttribute('href');
          const decodedUrl = rawUrl ? this.decodeUrl(rawUrl) : null;

          if (!decodedUrl) {
            return;
          }

          results.push({
            title: this.cleanText(titleAnchor.textContent),
            url: decodedUrl,
            snippet: snippetNode ? this.cleanText(snippetNode.textContent) : null
          });
        });
      }

      // Pattern 1: Extract result blocks with class="result" (legacy fallback)
      if (results.length === 0) {
        const resultBlockPattern = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
        let match;

        while ((match = resultBlockPattern.exec(html)) !== null && results.length < maxResults) {
          const block = match[1];

          const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
          const title = titleMatch ? this.cleanText(titleMatch[1]) : null;

          const urlMatch = block.match(/class="result__url"[^>]*href="([^"]+)"/);
          const url = urlMatch ? this.decodeUrl(urlMatch[1]) : null;

        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        const snippet = snippetMatch ? this.cleanText(this.stripHtml(snippetMatch[1])) : null;

          if (title && url) {
            results.push({ title, url, snippet });
          }
        }
      }

      // Pattern 2: Fallback - look for uddg links
      if (results.length === 0) {
        const uddgPattern = /uddg=([^"&]+)/g;
        const titlePattern = /<a[^>]*class="result__a"[^>]*>([^<]+)</g;

        const urls = [];
        while ((match = uddgPattern.exec(html)) !== null && urls.length < maxResults) {
          try {
            const decodedUrl = decodeURIComponent(match[1]);
            urls.push(decodedUrl);
          } catch (e) {
            // Skip invalid URLs
          }
        }

        const titles = [];
        while ((match = titlePattern.exec(html)) !== null && titles.length < maxResults) {
          titles.push(this.cleanText(match[1]));
        }

        // Combine URLs and titles
        for (let i = 0; i < Math.min(urls.length, titles.length); i++) {
          results.push({
            title: titles[i],
            url: urls[i],
            snippet: null
          });
        }
      }

      console.log('[WebSearch] Parsed results:', results);
    } catch (error) {
      console.error('[WebSearch] Error parsing results:', error);
    }

    return results;
  }

  /**
   * Decode DuckDuckGo URL
   */
  static decodeUrl(url) {
    try {
      // Remove DuckDuckGo redirect wrapper
      if (url.includes('uddg=')) {
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          return decodeURIComponent(uddgMatch[1]);
        }
      }
      return url;
    } catch (e) {
      return url;
    }
  }

  /**
   * Clean HTML entities and whitespace from text
   */
  static cleanText(text) {
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

  static stripHtml(html) {
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

  /**
   * Build Claude prompt for analyzing search results
   */
  static buildAnalysisPrompt(query, results) {
    const globalPreamble = typeof ClaudeAPI.getGlobalSystemPreamble === 'function'
      ? ClaudeAPI.getGlobalSystemPreamble()
      : null;

    const formattedResults = results
      .map((result, index) => {
        const ragContext = Array.isArray(result.ragChunks) && result.ragChunks.length
          ? result.ragChunks
              .map((chunk, chunkIndex) => {
                const scoreLabel = typeof chunk.score === 'number'
                  ? chunk.score.toFixed(2)
                  : (chunk.score || null);
                const coverageLabel = typeof chunk.coverage === 'number' && chunk.coverage > 0
                  ? `${Math.round(chunk.coverage * 100)}%`
                  : null;
                const meta = [scoreLabel ? `score ${scoreLabel}` : null, coverageLabel ? `coverage ${coverageLabel}` : null]
                  .filter(Boolean)
                  .join(', ');
                const heading = `Segment ${chunk.order ?? chunkIndex + 1}${meta ? ` (${meta})` : ''}`;
                const body = (chunk.promptText || chunk.text || chunk.content || '').trim();
                return `${heading}:\n${body}`;
              })
              .join('\n---\n')
          : null;

        const plainTextContext = typeof result.analysisPlainText === 'string'
          ? (() => {
              const trimmed = result.analysisPlainText.trim();
              if (!trimmed) {
                return null;
              }
              return trimmed.length > RAG_FALLBACK_PROMPT_LIMIT
                ? `${trimmed.slice(0, RAG_FALLBACK_PROMPT_LIMIT)}…`
                : trimmed;
            })()
          : null;

        const snippet = result.snippet
          ? result.snippet.replace(/\s+/g, ' ').trim()
          : 'No snippet provided.';
        const label = ragContext
          ? `Top page segments (${result.ragChunks.length} chunk${result.ragChunks.length === 1 ? '' : 's'})`
          : plainTextContext
            ? `Page text summary (${plainTextContext.length} characters)`
            : 'Snippet';
        const content = ragContext || plainTextContext || snippet;

        return `${index + 1}. Title: ${result.title}\n   URL: ${result.url}\n   ${label}:\n"""${content}"""`;
      })
      .join('\n\n');

    const preamble = globalPreamble ? `${globalPreamble}\n\n` : '';

    return `${preamble}You are a fast research assistant helping a shopping extension answer the user's research query.\n` +
      `Identify the primary intent of the query (e.g., price, availability, color options, specs, reviews, authenticity) and surface the most relevant facts for that intent.\n` +
      `Many results include extracted text segments from the page. Use them to pull concrete facts such as prices, configuration details, availability windows, review sentiments, and release dates. Avoid quoting markup or CSS tokens.\n` +
      `Deliver a thorough, grounded synthesis: write a 4-6 sentence summary that compares the strongest data points, explicitly citing price ranges, timeframes, model identifiers, and retailer context when available.\n` +
      `Ensure each key finding is a complete sentence anchored to a specific source segment, and include at least four findings when the evidence supports it. Highlight differences (e.g., chip generation, storage SKUs) rather than repeating the same fact.\n` +
      `Only state that information is missing when none of the results provide a credible signal after reasonable inference.\n\n` +
      `Search Query: ${query}\n\n` +
      `DuckDuckGo Results:\n${formattedResults}\n\n` +
      `Reply strictly as JSON with this exact schema:\n` +
      `{\n` +
      `  "summary": "4-6 sentence factual overview that directly answers the query, highlighting the most relevant concrete details (prices, colors, specs, dates, availability, retailer context).",\n` +
      `  "keyFindings": ["succinct bullet findings grounded in the provided segments with the most pertinent facts for this query; include at least four when possible"],\n` +
      `  "bestLinks": [{"title": "Result title", "url": "https://example.com", "reason": "Specific evidence from this link that helps answer the query"}],\n` +
      `  "missingInfo": "What the snippets do not cover or what needs further research",\n` +
      `  "confidence": 0.0\n` +
      `}\n` +
      `Use only the data provided above. Do not fabricate URLs or claims.`;
  }

  /**
   * Build fallback analysis in case Claude is unavailable
   */
  static buildFallbackAnalysis(results, summaryOverride = null) {
    const summary = summaryOverride ||
      (results.length > 0
        ? 'Automatic analysis unavailable. Review the key findings below.'
        : 'No DuckDuckGo results were found to analyze.');

    const keyFindings = results.slice(0, 5).map(result => {
      const snippet = result.snippet
        ? result.snippet.replace(/\s+/g, ' ').trim()
        : 'No snippet provided.';
      return `${result.title} — ${snippet}`;
    });

    const bestLinks = results.slice(0, Math.min(3, results.length)).map(result => ({
      title: result.title,
      url: result.url,
      reason: result.snippet
        ? `Snippet suggests relevance: ${result.snippet.replace(/\s+/g, ' ').trim()}`
        : 'Top DuckDuckGo result'
    }));

    return {
      summary,
      keyFindings,
      bestLinks,
      missingInfo: 'Need manual review of the search results to gather more details.',
      confidence: results.length > 0 ? 0.2 : 0.0
    };
  }

  /**
   * Normalize Claude analysis to ensure consistent shape
   */
  static normalizeSmartAnalysis(analysis, results) {
    const normalized = {
      summary: typeof analysis?.summary === 'string' && analysis.summary.trim()
        ? analysis.summary.trim()
        : 'Automatic analysis unavailable. Review the top results manually.',
      keyFindings: Array.isArray(analysis?.keyFindings)
        ? analysis.keyFindings
            .map(item => (typeof item === 'string' ? item.trim() : null))
            .filter(Boolean)
        : [],
      bestLinks: Array.isArray(analysis?.bestLinks)
        ? analysis.bestLinks
            .map(link => ({
              title: typeof link?.title === 'string' ? link.title.trim() : null,
              url: typeof link?.url === 'string' ? link.url.trim() : null,
              reason: typeof link?.reason === 'string' ? link.reason.trim() : null
            }))
            .filter(link => link.title && link.url)
        : [],
      missingInfo: typeof analysis?.missingInfo === 'string' && analysis.missingInfo.trim()
        ? analysis.missingInfo.trim()
        : 'Not specified.',
      confidence: typeof analysis?.confidence === 'number'
        ? Math.min(1, Math.max(0, analysis.confidence))
        : 0.3
    };

    if (normalized.keyFindings.length === 0 && results.length > 0) {
      normalized.keyFindings = results.slice(0, 5).map(result => {
        const snippet = result.snippet
          ? result.snippet.replace(/\s+/g, ' ').trim()
          : 'No snippet provided.';
        return `${result.title} — ${snippet}`;
      });
    }

    if (normalized.bestLinks.length === 0 && results.length > 0) {
      normalized.bestLinks = results.slice(0, Math.min(3, results.length)).map(result => ({
        title: result.title,
        url: result.url,
        reason: result.snippet
          ? `Snippet suggests relevance: ${result.snippet.replace(/\s+/g, ' ').trim()}`
          : 'Top DuckDuckGo result'
      }));
    }

    return normalized;
  }

  /**
   * Extract URLs only (for price comparison use case)
   */
  static async extractUrls(query, siteFilter, maxResults = 10) {
    const searchResults = await this.searchDuckDuckGo(query, { siteFilter, maxResults });

    if (!searchResults.success) {
      return [];
    }

    return searchResults.results.map(r => r.url).filter(Boolean);
  }

  /**
   * Search with multiple patterns for more robust extraction
   */
  static async searchWithFallback(query, siteFilter = null) {
    console.log('[WebSearch] Searching with fallback patterns');

    const results = await this.searchDuckDuckGo(query, { siteFilter, maxResults: 10 });

    if (results.success && results.results.length > 0) {
      return results;
    }

    // If no results, log the HTML preview for debugging
    console.log('[WebSearch] No results found, may need to adjust parsing patterns');

    return results;
  }

  static async populateAnalysisHtml(results, maxFetches = 5, maxChars = ANALYSIS_HTML_MAX_LENGTH, query = '') {
    if (!Array.isArray(results) || !results.length || maxFetches <= 0) {
      return;
    }

    const tasks = [];

    for (const result of results) {
      if (!result || result.analysisHtml || !result.url || !/^https?:/i.test(result.url)) {
        continue;
      }
      if (tasks.length >= maxFetches) {
        break;
      }

      tasks.push(
        this.fetchPageHtml(result.url, maxChars)
          .then(html => {
            if (!html) {
              return;
            }

            const truncatedHtml = html.length > maxChars ? html.slice(0, maxChars) : html;
            result.analysisHtml = truncatedHtml;

            const ragPayload = this.createPageRagPayload(query, truncatedHtml, {
              chunkSize: RAG_CHUNK_SIZE,
              chunkOverlap: RAG_CHUNK_OVERLAP,
              maxChunks: RAG_MAX_CHUNKS_PER_RESULT
            });

            if (ragPayload) {
              result.ragChunks = ragPayload.ragChunks;
              result.analysisPlainText = ragPayload.plainText;
              if (!result.snippet && ragPayload.snippet) {
                result.snippet = ragPayload.snippet;
              }
            }

            if (!result.analysisPlainText) {
              const fallbackPlainText = this.extractPlainTextForRag(truncatedHtml);
              if (fallbackPlainText) {
                result.analysisPlainText = fallbackPlainText;
                if (!result.snippet) {
                  result.snippet = fallbackPlainText.slice(0, 500);
                }
              }
            }

            if (!result.snippet) {
              const cleanFallback = this.cleanText(this.stripHtml(truncatedHtml));
              if (cleanFallback) {
                result.snippet = cleanFallback.slice(0, 500);
              }
            }
          })
          .catch(error => {
            console.warn('[WebSearch] Page HTML fetch failed:', result.url, error);
          })
      );
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  static createPageRagPayload(query, html, options = {}) {
    if (!html || typeof html !== 'string') {
      return null;
    }

    const {
      chunkSize = RAG_CHUNK_SIZE,
      chunkOverlap = RAG_CHUNK_OVERLAP,
      maxChunks = RAG_MAX_CHUNKS_PER_RESULT
    } = options;

    const plainText = this.extractPlainTextForRag(html);
    if (!plainText) {
      return null;
    }

    const querySignals = this.computeQuerySignals(query, chunkSize);
    const rawChunks = this.chunkTextForRag(plainText, chunkSize, chunkOverlap);
    if (!rawChunks.length) {
      return {
        plainText,
        ragChunks: [],
        snippet: plainText.slice(0, 500)
      };
    }

    const scoredChunks = rawChunks
      .map((chunk, index) => {
        const sanitizedText = this.pruneCssNoiseFromText(chunk.content || '');
        if (!sanitizedText) {
          return null;
        }

        // Check content quality before scoring
        const qualityScore = this.assessContentQuality(sanitizedText);
        if (qualityScore < 0.3) {
          // Skip very low quality chunks (likely navigation/boilerplate)
          return null;
        }

        const scoreData = this.scoreChunkForRag(sanitizedText, querySignals);

        // Boost score based on content quality
        const adjustedScore = scoreData.score * qualityScore;

        return {
          index,
          text: sanitizedText,
          score: adjustedScore,
          coverage: scoreData.coverage,
          qualityScore
        };
      })
      .filter(Boolean)
      .filter(entry => this.hasReadableContent(entry.text))
      .filter(entry => entry.score >= RAG_MIN_SCORE || entry.index === 0);

    const sorted = scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = sorted
      .slice(0, maxChunks)
      .map((entry, order) => {
        // Smart truncation: try to preserve query-relevant content
        let promptText = entry.text;
        if (entry.text.length > RAG_CHUNK_PROMPT_LIMIT) {
          // Find the most relevant portion based on query term positions
          const relevantSegment = this.extractRelevantSegment(
            entry.text,
            querySignals,
            RAG_CHUNK_PROMPT_LIMIT
          );
          promptText = relevantSegment;
        } else {
          promptText = entry.text.trim();
        }

        return {
          order: order + 1,
          index: entry.index,
          score: Number.isFinite(entry.score) ? Number(entry.score.toFixed(3)) : entry.score,
          coverage: Number.isFinite(entry.coverage) ? Number(entry.coverage.toFixed(3)) : entry.coverage,
          text: entry.text,
          promptText
        };
      });

    // Log the selected chunks for debugging
    console.log('[RAG] Top chunks selected:', {
      query: query,
      totalChunks: rawChunks.length,
      scoredChunks: scoredChunks.length,
      selectedChunks: topChunks.length,
      chunks: topChunks.map(chunk => ({
        order: chunk.order,
        score: chunk.score,
        coverage: chunk.coverage,
        qualityScore: chunk.qualityScore,
        textPreview: chunk.text.slice(0, 200) + (chunk.text.length > 200 ? '...' : ''),
        promptTextPreview: chunk.promptText.slice(0, 200) + (chunk.promptText.length > 200 ? '...' : ''),
        fullTextLength: chunk.text.length,
        promptTextLength: chunk.promptText.length
      }))
    });

    // Create a better snippet that highlights query-relevant content
    const snippetSource = topChunks[0]?.text || plainText;
    const snippet = this.extractRelevantSegment(snippetSource, querySignals, 500);

    const limitedPlainText = plainText.length > ANALYSIS_HTML_MAX_LENGTH
      ? plainText.slice(0, ANALYSIS_HTML_MAX_LENGTH)
      : plainText;

    return {
      plainText: limitedPlainText,
      ragChunks: topChunks,
      snippet: snippet || snippetSource.slice(0, 500)
    };
  }

  static extractRelevantSegment(text, querySignals, maxLength) {
    if (!text || text.length <= maxLength) {
      return text.trim();
    }

    const textLower = text.toLowerCase();
    const sentences = text.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+(?:\n|$)/g) || [text];

    // Score each sentence by relevance
    const scoredSentences = sentences.map((sentence, idx) => {
      const sentenceLower = sentence.toLowerCase();
      let score = 0;
      let matchedTerms = 0;

      // Check for query term matches
      querySignals.tokens.forEach(token => {
        if (sentenceLower.includes(token)) {
          const weight = querySignals.termWeights?.get(token) || 1.0;
          score += weight;
          matchedTerms += 1;
        }
      });

      // Bonus for phrase matches
      querySignals.phrases.forEach(phrase => {
        if (sentenceLower.includes(phrase)) {
          score += phrase.split(' ').length === 3 ? 5 : 3;
        }
      });

      // Bonus for early sentences (often contain key info)
      if (idx < 3) {
        score += 1.5;
      }

      return { sentence, score, matchedTerms, idx };
    });

    // Sort by score and select best sentences
    const sorted = scoredSentences.sort((a, b) => b.score - a.score);

    // Build segment from top sentences, preserving order
    let segment = '';
    const includedIndices = new Set();
    const maxSentences = 5;

    for (let i = 0; i < Math.min(maxSentences, sorted.length); i++) {
      const candidate = sorted[i];
      if (candidate.score > 0) {
        includedIndices.add(candidate.idx);
      }
    }

    // Rebuild in original order for coherence
    for (let i = 0; i < sentences.length; i++) {
      if (includedIndices.has(i)) {
        const addition = segment ? ` ${sentences[i]}` : sentences[i];
        if ((segment + addition).length <= maxLength) {
          segment += addition;
        } else if (!segment) {
          // First sentence is too long, truncate it
          segment = sentences[i].slice(0, maxLength - 1) + '…';
          break;
        } else {
          break;
        }
      }
    }

    if (!segment && text.length > maxLength) {
      // Fallback: find first query match and extract context around it
      let firstMatchPos = -1;
      for (const token of querySignals.tokens) {
        const pos = textLower.indexOf(token);
        if (pos !== -1 && (firstMatchPos === -1 || pos < firstMatchPos)) {
          firstMatchPos = pos;
        }
      }

      if (firstMatchPos !== -1) {
        // Extract window around match
        const contextBefore = Math.floor(maxLength * 0.3);
        const contextAfter = maxLength - contextBefore;
        const start = Math.max(0, firstMatchPos - contextBefore);
        const end = Math.min(text.length, firstMatchPos + contextAfter);

        segment = text.slice(start, end).trim();
        if (start > 0) segment = '…' + segment;
        if (end < text.length) segment = segment + '…';
      } else {
        segment = text.slice(0, maxLength - 1) + '…';
      }
    }

    return segment.trim();
  }

  static computeQuerySignals(rawQuery, chunkTarget) {
    const query = (rawQuery || '').toString().toLowerCase();
    const tokens = this.tokenizeForRag(query).filter(token => !STOPWORDS.has(token));

    const dedupedTokens = [];
    const seen = new Set();
    tokens.forEach(token => {
      if (!seen.has(token)) {
        seen.add(token);
        dedupedTokens.push(token);
      }
    });

    // Build bigram and trigram phrases for better matching
    const phrases = [];
    for (let i = 0; i < dedupedTokens.length - 1; i += 1) {
      const bigram = `${dedupedTokens[i]} ${dedupedTokens[i + 1]}`;
      phrases.push(bigram);

      // Add trigrams for even better context matching
      if (i < dedupedTokens.length - 2) {
        const trigram = `${dedupedTokens[i]} ${dedupedTokens[i + 1]} ${dedupedTokens[i + 2]}`;
        phrases.push(trigram);
      }
    }

    const hasPriceIntent = dedupedTokens.some(token => PRICE_KEYWORDS.has(token));
    const numericTokens = dedupedTokens.filter(token => /\d/.test(token));

    // Identify important entity-like tokens (brands, models, capitalized terms)
    const entityTokens = dedupedTokens.filter(token =>
      /^[A-Z]/.test(token) || // Capitalized
      /\d/.test(token) || // Contains numbers (model numbers)
      token.length > 8 // Longer words often more specific
    );

    // Calculate term weights based on IDF-like scoring
    const termWeights = new Map();
    dedupedTokens.forEach(token => {
      let weight = 1.0;

      // Boost numeric tokens (model numbers, prices, specs)
      if (/\d/.test(token)) weight *= 2.5;

      // Boost longer, more specific terms
      if (token.length > 8) weight *= 1.8;
      else if (token.length > 6) weight *= 1.4;

      // Boost price-related terms
      if (PRICE_KEYWORDS.has(token)) weight *= 2.0;

      // Boost capitalized terms (brands, models)
      if (/^[A-Z]/.test(token)) weight *= 1.6;

      termWeights.set(token, weight);
    });

    return {
      tokens: dedupedTokens,
      phrases,
      hasPriceIntent,
      numericTokens,
      entityTokens,
      termWeights,
      chunkTarget: chunkTarget || RAG_CHUNK_SIZE
    };
  }

  static extractPlainTextForRag(html) {
    if (!html) {
      return '';
    }

    // Remove unwanted elements that contain boilerplate/navigation
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ')
      // Remove common navigation/boilerplate elements
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
      // Remove elements with common navigation class names
      .replace(/<div[^>]*class="[^"]*(?:nav|menu|sidebar|breadcrumb|cookie|popup|modal|advertisement|ad-|banner)[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ')
      .replace(/<ul[^>]*class="[^"]*(?:nav|menu|breadcrumb)[^"]*"[^>]*>[\s\S]*?<\/ul>/gi, ' ');

    // Convert block elements to newlines
    text = text
      .replace(/<(\/)?(h[1-6]|p|div|section|article|li|ul|ol|tr|td|th|table|main)[^>]*>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00A0/g, ' ')
      .replace(/\r/g, '\n');

    // Normalize whitespace
    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n') // Preserve paragraph breaks
      .replace(/[ \t]+/g, ' ');

    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    // Filter out CSS, navigation patterns, and boilerplate
    const cleanedLines = this.filterOutBoilerplate(lines);
    return cleanedLines.join('\n');
  }

  static chunkTextForRag(text, chunkSize, chunkOverlap) {
    if (!text || !text.length) {
      return [];
    }

    // First split by paragraph boundaries (double newlines or section breaks)
    const paragraphs = text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(Boolean);

    if (!paragraphs.length) {
      return [];
    }

    const chunks = [];
    const maxLength = Math.max(200, chunkSize);
    const minLength = Math.min(150, Math.floor(chunkSize * 0.3));
    const targetLength = chunkSize;

    let buffer = '';
    let bufferSentences = [];

    const pushBuffer = () => {
      const candidate = buffer.trim();
      if (!candidate.length) {
        return;
      }
      // Don't skip small chunks at the beginning - they might have key info
      if (candidate.length < Math.min(60, minLength) && chunks.length > 3) {
        return;
      }
      chunks.push({ content: candidate, sentences: bufferSentences.length });
      buffer = '';
      bufferSentences = [];
    };

    // Process each paragraph
    paragraphs.forEach(paragraph => {
      // Split paragraph into sentences while preserving semantic units
      const sentences = paragraph.match(/[^.!?\n]+[.!?]+(?:\s+|$)|[^.!?\n]+(?:\n|$)/g) || [paragraph];

      sentences.forEach(sentence => {
        const trimmed = sentence.trim();
        if (!trimmed) return;

        const candidate = buffer ? `${buffer} ${trimmed}` : trimmed;

        // If adding this sentence keeps us under max length, add it
        if (candidate.length <= maxLength) {
          buffer = candidate;
          bufferSentences.push(trimmed);
        } else {
          // Buffer is getting too long
          if (buffer.length >= minLength) {
            // Emit what we have if it's substantial
            pushBuffer();
            buffer = trimmed;
            bufferSentences = [trimmed];
          } else {
            // Buffer is small, so combine with current sentence even if over max
            buffer = candidate;
            bufferSentences.push(trimmed);
          }
        }

        // If buffer is approaching target size and we have complete sentences, emit
        if (buffer.length >= targetLength * 0.8 && bufferSentences.length >= 2) {
          pushBuffer();
        }
      });

      // After each paragraph, if we have content close to target, emit
      if (buffer.length >= targetLength * 0.6) {
        pushBuffer();
      }
    });

    // Emit any remaining buffer
    pushBuffer();

    if (chunkOverlap <= 0 || chunks.length <= 1) {
      return chunks;
    }

    // Apply smart overlap that preserves sentence boundaries
    const overlapped = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];

      if (i === 0) {
        overlapped.push({ content: chunk.content });
        continue;
      }

      const prev = overlapped[overlapped.length - 1];

      // Try to find a sentence boundary in the overlap region
      const overlapText = prev.content.slice(-chunkOverlap);
      const sentenceMatch = overlapText.match(/[.!?]\s+(.+)$/);

      const overlapSlice = sentenceMatch
        ? sentenceMatch[1] // Start from last complete sentence in overlap
        : overlapText; // Fallback to character-based overlap

      overlapped.push({
        content: `${overlapSlice} ${chunk.content}`.trim()
      });
    }

    return overlapped;
  }

  static filterOutBoilerplate(lines) {
    if (!Array.isArray(lines)) {
      return [];
    }

    return lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed.length) {
        return false;
      }

      // Filter CSS
      if (this.looksLikeCssLine(trimmed)) {
        return false;
      }

      // Filter navigation/menu patterns
      if (this.looksLikeNavigationLine(trimmed)) {
        return false;
      }

      // Keep lines with substantial content
      return true;
    });
  }

  static looksLikeNavigationLine(line) {
    if (!line || line.length === 0) {
      return true;
    }

    const lower = line.toLowerCase();

    // Common navigation keywords (but allow if part of longer sentence)
    const navKeywords = [
      'sign in', 'log in', 'login', 'sign up', 'register', 'subscribe',
      'follow us', 'contact us', 'about us', 'privacy policy', 'terms of service',
      'cookie policy', 'all rights reserved', 'copyright ©', '© 20',
      'home page', 'site map', 'skip to', 'back to top', 'previous page', 'next page',
      'share this', 'tweet this', 'facebook', 'twitter', 'instagram', 'youtube',
      'rss feed', 'newsletter', 'get updates'
    ];

    // If line is very short and contains nav keywords, it's likely navigation
    if (line.length < 100) {
      for (const keyword of navKeywords) {
        if (lower.includes(keyword)) {
          // Exception: if the line has substantial additional content, keep it
          const words = line.split(/\s+/).length;
          if (words <= 6) {
            return true;
          }
        }
      }
    }

    // Filter out lines that are mostly links/navigation items (many words but all short)
    const words = line.split(/\s+/);
    if (words.length > 3 && words.length < 15) {
      const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
      // Navigation items tend to have short words
      if (avgWordLength < 5) {
        // Check if it looks like a menu (Home About Contact...)
        const hasNavigationPattern = /^([A-Z][a-z]+\s*){2,}$/.test(line);
        if (hasNavigationPattern) {
          return true;
        }
      }
    }

    // Filter lines with excessive punctuation or special chars (likely UI elements)
    const specialCharCount = (line.match(/[|>→•·]/g) || []).length;
    if (specialCharCount > 3 && line.length < 150) {
      return true;
    }

    // Filter repetitive short phrases (menu items often repeat patterns)
    if (line.length < 80 && /(.{3,15})\s+\1/.test(line)) {
      return true;
    }

    return false;
  }

  static pruneCssNoiseFromText(text) {
    if (!text || typeof text !== 'string') {
      return '';
    }
    const cleaned = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length)
      .filter(line => !this.looksLikeCssLine(line))
      .filter(line => !this.looksLikeNavigationLine(line));

    return cleaned.join('\n').trim();
  }

  static looksLikeCssLine(line) {
    if (!line) {
      return true;
    }
    const trimmed = line.trim();

    if (!trimmed.length) {
      return true;
    }

    if (trimmed.startsWith('@media') || trimmed.startsWith('@font-face') || trimmed.startsWith(':root')) {
      return true;
    }

    if (/[{}]/.test(trimmed)) {
      return true;
    }

    if (/--[a-z0-9-]+\s*:/.test(trimmed)) {
      return true;
    }

    const cssPropertyPattern = /\b(display|margin|padding|font|color|background|border|flex|grid|position|align|justify|gap|width|height|left|right|top|bottom|opacity|visibility|transform|transition|animation|box-shadow|text-align|line-height|letter-spacing|z-index)\b/i;
    if (/;\s*$/.test(trimmed) && cssPropertyPattern.test(trimmed)) {
      return true;
    }

    if (/^[.#][\w-]+\s*(,|\{|:)/.test(trimmed)) {
      return true;
    }

    if (cssPropertyPattern.test(trimmed) && trimmed.includes(':') && !/[.!?]$/.test(trimmed)) {
      return true;
    }

    return false;
  }

  static assessContentQuality(text) {
    if (!text || typeof text !== 'string') {
      return 0;
    }

    let score = 1.0;

    const words = text.split(/\s+/);
    const wordCount = words.length;
    const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / Math.max(1, wordCount);

    // Penalize very short chunks
    if (wordCount < 20) {
      score *= 0.4;
    } else if (wordCount < 50) {
      score *= 0.7;
    }

    // Penalize chunks with very short average word length (navigation tends to have short words)
    if (avgWordLength < 4.5) {
      score *= 0.6;
    }

    // Count sentences
    const sentences = text.match(/[.!?]+/g) || [];
    const sentenceCount = sentences.length;

    // Good content has multiple complete sentences
    if (sentenceCount >= 3) {
      score *= 1.2;
    } else if (sentenceCount === 0 && wordCount > 30) {
      // No punctuation but many words = likely navigation list
      score *= 0.5;
    }

    // Check for informational content indicators
    const hasNumbers = /\d/.test(text);
    const hasTechnicalTerms = /(?:processor|memory|storage|display|battery|camera|specifications|features|dimensions|weight|performance|gb|tb|ghz|mhz|inch|pixels|resolution)/i.test(text);
    const hasDescriptiveWords = /(?:excellent|powerful|designed|advanced|innovative|premium|professional|reliable|efficient|compatible)/i.test(text);

    if (hasNumbers) score *= 1.15;
    if (hasTechnicalTerms) score *= 1.25;
    if (hasDescriptiveWords) score *= 1.1;

    // Penalize if text looks like a list of links
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > 5) {
      const shortLineCount = lines.filter(line => line.split(/\s+/).length <= 5).length;
      const shortLineRatio = shortLineCount / lines.length;

      if (shortLineRatio > 0.7) {
        // Mostly short lines = likely navigation
        score *= 0.4;
      }
    }

    // Penalize excessive capitalization (menus often have Title Case Everything)
    const capitalizedWords = words.filter(w => /^[A-Z]/.test(w)).length;
    const capitalizationRatio = capitalizedWords / Math.max(1, wordCount);

    if (capitalizationRatio > 0.5 && wordCount < 50) {
      // More than half capitalized in a short chunk = likely menu
      score *= 0.5;
    }

    // Look for repeating patterns (common in navigation)
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    const uniqueRatio = uniqueWords.size / Math.max(1, wordCount);

    if (uniqueRatio < 0.4 && wordCount > 15) {
      // Low uniqueness with decent word count = repetitive menu items
      score *= 0.6;
    }

    return Math.max(0, Math.min(2.0, score));
  }

  static hasReadableContent(text) {
    if (!text || typeof text !== 'string') {
      return false;
    }

    const plain = text.replace(/\s+/g, ' ').trim();
    if (!plain.length) {
      return false;
    }

    const letters = (plain.match(/[a-zA-Z]/g) || []).length;
    if (letters < 12) {
      return false;
    }

    const punctuation = (plain.match(/[{};<>]/g) || []).length;
    if (punctuation > letters * 0.8) {
      return false;
    }

    const words = plain.match(/[a-zA-Z0-9$€£]+/g) || [];
    const meaningful = words.filter(word => word.length >= 3 || /\d/.test(word));

    return meaningful.length >= 3;
  }

  static tokenizeForRag(text) {
    if (!text) {
      return [];
    }

    const matches = text.toLowerCase().match(/[a-z0-9$€£.%-]+/g);
    return matches ? matches.filter(token => token.length > 1 || /\d/.test(token)) : [];
  }

  static scoreChunkForRag(chunkText, querySignals) {
    if (!chunkText) {
      return { score: 0, coverage: 0 };
    }

    const chunkLower = chunkText.toLowerCase();
    let score = 0;
    let matchedTokens = 0;
    const chunkTokens = this.tokenizeForRag(chunkLower);
    const chunkLength = chunkTokens.length;

    // BM25-like parameters
    const k1 = 1.5; // Term frequency saturation parameter
    const b = 0.75; // Length normalization parameter
    const avgChunkLength = querySignals.chunkTarget / 5; // Rough estimate of average tokens

    // Score individual token matches with term weighting
    querySignals.tokens.forEach(token => {
      if (!token) {
        return;
      }

      // Count occurrences (term frequency)
      let occurrences = 0;
      let firstPosition = -1;
      let position = chunkLower.indexOf(token);

      while (position !== -1) {
        if (firstPosition === -1) {
          firstPosition = position;
        }
        occurrences += 1;
        position = chunkLower.indexOf(token, position + token.length);
      }

      if (occurrences > 0) {
        matchedTokens += 1;

        // BM25-like term frequency scoring
        const tf = occurrences;
        const lengthNorm = 1 - b + b * (chunkLength / avgChunkLength);
        const bm25Component = (tf * (k1 + 1)) / (tf + k1 * lengthNorm);

        // Apply term-specific weight
        const termWeight = querySignals.termWeights?.get(token) || 1.0;

        // Position bonus: earlier matches are more relevant
        const positionBonus = firstPosition < chunkLength * 0.2 ? 1.3 : 1.0;

        // Exact word boundary matching bonus
        const wordBoundaryRegex = new RegExp(`\\b${token}\\b`, 'i');
        const exactMatch = wordBoundaryRegex.test(chunkText) ? 1.4 : 1.0;

        score += bm25Component * termWeight * positionBonus * exactMatch;
      }
    });

    // Bigram phrase matching (higher weight than individual tokens)
    const bigramMatches = querySignals.phrases.filter(phrase =>
      phrase && chunkLower.includes(phrase) && phrase.split(' ').length === 2
    );
    score += bigramMatches.length * 3.5;

    // Trigram phrase matching (even higher weight for exact phrase matches)
    const trigramMatches = querySignals.phrases.filter(phrase =>
      phrase && chunkLower.includes(phrase) && phrase.split(' ').length === 3
    );
    score += trigramMatches.length * 6.0;

    // Entity token bonus (brands, models, specific terms)
    if (querySignals.entityTokens) {
      const entityMatches = querySignals.entityTokens.filter(entity =>
        chunkLower.includes(entity)
      );
      score += entityMatches.length * 2.5;
    }

    // Price intent bonus
    if (querySignals.hasPriceIntent) {
      // Look for price patterns with currency symbols
      const pricePatterns = [
        /\$\s?\d+(?:,\d{3})*(?:\.\d{2})?/g,
        /€\s?\d+(?:,\d{3})*(?:\.\d{2})?/g,
        /£\s?\d+(?:,\d{3})*(?:\.\d{2})?/g,
        /\d+(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|EUR|GBP)/gi
      ];

      let priceMatches = 0;
      pricePatterns.forEach(pattern => {
        const matches = chunkText.match(pattern);
        if (matches) priceMatches += matches.length;
      });

      score += priceMatches * 2.0;
    }

    // Numeric content bonus when query has numbers
    if (querySignals.numericTokens && querySignals.numericTokens.length > 0) {
      const chunkNumbers = chunkText.match(/\d+(?:\.\d+)?/g) || [];
      const numberOverlap = querySignals.numericTokens.filter(num =>
        chunkNumbers.some(cn => cn.includes(num) || num.includes(cn))
      );
      score += numberOverlap.length * 2.8;
    }

    // Penalty for no matches
    if (matchedTokens === 0 && bigramMatches.length === 0 && trigramMatches.length === 0) {
      score *= 0.1;
    }

    // Coverage score (what fraction of query terms appear)
    const coverage = querySignals.tokens.length
      ? matchedTokens / querySignals.tokens.length
      : 0;

    // Boost score if coverage is high
    if (coverage > 0.7) {
      score *= 1.5;
    } else if (coverage > 0.5) {
      score *= 1.2;
    }

    return { score, coverage };
  }

  static applyAnalysisSnippets(results, analysis) {
    if (!Array.isArray(results) || !results.length || !analysis) {
      return;
    }

    const normalize = (value) => {
      if (!value || typeof value !== 'string') return null;
      try {
        const url = new URL(value);
        url.hash = '';
        return url.toString();
      } catch {
        return value.trim().toLowerCase();
      }
    };

    const linkReasonByUrl = new Map();
    const linkReasonByTitle = new Map();

    if (Array.isArray(analysis.bestLinks)) {
      analysis.bestLinks.forEach(link => {
        const reason = typeof link?.reason === 'string' ? link.reason.trim() : null;
        if (!reason) return;
        const urlKey = normalize(link.url);
        if (urlKey && !linkReasonByUrl.has(urlKey)) {
          linkReasonByUrl.set(urlKey, reason);
        }
        const titleKey = typeof link.title === 'string' ? link.title.trim().toLowerCase() : null;
        if (titleKey && !linkReasonByTitle.has(titleKey)) {
          linkReasonByTitle.set(titleKey, reason);
        }
      });
    }

    const fallbackFindings = Array.isArray(analysis.keyFindings)
      ? analysis.keyFindings.filter(item => typeof item === 'string' && item.trim().length)
      : [];

    let findingIndex = 0;

    results.forEach(result => {
      if (!result || (result.snippet && result.snippet.trim().length)) {
        return;
      }

      const urlKey = normalize(result.url);
      const titleKey = typeof result.title === 'string' ? result.title.trim().toLowerCase() : null;

      const reason =
        (urlKey && linkReasonByUrl.get(urlKey)) ||
        (titleKey && linkReasonByTitle.get(titleKey)) ||
        (findingIndex < fallbackFindings.length ? fallbackFindings[findingIndex++] : null);

      if (reason) {
        result.snippet = reason;
      }

      if (!result.snippet && Array.isArray(result.ragChunks) && result.ragChunks.length) {
        const primaryChunk = result.ragChunks[0]?.text || result.ragChunks[0]?.promptText;
        if (primaryChunk) {
          result.snippet = primaryChunk.slice(0, 500);
        }
      }
    });
  }

  static async fillSnippetsFromPages(results, maxFetches = 5) {
    if (!Array.isArray(results) || maxFetches <= 0) {
      return;
    }

    const tasks = [];
    for (const result of results) {
      if (!result || result.snippet) {
        continue;
      }
      if (!result.url || !/^https?:/i.test(result.url)) {
        continue;
      }
      if (Array.isArray(result.ragChunks) && result.ragChunks.length) {
        const primaryChunk = result.ragChunks[0]?.text || result.ragChunks[0]?.promptText;
        if (primaryChunk) {
          result.snippet = primaryChunk.slice(0, 500);
          continue;
        }
      }
      if (tasks.length >= maxFetches) {
        break;
      }

      tasks.push(
        this.fetchPageSnippet(result.url)
          .then(snippet => {
            if (snippet) {
              result.snippet = snippet;
            }
          })
          .catch(error => {
            console.warn('[WebSearch] Page snippet fetch failed:', result.url, error);
          })
      );
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  static async fetchPageHtml(url, maxChars = ANALYSIS_HTML_MAX_LENGTH) {
    const pool = await getWebSearchWorkerPool();
    if (pool) {
      try {
        const html = await pool.runTask({
          type: 'fetchPageHtml',
          url,
          maxChars,
          proxyUrl: LOCAL_SEARCH_PROXY_URL
        });
        if (typeof html === 'string') {
          return html;
        }
      } catch (error) {
        console.warn('[WebSearch] Worker fetchPageHtml failed:', error);
      }
    }

    return this.fetchPageHtmlSingleThread(url, maxChars);
  }

  static async fetchPageSnippet(url) {
    const pool = await getWebSearchWorkerPool();
    if (pool) {
      try {
        const snippet = await pool.runTask({
          type: 'fetchPageSnippet',
          url,
          proxyUrl: LOCAL_SEARCH_PROXY_URL,
          maxChars: ANALYSIS_HTML_MAX_LENGTH
        });
        if (typeof snippet === 'string' && snippet.length) {
          return snippet;
        }
      } catch (error) {
        console.warn('[WebSearch] Worker fetchPageSnippet failed:', url, error);
      }
    }

    return this.fetchPageSnippetSingleThread(url);
  }

  static async fetchPageHtmlSingleThread(url, maxChars = ANALYSIS_HTML_MAX_LENGTH) {
    const sources = [];

    if (LOCAL_SEARCH_PROXY_URL) {
      sources.push({
        type: 'proxy',
        url: `${LOCAL_SEARCH_PROXY_URL}${encodeURIComponent(url)}`,
        headers: {
          Accept: 'text/html,application/xhtml+xml'
        }
      });
    }

    // Only add direct fetch as fallback if no proxy is configured
    // When proxy fails (502), skip direct fetch since it will fail with CORS
    if (!LOCAL_SEARCH_PROXY_URL) {
      sources.push({
        type: 'direct',
        url,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
    }

    for (const source of sources) {
      try {
        const response = await fetch(source.url, {
          headers: source.headers
        });

        if (!response.ok) {
          console.warn(`[WebSearch] ${source.type} fetch non-OK response:`, source.url, response.status);
          continue;
        }

        const html = await response.text();
        if (!html) {
          continue;
        }

        return html.length > maxChars ? html.slice(0, maxChars) : html;
      } catch (error) {
        console.warn(`[WebSearch] ${source.type} fetch error:`, source.url, error);
      }
    }

    return null;
  }

  static async fetchPageSnippetSingleThread(url) {
    try {
      const html = await this.fetchPageHtmlSingleThread(url);
      if (!html) {
        return null;
      }
      const plainText = this.cleanText(this.stripHtml(html));
      if (plainText) {
        return plainText.slice(0, 12000);
      }
    } catch (error) {
      console.warn('[WebSearch] Page snippet fetch error:', url, error);
    }
    return null;
  }
}

class ThreadPool {
  constructor(WorkerCtor, workerPath, size) {
    this.WorkerCtor = WorkerCtor;
    this.workerPath = workerPath;
    this.size = Math.max(1, size);
    this.queue = [];
    this.idleWorkers = [];
    this.workers = new Set();
    this.tasks = new Map();
    this.nextTaskId = 1;
    this.shuttingDown = false;

    for (let i = 0; i < this.size; i += 1) {
      this.spawnWorker();
    }
  }

  spawnWorker() {
    if (this.shuttingDown) {
      return;
    }

    const worker = new this.WorkerCtor(this.workerPath, { type: 'module' });
    worker.on('message', (message) => this.handleMessage(worker, message));
    worker.on('error', (error) => this.handleWorkerError(worker, error));
    worker.on('exit', (code) => this.handleWorkerExit(worker, code));

    this.workers.add(worker);
    this.idleWorkers.push(worker);
    this.drainQueue();
  }

  runTask(payload) {
    if (this.shuttingDown) {
      return Promise.reject(new Error('Worker pool is shutting down'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this.drainQueue();
    });
  }

  drainQueue() {
    if (this.shuttingDown) {
      return;
    }

    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.shift();
      const task = this.queue.shift();
      const id = this.nextTaskId++;

      this.tasks.set(id, { resolve: task.resolve, reject: task.reject, worker });

      try {
        worker.postMessage({ id, payload: task.payload });
      } catch (error) {
        this.tasks.delete(id);
        task.reject(error);
        this.handleWorkerError(worker, error);
      }
    }
  }

  handleMessage(worker, message) {
    if (this.shuttingDown) {
      return;
    }

    if (message && message.command === 'ready') {
      if (!this.idleWorkers.includes(worker)) {
        this.idleWorkers.push(worker);
      }
      this.drainQueue();
      return;
    }

    const { id, success, result, error } = message || {};
    if (typeof id !== 'number') {
      if (!this.idleWorkers.includes(worker)) {
        this.idleWorkers.push(worker);
      }
      this.drainQueue();
      return;
    }

    const task = this.tasks.get(id);
    if (!task) {
      if (!this.idleWorkers.includes(worker)) {
        this.idleWorkers.push(worker);
      }
      this.drainQueue();
      return;
    }

    this.tasks.delete(id);

    if (success) {
      task.resolve(result);
    } else {
      task.reject(new Error(error || 'Worker task failed'));
    }

    if (!this.idleWorkers.includes(worker)) {
      this.idleWorkers.push(worker);
    }
    this.drainQueue();
  }

  handleWorkerError(worker, error) {
    if (this.shuttingDown) {
      return;
    }

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.worker === worker) {
        task.reject(error);
        this.tasks.delete(taskId);
      }
    }

    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex !== -1) {
      this.idleWorkers.splice(idleIndex, 1);
    }

    this.workers.delete(worker);

    if (!this.shuttingDown) {
      this.spawnWorker();
    }
  }

  handleWorkerExit(worker, code) {
    if (this.shuttingDown) {
      return;
    }
    const error = new Error(`Worker exited with code ${code}`);
    this.handleWorkerError(worker, error);
  }

  async destroy() {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;

    const shutdownError = new Error('Worker pool shutting down');
    for (const queuedTask of this.queue.splice(0)) {
      queuedTask.reject(shutdownError);
    }

    for (const [taskId, task] of this.tasks.entries()) {
      task.reject(shutdownError);
      this.tasks.delete(taskId);
    }

    const workers = Array.from(this.workers);
    await Promise.allSettled(workers.map((worker) => {
      try {
        worker.postMessage({ command: 'shutdown' });
      } catch (_) {
        // ignore
      }
      return worker.terminate().catch(() => {});
    }));

    this.workers.clear();
    this.idleWorkers = [];
  }

  forceTerminate() {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    const shutdownError = new Error('Worker pool shutting down');
    for (const task of this.queue.splice(0)) {
      task.reject(shutdownError);
    }
    for (const [taskId, task] of this.tasks.entries()) {
      task.reject(shutdownError);
      this.tasks.delete(taskId);
    }

    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch (_) {
        // ignore
      }
    }

    this.workers.clear();
    this.idleWorkers = [];
  }
}

async function getWebSearchWorkerPool() {
  if (!isNodeEnvironment) {
    return null;
  }

  if (webSearchWorkerPoolPromise) {
    return webSearchWorkerPoolPromise;
  }

  webSearchWorkerPoolPromise = (async () => {
    try {
      const { Worker } = await import('node:worker_threads');
      const os = await import('node:os');
      const workerCount = Number(
        process.env.SHOPSCOUT_WEB_SEARCH_WORKERS ||
        Math.max(1, Math.min(os.cpus().length, 4))
      );
      const pool = new ThreadPool(Worker, WEB_SEARCH_WORKER_PATH, workerCount);

      if (!webSearchWorkerShutdownHookRegistered && typeof process !== 'undefined' && typeof process.on === 'function') {
        webSearchWorkerShutdownHookRegistered = true;
        process.on('exit', () => {
          pool.forceTerminate();
        });
      }

      return pool;
    } catch (error) {
      console.warn('[WebSearch] Worker threads unavailable:', error.message);
      return null;
    }
  })();

  return webSearchWorkerPoolPromise;
}
