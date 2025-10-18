import { ClaudeAPI } from './claude-api.js';

const ANALYSIS_HTML_MAX_LENGTH = 8000;
const LOCAL_SEARCH_PROXY_URL = 'http://127.0.0.1:9000/fetch?render=browser&url=';

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

    await this.populateAnalysisHtml(analyzedResults, analysisResultCount);

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
        snippetLength: result.snippet ? result.snippet.length : 0
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
    const formattedResults = results
      .map((result, index) => {
        const html = typeof result.analysisHtml === 'string'
          ? result.analysisHtml.trim()
          : '';
        const snippet = result.snippet
          ? result.snippet.replace(/\s+/g, ' ').trim()
          : 'No snippet provided.';
        const label = html ? `Page HTML (truncated to ${html.length} characters)` : 'Snippet';
        const content = html || snippet;

        return `${index + 1}. Title: ${result.title}\n   URL: ${result.url}\n   ${label}:\n"""${content}"""`;
      })
      .join('\n\n');

    return `You are a fast research assistant helping a shopping extension answer the user's research query.\n` +
      `Identify the primary intent of the query (e.g., price, availability, color options, specs, reviews, authenticity) and surface the most relevant facts for that intent.\n` +
      `Many results include truncated raw HTML from the page; leverage the structure and content to extract concrete facts (numbers, named colors, specific features, pros/cons, release dates, etc.). When HTML is not available, rely on the snippet, title, and domain reputation to infer useful context instead of claiming there is no data.\n` +
      `Only state that information is missing when none of the results provide a credible signal after reasonable inference.\n\n` +
      `Search Query: ${query}\n\n` +
      `DuckDuckGo Results:\n${formattedResults}\n\n` +
      `Reply strictly as JSON with this exact schema:\n` +
      `{\n` +
      `  "summary": "2-3 sentence factual overview that directly answers the query, highlighting the most relevant concrete details (prices, colors, specs, dates, etc.)",\n` +
      `  "keyFindings": ["succinct bullet findings grounded in the snippets with the most pertinent facts for this query"],\n` +
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

  static async populateAnalysisHtml(results, maxFetches = 5, maxChars = ANALYSIS_HTML_MAX_LENGTH) {
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
            result.analysisHtml = html;
            if (!result.snippet) {
              const plainText = this.cleanText(this.stripHtml(html));
              if (plainText) {
                result.snippet = plainText.slice(0, 500);
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
    const sources = [];

    if (LOCAL_SEARCH_PROXY_URL) {
      sources.push({
        type: 'proxy',
        url: `${LOCAL_SEARCH_PROXY_URL}${encodeURIComponent(url)}`,
        headers: {
          'Accept': 'text/html,application/xhtml+xml'
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

  static async fetchPageSnippet(url) {
    try {
      const html = await this.fetchPageHtml(url);
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
