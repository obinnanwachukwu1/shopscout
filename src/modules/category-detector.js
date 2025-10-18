/**
 * Category Detection Module
 *
 * Detects product category from title and metadata,
 * then selects the appropriate analysis mode
 */

export class CategoryDetector {
  /**
   * Detect category from product data
   */
  static detect(productData) {
    const title = productData.title?.toLowerCase() || '';
    const categories = productData.categories?.map(c => c.toLowerCase()) || [];
    const allText = [title, ...categories].join(' ');

    // Check each mode in priority order
    if (this.isCollectible(allText, categories)) {
      return { name: 'Collectibles', mode: 'COLLECTIBLES' };
    }

    if (this.isFashion(allText, categories)) {
      return { name: 'Fashion & Apparel', mode: 'FASHION' };
    }

    if (this.isBeauty(allText, categories)) {
      return { name: 'Beauty & Personal Care', mode: 'BEAUTY' };
    }

    if (this.isElectronics(allText, categories)) {
      return { name: 'Electronics', mode: 'ELECTRONICS' };
    }

    // Default to generic home goods
    return { name: 'General Products', mode: 'GENERIC_HOME_GOODS' };
  }

  /**
   * Check if product is a collectible
   */
  static isCollectible(text, categories) {
    const keywords = [
      'collectible', 'vintage', 'antique', 'rare',
      'limited edition', 'signed', 'autograph',
      'trading card', 'memorabilia', 'comic book',
      'coins', 'stamps', 'art print', 'figure',
      'action figure', 'funko pop'
    ];

    const categoryMatches = [
      'collectibles', 'antiques', 'art', 'coins',
      'stamps', 'trading cards', 'memorabilia'
    ];

    return this.hasKeywords(text, keywords) || this.hasCategory(categories, categoryMatches);
  }

  /**
   * Check if product is fashion/apparel
   */
  static isFashion(text, categories) {
    const keywords = [
      'shirt', 't-shirt', 'pants', 'jeans', 'dress',
      'jacket', 'coat', 'sweater', 'hoodie', 'shoes',
      'sneakers', 'boots', 'sandals', 'skirt', 'shorts',
      'blouse', 'suit', 'tie', 'socks', 'hat', 'cap',
      'gloves', 'scarf', 'belt', 'clothing', 'apparel'
    ];

    const categoryMatches = [
      'clothing', 'apparel', 'fashion', 'shoes',
      'accessories', 'jewelry', 'watches', 'handbags'
    ];

    return this.hasKeywords(text, keywords) || this.hasCategory(categories, categoryMatches);
  }

  /**
   * Check if product is beauty/personal care
   */
  static isBeauty(text, categories) {
    const keywords = [
      'serum', 'cream', 'moisturizer', 'cleanser',
      'toner', 'mask', 'makeup', 'lipstick', 'foundation',
      'concealer', 'eyeshadow', 'mascara', 'shampoo',
      'conditioner', 'lotion', 'sunscreen', 'skincare',
      'haircare', 'perfume', 'fragrance', 'cologne'
    ];

    const categoryMatches = [
      'beauty', 'cosmetics', 'skincare', 'makeup',
      'personal care', 'fragrance', 'hair care'
    ];

    return this.hasKeywords(text, keywords) || this.hasCategory(categories, categoryMatches);
  }

  /**
   * Check if product is electronics
   */
  static isElectronics(text, categories) {
    const keywords = [
      'laptop', 'computer', 'phone', 'smartphone', 'tablet',
      'headphones', 'earbuds', 'speaker', 'monitor', 'tv',
      'television', 'camera', 'drone', 'smartwatch', 'console',
      'playstation', 'xbox', 'nintendo', 'router', 'modem',
      'keyboard', 'mouse', 'hard drive', 'ssd', 'ram',
      'processor', 'gpu', 'graphics card', 'motherboard'
    ];

    const categoryMatches = [
      'electronics', 'computers', 'tablets', 'cell phones',
      'accessories', 'tv & video', 'cameras', 'audio',
      'video games', 'wearable technology', 'smart home'
    ];

    return this.hasKeywords(text, keywords) || this.hasCategory(categories, categoryMatches);
  }

  /**
   * Helper: Check if text contains any keywords
   */
  static hasKeywords(text, keywords) {
    return keywords.some(keyword => text.includes(keyword));
  }

  /**
   * Helper: Check if categories contain any matches
   */
  static hasCategory(categories, matches) {
    return categories.some(cat =>
      matches.some(match => cat.includes(match))
    );
  }
}
