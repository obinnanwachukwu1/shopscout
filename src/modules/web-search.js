import { ClaudeAPI } from './claude-api.js';

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
      analysisResultCount = 5
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

    const prompt = this.buildAnalysisPrompt(query, analyzedResults);
    const fallbackAnalysis = this.buildFallbackAnalysis(analyzedResults);

    const haikuAnalysis = await ClaudeAPI.callClaude(
      prompt,
      'claude-haiku-4-5',
      fallbackAnalysis
    );

    const analysis = this.normalizeSmartAnalysis(haikuAnalysis, analyzedResults);

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
      // Pattern 1: Extract result blocks with class="result"
      const resultBlockPattern = /<div class="result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
      let match;

      while ((match = resultBlockPattern.exec(html)) !== null && results.length < maxResults) {
        const block = match[1];

        // Extract title from result__a
        const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
        const title = titleMatch ? this.cleanText(titleMatch[1]) : null;

        // Extract URL from result__url
        const urlMatch = block.match(/class="result__url"[^>]*href="([^"]+)"/);
        const url = urlMatch ? this.decodeUrl(urlMatch[1]) : null;

        // Extract snippet from result__snippet
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)</);
        const snippet = snippetMatch ? this.cleanText(snippetMatch[1]) : null;

        if (title && url) {
          results.push({ title, url, snippet });
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

  /**
   * Build Claude prompt for analyzing search results
   */
  static buildAnalysisPrompt(query, results) {
    const formattedResults = results
      .map((result, index) => {
        const snippet = result.snippet
          ? result.snippet.replace(/\s+/g, ' ').trim()
          : 'No snippet provided.';

        return `${index + 1}. Title: ${result.title}\n   URL: ${result.url}\n   Snippet: ${snippet}`;
      })
      .join('\n\n');

    return `You are a fast research assistant helping a shopping extension understand public information.\n` +
      `Using only the DuckDuckGo search snippets below, extract the most relevant facts about the query.\n` +
      `If you cannot find concrete information, acknowledge the gap.\n\n` +
      `Search Query: ${query}\n\n` +
      `DuckDuckGo Results:\n${formattedResults}\n\n` +
      `Reply strictly as JSON with this exact schema:\n` +
      `{\n` +
      `  "summary": "2-3 sentence factual overview directly addressing the query when possible",\n` +
      `  "keyFindings": ["short bullet findings grounded in the snippets"],\n` +
      `  "bestLinks": [{"title": "Result title", "url": "https://example.com", "reason": "Why this link helps"}],\n` +
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
}
