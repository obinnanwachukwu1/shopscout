/**
 * Buy Score Calculator Module
 *
 * Calculates the weighted Buy Score (0-10) based on:
 * - Price fairness
 * - Review sentiment
 * - Seller trust
 * - Specification quality
 */

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const parsePercentValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (!value) return null;
  const match = value.toString().match(/([\d.,]+)/);
  if (!match) return null;
  const parsed = parseFloat(match[1].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCountValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (!value) return null;

  const normalized = value.toString().trim().toLowerCase();
  const match = normalized.match(/([\d.,]+)\s*([km]?)/);
  if (!match) return null;

  let amount = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;

  const suffix = match[2];
  if (suffix === 'k') {
    amount *= 1_000;
  } else if (suffix === 'm') {
    amount *= 1_000_000;
  }

  return amount;
};

const deriveAuctionConfidence = (auctionInfo) => {
  if (!auctionInfo) return 1;

  const bidCount = Number.isFinite(auctionInfo.bidCount) ? auctionInfo.bidCount : parseCountValue(auctionInfo.bidCount) || 0;
  const bidFactor = Math.min(1, bidCount / 6);

  const timeLeftText = (auctionInfo.timeLeft || '').toString().toLowerCase();
  let timeFactor = 1;
  if (timeLeftText.includes('day')) {
    timeFactor = 0.35;
  } else if (timeLeftText.includes('hour') || timeLeftText.includes('hr')) {
    timeFactor = 0.6;
  } else if (timeLeftText.includes('min')) {
    timeFactor = 0.8;
  } else if (timeLeftText.includes('sec')) {
    timeFactor = 0.9;
  }

  const confidence = Math.max(0.25, Math.min(1, 0.5 * bidFactor + 0.5 * timeFactor));
  return confidence;
};

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
    const specScore = this.calculateSpecScore(specAnalysis, productData);

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
    const auctionInfo = productData?.listing?.auction || null;
    const effectivePrice =
      auctionInfo?.currentBid?.amount ??
      auctionInfo?.currentBid?.value ??
      productData.price?.value ??
      null;
    const medianPrice = priceData?.median;

    if (!effectivePrice || !medianPrice || medianPrice <= 0) {
      return 0.5; // Neutral score if no data
    }

    const currentPrice = effectivePrice;

    // Score = 0.5 + (median - current) / median
    // If current = median, score = 0.5
    // If current < median (cheaper), score > 0.5
    // If current > median (more expensive), score < 0.5
    let score = 0.5 + (medianPrice - currentPrice) / medianPrice;
    score = clamp01(score);
    score = this.adjustScoreForMatchQuality(score, priceData);

    if (auctionInfo) {
      const confidence = deriveAuctionConfidence(auctionInfo);
      score = 0.5 + (score - 0.5) * confidence;
    }

    return clamp01(score);
  }

  /**
   * Calculate fallback price score using percentile rank
   */
  static calculateFallbackPriceScore(productData, priceData) {
    if (!productData.price?.value || !priceData?.prices?.length) {
      return 0.5;
    }

    const auctionInfo = productData?.listing?.auction || null;
    const currentPrice =
      auctionInfo?.currentBid?.amount ??
      auctionInfo?.currentBid?.value ??
      productData.price.value;
    const prices = priceData.prices.sort((a, b) => a - b);

    // Find rank (how many prices are lower)
    const rank = prices.filter(p => p <= currentPrice).length - 1;
    const divisor = Math.max(1, prices.length - 1);

    // Percentile score (lower rank = better price = higher score)
    let percentile = 1.0 - (rank / divisor);
    percentile = clamp01(percentile);
    percentile = this.adjustScoreForMatchQuality(percentile, priceData);

    if (auctionInfo) {
      const confidence = deriveAuctionConfidence(auctionInfo);
      percentile = 0.5 + (percentile - 0.5) * confidence;
    }

    return clamp01(percentile);
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
      const seller = productData.seller;

      const percentSources = [
        seller.positivePercent,
        seller.ratingPercent,
        parsePercentValue(seller.rating),
        parsePercentValue(seller.ratingText)
      ].filter((value) => value != null && Number.isFinite(value));

      const ratingPercent = percentSources.length ? percentSources[0] : null;
      if (ratingPercent == null) {
        return 0.5;
      }

      const rating = clamp01(ratingPercent / 100);

      const countSources = [
        seller.feedbackCount,
        seller.feedback,
        seller.itemsSold,
        seller.totalSold
      ].filter((value) => value != null && value !== '');

      let feedbackCount = 0;
      if (countSources.length) {
        const parsed = parseCountValue(countSources[0]);
        if (parsed != null) {
          feedbackCount = parsed;
        }
      }

      // Confidence modifier: approaches 1.0 as feedback increases
      const confidence = Math.min(1, feedbackCount > 0 ? feedbackCount / 500 : 0.25);

      return clamp01(rating * Math.max(confidence, 0.25));
    }

    return 0.5; // Neutral if no seller data
  }

  /**
   * Calculate spec score (0-1)
   * Penalty-based: starts at 1.0, reduced by red flags
   */
  static calculateSpecScore(specAnalysis, productData = null) {
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

    if (productData?.condition) {
      const conditionText = productData.condition.toLowerCase();
      if (/grade\s*c/.test(conditionText)) {
        score -= 0.15;
      } else if (/grade\s*d|salvage/.test(conditionText)) {
        score -= 0.25;
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  static adjustScoreForMatchQuality(score, priceData) {
    const quality = priceData?.matchQuality || 'unknown';
    const qualityAdjustments = {
      identifier: 1,
      title_strong: 0.95,
      title: 0.8,
      weak: 0.55,
      fallback: 0.45,
      none: 0.45,
      unknown: 0.7
    };

    const adjustment = qualityAdjustments[quality] ?? qualityAdjustments.unknown;

    let adjusted = 0.5 + (score - 0.5) * adjustment;

    if (['weak', 'fallback', 'none'].includes(quality)) {
      adjusted = Math.min(adjusted, 0.58);
    }

    return Math.max(0, Math.min(1, adjusted));
  }
}
