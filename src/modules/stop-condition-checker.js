/**
 * Stop Condition Checker Module
 *
 * Checks if analysis should stop due to:
 * - Out of stock
 * - Variations not selected (price ranges)
 * - Listing ended
 * - International currency
 */

export class StopConditionChecker {
  /**
   * Check for stop conditions
   */
  static check(productData) {
    // Check for out of stock
    if (this.isOutOfStock(productData)) {
      return {
        shouldStop: true,
        reason: 'Out of Stock',
        message: 'This product is currently unavailable. Analysis cannot proceed.'
      };
    }

    // Check for unselected variations
    if (this.hasUnselectedVariations(productData)) {
      return {
        shouldStop: true,
        reason: 'Variation Selection Required',
        message: 'Please select a size, color, or style variant before analysis can begin.'
      };
    }

    // Check for price range (indicates variations)
    if (this.hasPriceRange(productData)) {
      return {
        shouldStop: true,
        reason: 'Price Range Detected',
        message: 'This product has multiple variants. Please select specific options to see the exact price.'
      };
    }

    // Check for listing ended (eBay)
    if (this.isListingEnded(productData)) {
      return {
        shouldStop: true,
        reason: 'Listing Ended',
        message: 'This listing has ended and is no longer available for purchase.'
      };
    }

    // Check for international currency
    if (this.isInternationalCurrency(productData)) {
      return {
        shouldStop: true,
        reason: 'International Currency',
        message: 'This product uses a non-USD currency. Price comparison features are disabled.'
      };
    }

    // Check for new product (no reviews)
    if (this.isNewProduct(productData)) {
      return {
        shouldStop: false, // Don't stop, but flag it
        reason: 'New Product',
        message: 'This is a new product with no reviews yet. Analysis will be limited.',
        isWarning: true
      };
    }

    return { shouldStop: false };
  }

  /**
   * Check if product is out of stock
   */
  static isOutOfStock(productData) {
    // Amazon
    if (productData.availability?.inStock === false) {
      return true;
    }

    const availText = productData.availability?.message?.toLowerCase() || '';
    if (availText.includes('out of stock') || availText.includes('unavailable')) {
      return true;
    }

    // eBay - check if listing has ended
    if (productData.site === 'ebay' && productData.listingStatus === 'ended') {
      return true;
    }

    return false;
  }

  /**
   * Check if variations are not selected
   */
  static hasUnselectedVariations(productData) {
    if (productData.variations?.hasVariations) {
      // If there are variations but no specific price, user hasn't selected
      if (!productData.price?.value) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if price is a range
   */
  static hasPriceRange(productData) {
    if (productData.price?.isRange) {
      return true;
    }

    const priceText = productData.price?.formatted?.toLowerCase() || '';
    if (priceText.includes(' - ') || priceText.includes(' to ')) {
      return true;
    }

    return false;
  }

  /**
   * Check if listing has ended
   */
  static isListingEnded(productData) {
    if (productData.site === 'ebay') {
      // Check for ended listing indicators
      const title = productData.title?.toLowerCase() || '';
      if (title.includes('listing ended') || title.includes('no longer available')) {
        return true;
      }

      if (productData.listingStatus === 'ended') {
        return true;
      }
    }
    return false;
  }

  /**
   * Check for international currency
   */
  static isInternationalCurrency(productData) {
    const currency = productData.price?.currency;

    // Normalize currency string and check for USD
    const normalizedCurrency = currency?.replace(/\s+/g, '').toUpperCase();

    // Accept USD, $, and "US $" (eBay format) as valid USD currency
    if (normalizedCurrency && normalizedCurrency !== 'USD' && normalizedCurrency !== '$' && normalizedCurrency !== 'US$') {
      return true;
    }

    const formatted = productData.price?.formatted || '';
    // Check for common non-USD symbols (but not $)
    const nonUSDSymbols = ['€', '£', '¥', 'CAD', 'AUD', 'EUR', 'GBP'];
    if (nonUSDSymbols.some(symbol => formatted.includes(symbol))) {
      return true;
    }

    return false;
  }

  /**
   * Check if product is new (no reviews)
   */
  static isNewProduct(productData) {
    return productData.reviewCount === 0 || !productData.reviews?.length;
  }
}
