/**
 * Price Comparison Module
 *
 * Fetches comparable prices using DuckDuckGo search
 * Amazon product -> search eBay via DuckDuckGo
 * eBay product -> search Amazon via DuckDuckGo
 */

export class PriceComparison {
  /**
   * Fetch comparable prices from the other site
   */
  static async fetchComparables(productData) {
    const searchQuery = this.cleanTitleForSearch(productData.title);

    console.log('[Price Comparison] Starting search', {
      originalTitle: productData.title,
      cleanedQuery: searchQuery,
      currentSite: productData.site,
      targetSite: productData.site === 'amazon' ? 'ebay.com' : 'amazon.com'
    });

    if (productData.site === 'amazon') {
      return await this.searchViaDuckDuckGo(searchQuery, 'ebay.com');
    } else {
      return await this.searchViaDuckDuckGo(searchQuery, 'amazon.com');
    }
  }

  /**
   * Fetch sold listings for collectibles (eBay only)
   */
  static async fetchSoldListings(productData) {
    if (productData.site !== 'ebay') {
      return null;
    }

    const searchQuery = this.cleanTitleForSearch(productData.title);
    return await this.searchEbaySoldListings(searchQuery);
  }

  /**
   * Search via DuckDuckGo with site filter
   */
  static async searchViaDuckDuckGo(query, site) {
    try {
      console.log('[Price Search] Attempting direct site search instead of DuckDuckGo');

      // Use direct site search instead of DuckDuckGo
      if (site.includes('ebay')) {
        return await this.searchEbayDirect(query);
      } else if (site.includes('amazon')) {
        return await this.searchAmazonDirect(query);
      }

      return this.getEmptyPriceData();
    } catch (error) {
      console.error('[Price Search] Error searching:', error);
      return this.getEmptyPriceData();
    }
  }

  /**
   * Search Amazon directly
   */
  static async searchAmazonDirect(query) {
    try {
      const encodedQuery = encodeURIComponent(query);
      const searchUrl = `https://www.amazon.com/s?k=${encodedQuery}`;

      console.log('[Amazon Search] Searching:', searchUrl);

      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) {
        console.error('[Amazon Search] Failed:', response.status);
        return this.getEmptyPriceData();
      }

      const html = await response.text();
      console.log('[Amazon Search] Response HTML length:', html.length);

      // Extract prices and comparable listings from Amazon search results
      const prices = this.extractAmazonPrices(html);
      const listingComparables = this.extractAmazonListingSummaries(html);
      const listingPrices = listingComparables.map(item => item.priceValue).filter(value => typeof value === 'number');

      console.log('[Amazon Search] Extracted prices:', prices);
      console.log('[Amazon Search] Listing comparables:', listingComparables.length);

      const combinedPrices = [...prices, ...listingPrices];
      const filteredPrices = [...new Set(combinedPrices.filter(value => value > 0 && value < 100000))];
      if (filteredPrices.length === 0) {
        console.log('[Amazon Search] No valid prices extracted');
        return this.getEmptyPriceData();
      }
      const range = this.calculateIqrRange(filteredPrices);
      return {
        prices: filteredPrices,
        median: this.calculateMedian(filteredPrices),
        min: range.min,
        max: range.max,
        compCount: listingComparables.length || filteredPrices.length,
        currentPrice: null,
        source: 'amazon',
        comparables: listingComparables
      };
    } catch (error) {
      console.error('[Amazon Search] Error:', error);
      return this.getEmptyPriceData();
    }
  }

  /**
   * Search eBay directly
   */
  static async searchEbayDirect(query) {
    try {
      const encodedQuery = encodeURIComponent(query);
      const searchUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodedQuery}`;

      console.log('[eBay Search] Searching:', searchUrl);

      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) {
        console.error('[eBay Search] Failed:', response.status);
        return this.getEmptyPriceData();
      }

      const html = await response.text();
      console.log('[eBay Search] Response HTML length:', html.length);

      // Extract prices and comparable listings from eBay search results
      const prices = this.extractEbayPrices(html);
      const listingComparables = this.extractEbayListingSummaries(html);
      const listingPrices = listingComparables.map(item => item.priceValue).filter(value => typeof value === 'number');

      console.log('[eBay Search] Extracted prices:', prices);
      console.log('[eBay Search] Listing comparables:', listingComparables.length);

      const combinedPrices = [...prices, ...listingPrices];
      const filteredPrices = [...new Set(combinedPrices.filter(value => value > 0 && value < 100000))];
      if (filteredPrices.length === 0) {
        console.log('[eBay Search] No prices from direct search, falling back to DuckDuckGo');
        return await this.searchEbayViaDuckDuckGo(query);
      }
      const range = this.calculateIqrRange(filteredPrices);
      return {
        prices: filteredPrices,
        median: this.calculateMedian(filteredPrices),
        min: range.min,
        max: range.max,
        compCount: listingComparables.length || filteredPrices.length,
        currentPrice: null,
        source: 'ebay',
        comparables: listingComparables
      };
    } catch (error) {
      console.error('[eBay Search] Error:', error);
      return await this.searchEbayViaDuckDuckGo(query);
    }
  }

  static async searchEbayViaDuckDuckGo(query) {
    try {
      const encodedQuery = encodeURIComponent(`${query} site:ebay.com`);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) {
        console.error('[eBay DDG Fallback] Failed:', response.status);
        return this.getEmptyPriceData();
      }

      const html = await response.text();
      const urls = this.extractUrlsFromDDG(html, 'ebay.com');
      const { prices, comparables } = await this.extractPricesFromUrls(urls, 'ebay.com');

      const range = this.calculateIqrRange(prices);
      return {
        prices,
        median: this.calculateMedian(prices),
        min: range.min,
        max: range.max,
        compCount: comparables.length,
        currentPrice: null,
        source: 'ebay',
        comparables
      };
    } catch (error) {
      console.error('[eBay DDG Fallback] Error:', error);
      return this.getEmptyPriceData();
    }
  }

  /**
   * Extract URLs from DuckDuckGo HTML results
   */
  static extractUrlsFromDDG(html, site) {
    const urls = new Set();

    console.log('[URL Extract] Starting URL extraction for site:', site);

    // Pattern 1: uddg parameter with encoded URLs
    const uddgPattern = /uddg=([^"&]+)/g;
    let match;
    while ((match = uddgPattern.exec(html)) !== null) {
      try {
        const decodedUrl = decodeURIComponent(match[1]);
        if (decodedUrl.includes(site)) {
          urls.add(decodedUrl);
          console.log('[URL Extract] Found URL via uddg:', decodedUrl);
        }
      } catch (e) {
        // Skip invalid URLs
      }
    }

    // Pattern 2: Direct href links to target site
    const hrefPattern = new RegExp(`href=["'](https?:\\/\\/[^"']*${site.replace('.', '\\.')}[^"']*)["']`, 'gi');
    while ((match = hrefPattern.exec(html)) !== null) {
      const url = match[1];
      if (url && url.includes(site)) {
        urls.add(url);
        console.log('[URL Extract] Found URL via href:', url);
      }
    }

    // Pattern 3: Look for direct amazon.com or ebay.com URLs
    const directPattern = new RegExp(`https?:\\/\\/[^\\s"'<>]*${site.replace('.', '\\.')}[^\\s"'<>]*`, 'gi');
    while ((match = directPattern.exec(html)) !== null) {
      const url = match[0];
      if (url && url.includes(site) && (url.includes('/dp/') || url.includes('/itm/'))) {
        urls.add(url);
        console.log('[URL Extract] Found URL via direct match:', url);
      }
    }

    const urlArray = Array.from(urls).slice(0, 10);
    console.log('[URL Extract] Total unique URLs found:', urlArray.length);
    return urlArray;
  }

  /**
   * Extract prices from a list of URLs
   */
  static async extractPricesFromUrls(urls, site) {
    const priceValues = [];
    const comparables = [];

    console.log('[Price Extract] Processing URLs for prices', {
      urlCount: urls.length,
      site
    });

    for (const url of urls) {
      try {
        const priceFromUrl = this.extractPriceFromUrl(url);
        if (priceFromUrl && priceFromUrl > 0 && priceFromUrl < 100000) {
          priceValues.push(priceFromUrl);
          const entry = this.buildComparableEntry({
            url,
            priceValue: priceFromUrl,
            site,
            source: 'url-pattern'
          });
          if (entry) {
            comparables.push(entry);
          }
        }
      } catch (error) {
        console.error('[Price Extract] Error extracting price from URL:', error);
      }
    }

    console.log('[Price Extract] Prices from URLs:', priceValues);

    if (priceValues.length < 3 && urls.length > 0) {
      console.log('[Price Extract] Not enough prices from URLs, fetching pages...');
      const pageResults = await this.fetchPricesFromPages(urls.slice(0, 3), site);
      pageResults.forEach(result => {
        if (!result || !result.price) return;
        priceValues.push(result.price);
        const entry = this.buildComparableEntry({
          url: result.url,
          priceValue: result.price,
          site,
          source: 'page-scrape'
        });
        if (entry) {
          comparables.push(entry);
        }
      });
    }

    const filteredPrices = [...new Set(priceValues)].filter(p => p > 0 && p < 100000);
    const filteredComparables = this.dedupeComparables(comparables);

    console.log('[Price Extract] Final filtered prices:', filteredPrices);
    console.log('[Price Extract] Comparable entries:', filteredComparables.length);

    return {
      prices: filteredPrices,
      comparables: filteredComparables
    };
  }

  /**
   * Extract price from URL (if encoded in URL)
   */
  static extractPriceFromUrl(url) {
    // Look for price patterns in URL
    const patterns = [
      /[\?&]price=([0-9.]+)/,
      /\/\$([0-9.]+)/,
      /-\$([0-9.]+)-/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        const price = parseFloat(match[1]);
        if (!isNaN(price)) return price;
      }
    }

    return null;
  }

  /**
   * Fetch prices from actual pages (fallback)
   */
  static async fetchPricesFromPages(urls, site) {
    const results = [];

    console.log('[Fetch Pages] Fetching prices from pages', {
      urls: urls,
      site: site
    });

    for (const url of urls) {
      try {
        console.log('[Fetch Pages] Fetching:', url);
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        const html = await response.text();
        console.log('[Fetch Pages] Response HTML length:', html.length);

        const extracted = site.includes('ebay')
          ? this.extractEbayPrices(html)
          : this.extractAmazonPrices(html);

        console.log('[Fetch Pages] Extracted prices from page:', extracted);

        const priceValue = extracted.find(value => value > 0 && value < 100000);
        if (priceValue) {
          results.push({ url, price: priceValue });
        }
      } catch (error) {
        console.error('[Fetch Pages] Error fetching page:', url, error);
      }
    }

    console.log('[Fetch Pages] Final page results:', results);
    return results;
  }

  static buildComparableEntry({ url, priceValue, site, source, title, condition, description }) {
    if (!url || typeof priceValue !== 'number' || !isFinite(priceValue)) {
      return null;
    }

    const hostname = this.getHostname(url) || site || 'marketplace';
    const resolvedTitle = title?.trim() || this.deriveComparableTitle(url, hostname);

    return {
      title: resolvedTitle,
      url,
      priceValue,
      priceLabel: `$${priceValue.toFixed(2)}`,
      condition: condition || '',
      source: hostname,
      description: description || '',
      type: 'listing',
      origin: source || 'listing'
    };
  }

  static dedupeComparables(entries) {
    if (!Array.isArray(entries)) {
      return [];
    }

    const deduped = [];
    const seen = new Set();

    entries.forEach(entry => {
      if (!entry || typeof entry.priceValue !== 'number' || !isFinite(entry.priceValue)) {
        return;
      }

      const key = `${entry.url || ''}|${entry.priceValue.toFixed(2)}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      deduped.push(entry);
    });

    return deduped.slice(0, 10);
  }

  static deriveComparableTitle(url, fallback) {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      let slug = segments.pop() || segments.pop();

      if (!slug) {
        return this.toTitleCase(fallback || parsed.hostname.replace(/^www\./, ''));
      }

      slug = decodeURIComponent(slug)
        .replace(/[-_]+/g, ' ')
        .replace(/\.(html|htm|php|asp|aspx).*$/i, '')
        .replace(/[0-9]{12,}/g, '')
        .trim();

      if (!slug) {
        return this.toTitleCase(fallback || parsed.hostname.replace(/^www\./, ''));
      }

      return this.toTitleCase(slug).slice(0, 80);
    } catch (error) {
      return fallback || url;
    }
  }

  static toTitleCase(str) {
    if (!str) return '';
    return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
  }

  static getHostname(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '');
    } catch (error) {
      return '';
    }
  }

  /**
   * Search eBay sold listings
   */
  static async searchEbaySoldListings(query) {
    try {
      // Use DuckDuckGo to find sold listings
      const encodedQuery = encodeURIComponent(`${query} sold site:ebay.com`);
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!response.ok) {
        console.error('DuckDuckGo search for sold listings failed:', response.status);
        return this.getEmptySoldData();
      }

      const html = await response.text();
      const urls = this.extractUrlsFromDDG(html, 'ebay.com');

      // Extract prices from URLs
      const { prices, comparables } = await this.extractPricesFromUrls(urls, 'ebay.com');

      return {
        prices,
        avgPrice: prices.length > 0 ? this.calculateAverage(prices) : null,
        median: this.calculateMedian(prices),
        count: prices.length,
        source: 'ebay_sold',
        comparables
      };
    } catch (error) {
      console.error('Error searching eBay sold listings:', error);
      return this.getEmptySoldData();
    }
  }

  /**
   * Get empty sold data structure
   */
  static getEmptySoldData() {
    return {
      prices: [],
      avgPrice: null,
      median: null,
      count: 0,
      source: 'ebay_sold',
      comparables: []
    };
  }


  static extractAmazonListingSummaries(html) {
    const listings = [];
    const normalizedHtml = html.replace(/\u00A0/g, ' ');

    try {
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(normalizedHtml, 'text/html');

        const resultNodes = doc.querySelectorAll('[data-component-type="s-search-result"]');
        resultNodes.forEach(node => {
          const linkEl = node.querySelector('a.a-link-normal.s-no-outline');
          const priceEl = node.querySelector('.a-price > .a-offscreen');
          const titleEl = node.querySelector('h2 a span');
          const conditionEl = node.querySelector('.a-color-success');

          const url = linkEl?.href;
          const priceValue = this.extractPriceFromText(priceEl?.textContent || '');

          if (url && priceValue) {
            const entry = this.buildComparableEntry({
              url,
              priceValue,
              site: 'amazon',
              source: 'search-result',
              title: titleEl?.textContent?.trim(),
              condition: conditionEl?.textContent?.trim()
            });

            if (entry) {
              listings.push(entry);
            }
          }
        });
      }
    } catch (error) {
      console.warn('[Amazon Comparables] DOM parsing failed:', error);
    }

    return this.dedupeComparables(listings);
  }

  static extractEbayListingSummaries(html) {
    const listings = [];
    const normalizedHtml = html.replace(/\u00A0/g, ' ');

    try {
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(normalizedHtml, 'text/html');

        const resultNodes = doc.querySelectorAll('.s-item');
        resultNodes.forEach(node => {
          const linkEl = node.querySelector('a.s-item__link');
          const priceEl = node.querySelector('.s-item__price');
          const titleEl = node.querySelector('.s-item__title');
          const conditionEl = node.querySelector('.SECONDARY_INFO');

          const url = linkEl?.href;
          const priceValue = this.extractPriceFromText(priceEl?.textContent || '');

          if (url && priceValue) {
            const entry = this.buildComparableEntry({
              url,
              priceValue,
              site: 'ebay',
              source: 'search-result',
              title: titleEl?.textContent?.trim(),
              condition: conditionEl?.textContent?.trim()
            });

            if (entry) {
              listings.push(entry);
            }
          }
        });
      }
    } catch (error) {
      console.warn('[eBay Comparables] DOM parsing failed:', error);
    }

    return this.dedupeComparables(listings);
  }


  /**
   * Extract prices from eBay search results HTML
   */
  static extractEbayPrices(html) {
    const prices = new Set();
    const normalizedHtml = html.replace(/\u00A0/g, ' ');

    try {
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const doc = parser.parseFromString(normalizedHtml, 'text/html');
        const selectors = [
          '.s-item__price',
          '[data-testid="item-price"]',
          '.srp__price',
          '.s-item__detail--primary span[aria-label]',
          '.ux-price-section__text span',
          '.x-price-approx__price'
        ];

        selectors.forEach(selector => {
          doc.querySelectorAll(selector).forEach(node => {
            const value = this.extractPriceFromText(node.textContent || '');
            if (value) {
              prices.add(value);
            }
          });
        });
      }
    } catch (error) {
      console.warn('[eBay Price Extract] DOM parsing failed, falling back to regex', error);
    }

    const jsonRegex = /"price"\s*:\s*{\s*"value"\s*:\s*"([0-9.,]+)"/g;
    let match;
    while ((match = jsonRegex.exec(normalizedHtml)) !== null) {
      const value = parseFloat(match[1].replace(/[,]/g, ''));
      if (value > 0 && value < 100000) {
        prices.add(value);
      }
    }

    const priceRegex = /(?:US\s*)?\$\s*([0-9]+[0-9.,]*)/g;
    while ((match = priceRegex.exec(normalizedHtml)) !== null) {
      const value = parseFloat(match[1].replace(/[,]/g, ''));
      if (value > 0 && value < 100000) {
        prices.add(value);
      }
    }

    return Array.from(prices).slice(0, 20);
  }

  static extractPriceFromText(text) {
    if (!text) {
      return null;
    }

    const normalized = text.replace(/\u00A0/g, ' ');
    const cleaned = normalized.replace(/[^0-9.,]/g, '');
    if (!cleaned) {
      return null;
    }

    const value = parseFloat(cleaned.replace(/,/g, ''));
    if (isNaN(value) || value <= 0 || value >= 100000) {
      return null;
    }

    return value;
  }

  /**
   * Extract prices from Amazon search results HTML
   */
  static extractAmazonPrices(html) {
    const prices = [];

    // Amazon price patterns
    const priceRegex = /\$([0-9,]+\.?\d{0,2})/g;
    const matches = html.match(priceRegex);

    if (matches) {
      matches.forEach(match => {
        const price = parseFloat(match.replace(/[$,]/g, ''));
        if (price > 0 && price < 100000) {
          prices.push(price);
        }
      });
    }

    // Deduplicate and limit to top 20
    return [...new Set(prices)].slice(0, 20);
  }

  /**
   * Clean product title for search
   * Removes brand names, model numbers, and noise words
   */
  static cleanTitleForSearch(title) {
    // Remove common noise words
    const noiseWords = [
      'new', 'brand new', 'sealed', 'free shipping',
      'fast shipping', 'oem', 'original', 'genuine',
      'official', 'authentic', 'refurbished', 'renewed',
      'certified', 'warranty'
    ];

    let cleaned = title.toLowerCase();

    noiseWords.forEach(word => {
      // Escape special regex characters
      const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(escapedWord, 'gi'), '');
    });

    // Remove parentheses and brackets manually
    cleaned = cleaned.replace(/[()[\]]/g, '');

    // Strip punctuation/symbols that can confuse search queries
    cleaned = cleaned.replace(/[^a-z0-9\s]/g, ' ');

    // Remove extra whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Limit to first 60 characters
    return cleaned.substring(0, 60);
  }

  /**
   * Calculate median price
   */
  static calculateMedian(prices) {
    if (!prices.length) return null;

    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      return sorted[mid];
    }
  }

  /**
   * Calculate average price
   */
  static calculateAverage(prices) {
    if (!prices.length) return null;
    return prices.reduce((sum, p) => sum + p, 0) / prices.length;
  }

  /**
   * Calculate min/max prices using Interquartile Range to drop outliers
   */
  static calculateIqrRange(prices) {
    if (!prices.length) {
      return { min: null, max: null, filtered: [] };
    }

    const sorted = [...prices].sort((a, b) => a - b);

    if (sorted.length < 4) {
      return {
        min: sorted[0] ?? null,
        max: sorted[sorted.length - 1] ?? null,
        filtered: sorted
      };
    }

    const half = Math.floor(sorted.length / 2);
    const lowerHalf = sorted.slice(0, half);
    const upperHalf = sorted.length % 2 === 0 ? sorted.slice(half) : sorted.slice(half + 1);

    const q1 = this.calculateMedian(lowerHalf);
    const q3 = this.calculateMedian(upperHalf);
    const iqr = q3 - q1;

    if (!isFinite(iqr) || iqr <= 0) {
      return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        filtered: sorted
      };
    }

    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    const filtered = sorted.filter(price => price >= lowerBound && price <= upperBound);

    const safeList = filtered.length ? filtered : sorted;

    return {
      min: safeList[0],
      max: safeList[safeList.length - 1],
      filtered: safeList
    };
  }

  /**
   * Get empty price data structure
   */
  static getEmptyPriceData() {
    return {
      prices: [],
      median: null,
      min: null,
      max: null,
      compCount: 0,
      currentPrice: null,
      source: null,
      comparables: []
    };
  }
}
