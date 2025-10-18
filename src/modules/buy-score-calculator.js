/**
 * Buy Score Calculator Module
 *
 * Calculates the weighted Buy Score (0-10) based on:
 * - Price fairness
 * - Review sentiment
 * - Seller trust
 * - Specification quality
 */

export class BuyScoreCalculator {
  /**
   * Calculate full Buy Score (for Electronics and Generic modes)
   */
  static calculate({ productData, priceData, specAnalysis, sentimentAnalysis }) {
    // Weights for each component
    const weights = {
      price: 0.4,
      sentiment: 0.3,
      seller: 0.2,
      spec: 0.1
    };

    // Calculate individual scores (0-1 range)
    const priceScore = this.calculatePriceScore(productData, priceData);
    const sentimentScore = this.calculateSentimentScore(productData);
    const sellerScore = this.calculateSellerScore(productData);
    const specScore = this.calculateSpecScore(specAnalysis);

    // Weighted average
    const total = (
      weights.price * priceScore +
      weights.sentiment * sentimentScore +
      weights.seller * sellerScore +
      weights.spec * specScore
    ) * 10;

    return {
      total: Math.max(0, Math.min(10, total)),
      breakdown: {
        price: priceScore,
        sentiment: sentimentScore,
        seller: sellerScore,
        spec: specScore
      },
      weights
    };
  }

  /**
   * Calculate fallback Buy Score (for Generic mode with no exact matches)
   */
  static calculateFallback({ productData, priceData, sentimentAnalysis }) {
    const weights = {
      price: 0.5,
      sentiment: 0.4,
      seller: 0.1
    };

    // Use percentile-based price score
    const priceScore = this.calculateFallbackPriceScore(productData, priceData);
    const sentimentScore = this.calculateSentimentScore(productData);
    const sellerScore = this.calculateSellerScore(productData);

    const total = (
      weights.price * priceScore +
      weights.sentiment * sentimentScore +
      weights.seller * sellerScore
    ) * 10;

    return {
      total: Math.max(0, Math.min(10, total)),
      breakdown: {
        price: priceScore,
        sentiment: sentimentScore,
        seller: sellerScore
      },
      weights,
      isFallback: true
    };
  }

  /**
   * Calculate price score (0-1)
   * Score of 0.5 = average price
   * Score > 0.5 = better than average
   * Score < 0.5 = worse than average
   */
  static calculatePriceScore(productData, priceData) {
    if (!productData.price?.value || !priceData?.median) {
      return 0.5; // Neutral score if no data
    }

    const currentPrice = productData.price.value;
    const medianPrice = priceData.median;

    // Score = 0.5 + (median - current) / median
    // If current = median, score = 0.5
    // If current < median (cheaper), score > 0.5
    // If current > median (more expensive), score < 0.5
    const score = 0.5 + (medianPrice - currentPrice) / medianPrice;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Calculate fallback price score using percentile rank
   */
  static calculateFallbackPriceScore(productData, priceData) {
    if (!productData.price?.value || !priceData?.prices?.length) {
      return 0.5;
    }

    const currentPrice = productData.price.value;
    const prices = priceData.prices.sort((a, b) => a - b);

    // Find rank (how many prices are lower)
    const rank = prices.filter(p => p <= currentPrice).length - 1;

    // Percentile score (lower rank = better price = higher score)
    const percentile = 1.0 - (rank / (prices.length - 1));

    return Math.max(0, Math.min(1, percentile));
  }

  /**
   * Calculate sentiment score (0-1)
   * Simple normalization of star rating
   */
  static calculateSentimentScore(productData) {
    if (!productData.rating || productData.rating === 0) {
      return 0.5; // Neutral if no rating
    }

    // Normalize 0-5 scale to 0-1
    return productData.rating / 5.0;
  }

  /**
   * Calculate seller score (0-1)
   * Combines seller rating with confidence modifier based on feedback count
   */
  static calculateSellerScore(productData) {
    // Amazon doesn't have seller ratings on product pages
    if (productData.site === 'amazon') {
      return 0.8; // Default high score for Amazon
    }

    // eBay seller scoring
    if (productData.seller) {
      let rating = 0;
      const ratingText = productData.seller.rating?.replace('%', '');
      if (ratingText) {
        rating = parseFloat(ratingText) / 100;
      }

      const feedbackCount = parseInt(productData.seller.feedbackCount || '0');

      // Confidence modifier: approaches 1.0 as feedback increases
      const confidence = Math.min(1, feedbackCount / 500);

      return rating * confidence;
    }

    return 0.5; // Neutral if no seller data
  }

  /**
   * Calculate spec score (0-1)
   * Penalty-based: starts at 1.0, reduced by red flags
   */
  static calculateSpecScore(specAnalysis) {
    if (!specAnalysis) {
      return 1.0; // Perfect score if no analysis
    }

    let score = 1.0;

    // Penalty for conflicts (0.4 per conflict, max 2)
    const conflicts = specAnalysis.conflicts?.length || 0;
    score -= Math.min(conflicts * 0.4, 0.8);

    // Penalty for red flags (0.2 per flag, max 2)
    const redFlags = specAnalysis.redFlags?.length || 0;
    score -= Math.min(redFlags * 0.2, 0.4);

    // Penalty for newer model available
    if (specAnalysis.hasNewerModel) {
      score -= 0.3;
    }

    return Math.max(0, Math.min(1, score));
  }
}
