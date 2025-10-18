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

      // Extract prices from Amazon search results
      const prices = this.extractAmazonPrices(html);
      console.log('[Amazon Search] Extracted prices:', prices);

      return {
        prices,
        median: this.calculateMedian(prices),
        min: prices.length > 0 ? Math.min(...prices) : null,
        max: prices.length > 0 ? Math.max(...prices) : null,
        compCount: prices.length,
        currentPrice: null,
        source: 'amazon'
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

      // Extract prices from eBay search results
      const prices = this.extractEbayPrices(html);
      console.log('[eBay Search] Extracted prices:', prices);

      return {
        prices,
        median: this.calculateMedian(prices),
        min: prices.length > 0 ? Math.min(...prices) : null,
        max: prices.length > 0 ? Math.max(...prices) : null,
        compCount: prices.length,
        currentPrice: null,
        source: 'ebay'
      };
    } catch (error) {
      console.error('[eBay Search] Error:', error);
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
    const prices = [];

    console.log('[Price Extract] Processing URLs for prices', {
      urlCount: urls.length,
      site: site
    });

    for (const url of urls) {
      try {
        // For now, extract price from URL if possible (common in eBay/Amazon URLs)
        const priceFromUrl = this.extractPriceFromUrl(url);
        if (priceFromUrl) {
          console.log('[Price Extract] Found price in URL:', {
            url: url,
            price: priceFromUrl
          });
          prices.push(priceFromUrl);
        }
      } catch (error) {
        console.error('[Price Extract] Error extracting price from URL:', error);
      }
    }

    console.log('[Price Extract] Prices from URLs:', prices);

    // If we couldn't get prices from URLs, try fetching a few pages
    if (prices.length < 3 && urls.length > 0) {
      console.log('[Price Extract] Not enough prices from URLs, fetching pages...');
      const fetchedPrices = await this.fetchPricesFromPages(urls.slice(0, 3), site);
      console.log('[Price Extract] Prices from fetched pages:', fetchedPrices);
      prices.push(...fetchedPrices);
    }

    const filtered = [...new Set(prices)].filter(p => p > 0 && p < 100000);
    console.log('[Price Extract] Final filtered prices:', filtered);
    return filtered;
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
    const prices = [];

    console.log('[Fetch Pages] Fetching prices from pages', {
      urls: urls,
      site: site
    });

    for (const url of urls) {
      try {
        console.log('[Fetch Pages] Fetching:', url);
        const response = await fetch(url);
        const html = await response.text();
        console.log('[Fetch Pages] Response HTML length:', html.length);

        const extracted = site.includes('ebay')
          ? this.extractEbayPrices(html)
          : this.extractAmazonPrices(html);

        console.log('[Fetch Pages] Extracted prices from page:', extracted);
        prices.push(...extracted);
      } catch (error) {
        console.error('[Fetch Pages] Error fetching page:', url, error);
      }
    }

    const result = prices.slice(0, 10);
    console.log('[Fetch Pages] Final page prices:', result);
    return result;
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
      const prices = await this.extractPricesFromUrls(urls, 'ebay.com');

      return {
        prices,
        avgPrice: prices.length > 0 ? this.calculateAverage(prices) : null,
        median: this.calculateMedian(prices),
        count: prices.length,
        source: 'ebay_sold'
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
      source: 'ebay_sold'
    };
  }


  /**
   * Extract prices from eBay search results HTML
   */
  static extractEbayPrices(html) {
    const prices = [];

    // eBay price patterns
    const priceRegex = /\$([0-9,]+\.?\d{0,2})/g;
    const matches = html.match(priceRegex);

    if (matches) {
      matches.forEach(match => {
        const price = parseFloat(match.replace(/[$,]/g, ''));
        if (price > 0 && price < 100000) { // Sanity check
          prices.push(price);
        }
      });
    }

    // Deduplicate and limit to top 20
    return [...new Set(prices)].slice(0, 20);
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
      source: null
    };
  }
}
