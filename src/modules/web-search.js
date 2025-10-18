import { ClaudeAPI } from './claude-api.js';

const ANALYSIS_HTML_MAX_LENGTH = 60000;
const RAG_CHUNK_SIZE = 900;
const RAG_CHUNK_OVERLAP = 150;
const RAG_MAX_CHUNKS_PER_RESULT = 3;
const RAG_CHUNK_PROMPT_LIMIT = 750;
const RAG_MIN_SCORE = 0.05;
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
        const scoreData = this.scoreChunkForRag(sanitizedText, querySignals);
        return {
          index,
          text: sanitizedText,
          score: scoreData.score,
          coverage: scoreData.coverage
        };
      })
      .filter(Boolean)
      .filter(entry => this.hasReadableContent(entry.text))
      .filter(entry => entry.score >= RAG_MIN_SCORE || entry.index === 0);

    const sorted = scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = sorted
      .slice(0, maxChunks)
      .map((entry, order) => ({
        order: order + 1,
        index: entry.index,
        score: Number.isFinite(entry.score) ? Number(entry.score.toFixed(3)) : entry.score,
        coverage: Number.isFinite(entry.coverage) ? Number(entry.coverage.toFixed(3)) : entry.coverage,
        text: entry.text,
        promptText: entry.text.length > RAG_CHUNK_PROMPT_LIMIT
          ? `${entry.text.slice(0, RAG_CHUNK_PROMPT_LIMIT).trim()}…`
          : entry.text.trim()
      }));

    const snippetSource = topChunks[0]?.text || plainText;

    const limitedPlainText = plainText.length > ANALYSIS_HTML_MAX_LENGTH
      ? plainText.slice(0, ANALYSIS_HTML_MAX_LENGTH)
      : plainText;

    return {
      plainText: limitedPlainText,
      ragChunks: topChunks,
      snippet: snippetSource ? snippetSource.slice(0, 500) : null
    };
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

    const phrases = [];
    for (let i = 0; i < dedupedTokens.length - 1; i += 1) {
      const phrase = `${dedupedTokens[i]} ${dedupedTokens[i + 1]}`;
      phrases.push(phrase);
    }

    const hasPriceIntent = dedupedTokens.some(token => PRICE_KEYWORDS.has(token));
    const numericTokens = dedupedTokens.filter(token => /\d/.test(token));

    return {
      tokens: dedupedTokens,
      phrases,
      hasPriceIntent,
      numericTokens,
      chunkTarget: chunkTarget || RAG_CHUNK_SIZE
    };
  }

  static extractPlainTextForRag(html) {
    if (!html) {
      return '';
    }

    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<!--([\s\S]*?)-->/g, ' ');

    text = text
      .replace(/<(\/)?(h[1-6]|p|div|section|article|li|ul|ol|tr|td|th|table|header|footer|main)[^>]*>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00A0/g, ' ')
      .replace(/\r/g, '\n');

    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]+/g, ' ');

    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const cleanedLines = this.filterOutCssNoise(lines);
    return cleanedLines.join('\n');
  }

  static chunkTextForRag(text, chunkSize, chunkOverlap) {
    if (!text || !text.length) {
      return [];
    }

    const sentences = text
      .split(/\r?\n+/)
      .flatMap(paragraph => (paragraph.match(/[^.!?\n]+[.!?]?/g) || [paragraph]))
      .map(sentence => sentence.trim())
      .filter(Boolean);

    if (!sentences.length) {
      return [];
    }

    const chunks = [];
    const maxLength = Math.max(200, chunkSize);
    const minLength = Math.min(180, Math.floor(chunkSize * 0.4));
    const step = Math.max(1, chunkSize - chunkOverlap);

    let buffer = '';

    const pushBuffer = () => {
      const candidate = buffer.trim();
      if (!candidate.length) {
        return;
      }
      if (candidate.length < Math.min(80, minLength) && chunks.length) {
        return;
      }
      chunks.push({ content: candidate });
      buffer = '';
    };

    const emitLongSentence = (sentence) => {
      let start = 0;
      while (start < sentence.length) {
        const slice = sentence.slice(start, start + maxLength).trim();
        if (slice.length >= minLength) {
          chunks.push({ content: slice });
        }
        start += step;
      }
    };

    sentences.forEach(sentence => {
      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length <= maxLength) {
        buffer = candidate;
        return;
      }

      pushBuffer();

      if (sentence.length > maxLength) {
        emitLongSentence(sentence);
        buffer = '';
      } else {
        buffer = sentence;
      }
    });

    pushBuffer();

    if (chunkOverlap <= 0 || chunks.length <= 1) {
      return chunks;
    }

    const overlapped = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (i === 0) {
        overlapped.push({ content: chunk.content });
        continue;
      }

      const prev = overlapped[overlapped.length - 1];
      const overlapSlice = prev.content.slice(-chunkOverlap);
      overlapped.push({
        content: `${overlapSlice} ${chunk.content}`.trim()
      });
    }

    return overlapped;
  }

  static filterOutCssNoise(lines) {
    if (!Array.isArray(lines)) {
      return [];
    }

    return lines.filter(line => {
      const trimmed = line.trim();
      if (!trimmed.length) {
        return false;
      }
      return !this.looksLikeCssLine(trimmed);
    });
  }

  static pruneCssNoiseFromText(text) {
    if (!text || typeof text !== 'string') {
      return '';
    }
    const cleaned = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length)
      .filter(line => !this.looksLikeCssLine(line));

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

    querySignals.tokens.forEach(token => {
      if (!token) {
        return;
      }

      let occurrences = 0;
      let position = chunkLower.indexOf(token);
      while (position !== -1) {
        occurrences += 1;
        position = chunkLower.indexOf(token, position + token.length);
      }

      if (occurrences > 0) {
        matchedTokens += 1;
        const numericWeight = /\d/.test(token) ? 2.2 : 1;
        score += numericWeight * (0.8 + Math.log2(occurrences + 1));
      }
    });

    querySignals.phrases.forEach(phrase => {
      if (phrase && chunkLower.includes(phrase)) {
        score += 1.5;
      }
    });

    if (querySignals.hasPriceIntent && /[$€£]\s?\d+/.test(chunkLower)) {
      score += 1.2;
    }

    if (querySignals.numericTokens.length && /\d/.test(chunkLower)) {
      score += querySignals.numericTokens.length * 0.1;
    }

    if (matchedTokens === 0 && !querySignals.phrases.some(phrase => chunkLower.includes(phrase))) {
      score *= 0.2;
    }

    const lengthNormalizer = Math.max(1, Math.log2(chunkText.length + 64));
    score = score / lengthNormalizer;

    const coverage = querySignals.tokens.length
      ? matchedTokens / querySignals.tokens.length
      : 0;

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

    sources.push({
      type: 'direct',
      url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

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
