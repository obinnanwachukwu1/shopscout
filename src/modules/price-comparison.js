/**
 * Price Comparison Module
 *
 * Fetches comparable prices using DuckDuckGo search
 * Amazon product -> search eBay via DuckDuckGo
 * eBay product -> search Amazon via DuckDuckGo
 */

const TITLE_STOP_WORDS = new Set([
  'the',
  'and',
  'with',
  'for',
  'from',
  'inch',
  'inches',
  'new',
  'sale',
  'best',
  'bundle',
  'pack',
  'set',
  'black',
  'white',
  'blue',
  'store',
  'free',
  'shipping',
  'edition',
  'latest',
  'model',
  'updated',
  'seller',
  'listing',
  'sealed',
  'amazon',
  'ebay',
  'official'
]);

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
      return await this.searchViaDuckDuckGo(searchQuery, 'ebay.com', productData);
    } else {
      return await this.searchViaDuckDuckGo(searchQuery, 'amazon.com', productData);
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
    return await this.searchEbaySoldListings(searchQuery, productData);
  }

  /**
   * Search via DuckDuckGo with site filter
   */
  static async searchViaDuckDuckGo(query, site, productData) {
    try {
      console.log('[Price Search] Attempting direct site search instead of DuckDuckGo');

      // Use direct site search instead of DuckDuckGo
      if (site.includes('ebay')) {
        return await this.searchEbayDirect(query, productData);
      } else if (site.includes('amazon')) {
        return await this.searchAmazonDirect(query, productData);
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
  static async searchAmazonDirect(query, productData) {
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
      let listingComparables = this.extractAmazonListingSummaries(html);
      const derivedFromPrices = listingComparables.length === 0 && prices.length > 0;

      if (derivedFromPrices) {
        listingComparables = prices
          .filter((value) => typeof value === 'number' && value > 0 && value < 100000)
          .slice(0, 6)
          .map((value, index) =>
            this.buildComparableEntry({
              url: `${searchUrl}#price-only-${index}`,
              priceValue: value,
              site: 'amazon',
              source: 'price-only',
              title: `${productData?.title || query} (similar listing)`,
              description: 'Constructed from Amazon search price results (fallback).'
            })
          )
          .filter(Boolean);
      }

      console.log('[Amazon Search] Extracted prices:', prices);
      console.log('[Amazon Search] Listing comparables:', listingComparables.length);

      const filterResult = this.filterComparablesByIdentity(listingComparables, productData);
      if (derivedFromPrices && filterResult.filtered.length) {
        if (filterResult.quality !== 'identifier') {
          filterResult.quality = 'fallback';
        }
        filterResult.details = filterResult.details
          ? `${filterResult.details} (price-only fallback)`
          : 'Price-only fallback comparables were used.';
      }
      const filteredComparables = filterResult.filtered;

      if (!filteredComparables.length) {
        const baseDescription = derivedFromPrices
          ? 'Structured listings unavailable; using price-only fallback entries.'
          : null;
        const matchDescription = [baseDescription, filterResult.details].filter(Boolean).join(' ');
        console.log('[Amazon Search] No comparables after filtering:', filterResult.details);
        return this.getEmptyPriceData({
          source: 'amazon',
          matchQuality: filterResult.quality,
          matchDescription,
          mismatchWarning:
            filterResult.quality === 'weak' || filterResult.quality === 'fallback' || derivedFromPrices
              ? 'Comparable matches are approximate; treat this price comparison cautiously.'
              : 'No close Amazon listings matched this product.'
        });
      }

      const priceValues = filteredComparables
        .map(item => item.priceValue)
        .filter(value => typeof value === 'number' && value > 0 && value < 100000);

      if (!priceValues.length) {
        console.log('[Amazon Search] No usable prices from filtered comparables');
        return this.getEmptyPriceData({
          source: 'amazon',
          matchQuality: filterResult.quality,
          matchDescription: filterResult.details,
          mismatchWarning: 'Unable to extract prices from matching Amazon listings.'
        });
      }

      const uniquePrices = [...new Set(priceValues)];
      const range = this.calculateIqrRange(uniquePrices);
      const pricesForStats = range.filtered.length ? range.filtered : uniquePrices;

      const baseDescription = derivedFromPrices
        ? 'Structured listings unavailable; using price-only fallback entries.'
        : null;
      const combinedDescription = [baseDescription, filterResult.details].filter(Boolean).join(' ');

      return {
        prices: pricesForStats,
        median: this.calculateMedian(pricesForStats),
        min: range.min,
        max: range.max,
        compCount: filteredComparables.length || pricesForStats.length,
        currentPrice: null,
        source: 'amazon',
        comparables: filteredComparables,
        matchQuality: filterResult.quality,
        matchDescription: combinedDescription || filterResult.details,
        mismatchWarning:
          filterResult.quality === 'weak'
            ? 'Only loosely matching Amazon listings were found.'
            : filterResult.quality === 'fallback'
              ? 'Comparable matches are approximate; treat this price comparison cautiously.'
              : null
      };
    } catch (error) {
      console.error('[Amazon Search] Error:', error);
      return this.getEmptyPriceData();
    }
  }

  /**
   * Search eBay directly
   */
  static async searchEbayDirect(query, productData) {
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

      console.log('[eBay Search] Extracted prices:', prices);
      console.log('[eBay Search] Listing comparables:', listingComparables.length);

      const filterResult = this.filterComparablesByIdentity(listingComparables, productData);
      const filteredComparables = filterResult.filtered;

      if (!filteredComparables.length) {
        console.log('[eBay Search] No comparables after filtering:', filterResult.details);
        return await this.searchEbayViaDuckDuckGo(query, productData, {
          fallbackReason: filterResult.details,
          matchQuality: filterResult.quality
        });
      }

      const isValidPrice = (value) => typeof value === 'number' && value > 0 && value < 100000;
      const priceValues = filteredComparables.map(item => item.priceValue).filter(isValidPrice);
      if (!priceValues.length) {
        console.log('[eBay Search] No usable prices from filtered comparables');
        return await this.searchEbayViaDuckDuckGo(query, productData, {
          fallbackReason: 'Filtered eBay listings had no price values.',
          matchQuality: filterResult.quality
        });
      }

      const uniquePrices = [...new Set(priceValues)];
      const range = this.calculateIqrRange(uniquePrices);
      const pricesForStats = range.filtered.length ? range.filtered : uniquePrices;

      const buyNowComparables = filteredComparables.filter(
        item => item?.listingFormat && item.listingFormat !== 'auction'
      );
      const auctionComparables = filteredComparables.filter(item => item?.listingFormat === 'auction');
      const unknownComparables = filteredComparables.filter(item => !item?.listingFormat);
      const usedAuctionPrices = buyNowComparables.length === 0 && auctionComparables.length > 0;

      return {
        prices: pricesForStats,
        median: this.calculateMedian(pricesForStats),
        min: range.min,
        max: range.max,
        compCount: filteredComparables.length || pricesForStats.length,
        currentPrice: null,
        source: 'ebay',
        comparables: filteredComparables,
        formatBreakdown: {
          buyItNow: buyNowComparables.length,
          auction: auctionComparables.length,
          unknown: unknownComparables.length
        },
        usedAuctionPrices,
        matchQuality: filterResult.quality,
        matchDescription: filterResult.details,
        mismatchWarning:
          filterResult.quality === 'weak'
            ? 'Only loosely matching eBay listings were found.'
            : null
      };
    } catch (error) {
      console.error('[eBay Search] Error:', error);
      return await this.searchEbayViaDuckDuckGo(query, productData);
    }
  }

  static async searchEbayViaDuckDuckGo(query, productData, options = {}) {
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
      const { prices, comparables } = await this.extractPricesFromUrls(urls, 'ebay.com', productData);

      const filterResult = this.filterComparablesByIdentity(comparables, productData);
      const filteredComparables = filterResult.filtered;
      const combinedQuality = filterResult.quality || options.matchQuality || 'none';

      if (!filteredComparables.length) {
        return this.getEmptyPriceData({
          source: 'ebay',
          matchQuality: combinedQuality,
          matchDescription: filterResult.details || options.fallbackReason || 'No comparable listings matched this product.',
          mismatchWarning: 'Unable to find matching eBay listings for this product.'
        });
      }

      const priceValues = filteredComparables
        .map(item => item.priceValue)
        .filter(value => typeof value === 'number' && value > 0 && value < 100000);

      if (!priceValues.length) {
        return this.getEmptyPriceData({
          source: 'ebay',
          matchQuality: combinedQuality,
          matchDescription: filterResult.details || 'No price data extracted from matching listings.',
          mismatchWarning: 'Matching listings were found, but no prices were available.'
        });
      }

      const uniquePrices = [...new Set(priceValues)];
      const range = this.calculateIqrRange(uniquePrices);
      const pricesForStats = range.filtered.length ? range.filtered : uniquePrices;

      const buyNowCount = filteredComparables.filter(item => item?.listingFormat && item.listingFormat !== 'auction').length;
      const auctionCount = filteredComparables.filter(item => item?.listingFormat === 'auction').length;
      const unknownCount = filteredComparables.length - buyNowCount - auctionCount;

      return {
        prices: pricesForStats,
        median: this.calculateMedian(pricesForStats),
        min: range.min,
        max: range.max,
        compCount: filteredComparables.length,
        currentPrice: null,
        source: 'ebay',
        comparables: filteredComparables,
        formatBreakdown: {
          buyItNow: buyNowCount,
          auction: auctionCount,
          unknown: unknownCount
        },
        usedAuctionPrices: buyNowCount === 0 && auctionCount > 0,
        matchQuality: combinedQuality,
        matchDescription:
          filterResult.details || options.fallbackReason || 'Comparable listings sourced via DuckDuckGo.',
        mismatchWarning:
          combinedQuality === 'weak'
            ? 'Only approximate comparables were found; treat these prices cautiously.'
            : null
      };
    } catch (error) {
      console.error('[eBay DDG Fallback] Error:', error);
      return this.getEmptyPriceData({
        source: 'ebay',
        matchQuality: options.matchQuality || 'none',
        matchDescription: 'DuckDuckGo fallback failed.',
        mismatchWarning: 'Unable to retrieve eBay comparables at this time.'
      });
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
  static async extractPricesFromUrls(urls, site, productData) {
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

  static buildComparableEntry({
    url,
    priceValue,
    site,
    source,
    title,
    condition,
    description,
    listingFormat,
    bidCount,
    timeLeft
  }) {
    if (!url || typeof priceValue !== 'number' || !isFinite(priceValue)) {
      return null;
    }

    const hostname = this.getHostname(url) || site || 'marketplace';
    const resolvedTitle = title?.trim() || this.deriveComparableTitle(url, hostname);
    const normalizedListingFormat = listingFormat || null;
    const normalizedBidCount =
      typeof bidCount === 'number' && Number.isFinite(bidCount) ? Math.max(0, Math.round(bidCount)) : null;
    const normalizedTimeLeft =
      typeof timeLeft === 'string' && timeLeft.trim().length ? timeLeft.trim() : null;

    return {
      title: resolvedTitle,
      url,
      priceValue,
      priceLabel: `$${priceValue.toFixed(2)}`,
      condition: condition || '',
      source: hostname,
      description: description || '',
      type: 'listing',
      origin: source || 'listing',
      listingFormat: normalizedListingFormat,
      bidCount: normalizedBidCount,
      timeLeft: normalizedTimeLeft,
      isAuction: normalizedListingFormat === 'auction'
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
  static async searchEbaySoldListings(query, productData) {
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
      const { prices, comparables } = await this.extractPricesFromUrls(urls, 'ebay.com', productData);

      const filterResult = this.filterComparablesByIdentity(comparables, productData);
      const filteredComparables = filterResult.filtered.length ? filterResult.filtered : comparables;
      const priceValues = filteredComparables
        .map(item => item.priceValue || item.price)
        .filter(value => typeof value === 'number' && value > 0 && value < 100000);

      return {
        prices: priceValues,
        avgPrice: priceValues.length > 0 ? this.calculateAverage(priceValues) : null,
        median: this.calculateMedian(priceValues),
        count: priceValues.length,
        source: 'ebay_sold',
        comparables: filteredComparables
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
          const detailNodes = node.querySelectorAll(
            '.s-item__detail--primary, .s-item__detail--secondary, .s-item__subtitle, .s-item__time-left'
          );
          const detailTexts = Array.from(detailNodes)
            .map(el => el.textContent)
            .filter(Boolean)
            .map(text => text.replace(/\s+/g, ' ').trim());
          const combinedDetailText = detailTexts.join(' | ');
          const detailLower = combinedDetailText.toLowerCase();

          const url = linkEl?.href;
          const priceValue = this.extractPriceFromText(priceEl?.textContent || '');
          const priceText = priceEl?.textContent || '';

          let listingFormat = null;
          if (/\b(?:\d+\s+)?bid/i.test(detailLower) || /auction/i.test(detailLower) || /bids?/i.test(priceText)) {
            listingFormat = 'auction';
          } else if (/buy it now/i.test(detailLower)) {
            listingFormat = 'buy_it_now';
          } else if (/best offer/i.test(detailLower)) {
            listingFormat = 'best_offer';
          }

          if (!listingFormat && /best offer/i.test(priceText)) {
            listingFormat = 'best_offer';
          }

          const bidMatch = combinedDetailText.match(/(\d+)\s+bids?/i) || priceText.match(/(\d+)\s+bids?/i);
          const bidCount = bidMatch ? parseInt(bidMatch[1], 10) : null;

          if (listingFormat !== 'auction' && typeof bidCount === 'number') {
            listingFormat = 'auction';
          }

          let timeLeft =
            detailTexts.find(text => /time left/i.test(text) || /ends in/i.test(text)) ||
            node.querySelector('.s-item__time-left')?.textContent ||
            null;
          if (timeLeft) {
            timeLeft = timeLeft.replace(/time left\s*/i, '').replace(/ends in\s*/i, '').trim();
          }

          if (url && priceValue) {
            const entry = this.buildComparableEntry({
              url,
              priceValue,
              site: 'ebay',
              source: 'search-result',
              title: titleEl?.textContent?.trim(),
              condition: conditionEl?.textContent?.trim(),
              listingFormat,
              bidCount,
              timeLeft
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
  static getEmptyPriceData(extra = {}) {
    return {
      prices: [],
      median: null,
      min: null,
      max: null,
      compCount: 0,
      currentPrice: null,
      source: extra.source || null,
      comparables: [],
      formatBreakdown: {
        buyItNow: 0,
        auction: 0,
        unknown: 0
      },
      usedAuctionPrices: false,
      matchQuality: extra.matchQuality || 'none',
      matchDescription: extra.matchDescription || null,
      mismatchWarning: extra.mismatchWarning || null
    };
  }

  static collectProductIdentifiers(productData) {
    const identifiers = new Set();
    const addValue = (value) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach(addValue);
        return;
      }
      const fragments = value.toString().split(/[\s,\/|]+/);
      fragments.forEach((fragment) => {
        const normalized = fragment.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (!normalized) return;
        if (normalized.length < 6) return;
        identifiers.add(normalized);
      });
    };

    if (!productData || typeof productData !== 'object') {
      return identifiers;
    }

    addValue(productData.asin);

    if (productData.identifiers && typeof productData.identifiers === 'object') {
      Object.values(productData.identifiers).forEach(addValue);
    }

    const specificsSources = [
      productData.specs,
      productData.itemSpecifics,
      productData.attributes
    ].filter(Boolean);

    specificsSources.forEach((obj) => {
      if (!obj || typeof obj !== 'object') return;
      Object.entries(obj).forEach(([key, value]) => {
        const normalizedKey = key.toString().toLowerCase();
        if (/(isbn|asin|upc|ean|gtin|sku|mpn|model)/.test(normalizedKey)) {
          addValue(value);
        }
      });
    });

    return identifiers;
  }

  static comparableContainsIdentifier(entry, identifiers) {
    if (!identifiers || identifiers.size === 0 || !entry) return false;
    const haystack = [
      entry.title,
      entry.url,
      entry.description
    ]
      .filter(Boolean)
      .map((str) => str.toString().toUpperCase());

    for (const identifier of identifiers) {
      if (!identifier) continue;
      if (haystack.some((segment) => segment.includes(identifier))) {
        return true;
      }
    }
    return false;
  }

  static tokenizeTitleForMatch(title) {
    if (!title || typeof title !== 'string') return [];
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token));
  }

  static calculateTitleSimilarity(targetTokens, candidateTokens) {
    if (!targetTokens.length || !candidateTokens.length) {
      return 0;
    }

    const targetSet = new Set(targetTokens);
    const candidateSet = new Set(candidateTokens);
    let intersection = 0;

    candidateSet.forEach((token) => {
      if (targetSet.has(token)) {
        intersection += 1;
      }
    });

    const union = new Set([...targetSet, ...candidateSet]).size;
    if (union === 0) return 0;
    return intersection / union;
  }

  static filterComparablesByIdentity(comparables, productData) {
    if (!Array.isArray(comparables) || comparables.length === 0) {
      return { filtered: [], quality: 'none', details: 'No comparable listings to evaluate.' };
    }

    const identifiers = this.collectProductIdentifiers(productData);
    const withMetadata = comparables.map((entry) => ({
      entry,
      hasIdentifier: identifiers.size ? this.comparableContainsIdentifier(entry, identifiers) : false,
      tokens: this.tokenizeTitleForMatch(entry.title || '')
    }));

    if (identifiers.size) {
      const matches = withMetadata.filter((item) => item.hasIdentifier);
      if (matches.length) {
        return {
          filtered: matches.map((item) => item.entry),
          quality: 'identifier',
          details: `Matched ${matches.length} listings using identifier(s): ${Array.from(identifiers).slice(0, 4).join(', ')}`
        };
      }
    }

    const targetTitleTokens = this.tokenizeTitleForMatch(productData?.title || '');
    if (targetTitleTokens.length) {
      withMetadata.forEach((item) => {
        item.similarity = this.calculateTitleSimilarity(targetTitleTokens, item.tokens);
      });

      withMetadata.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
      const bestScore = withMetadata[0]?.similarity || 0;

      const strongThreshold = bestScore >= 0.75 ? 0.6 : 0.45;
      const strongMatches = withMetadata.filter((item) => (item.similarity || 0) >= strongThreshold);

      if (strongMatches.length) {
        return {
          filtered: strongMatches.slice(0, 6).map((item) => item.entry),
          quality: bestScore >= 0.75 ? 'title_strong' : 'title',
          details: `Matched by title similarity (best ${(bestScore * 100).toFixed(0)}% overlap).`
        };
      }

      const weakMatches = withMetadata.filter((item) => (item.similarity || 0) >= 0.25);
      if (weakMatches.length) {
        return {
          filtered: weakMatches.slice(0, 4).map((item) => item.entry),
          quality: 'weak',
          details: 'Only loosely matching titles found; prices may be approximate.'
        };
      }
    }

    const fallbackComparables = withMetadata
      .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
      .slice(0, Math.min(4, withMetadata.length))
      .map((item) => item.entry);

    if (fallbackComparables.length) {
      return {
        filtered: fallbackComparables,
        quality: 'fallback',
        details: 'No identifier or strong title overlap; using closest search results as fallback.'
      };
    }

    return {
      filtered: [],
      quality: 'none',
      details: 'No comparable listings matched this product by identifier or title.'
    };
  }
}
