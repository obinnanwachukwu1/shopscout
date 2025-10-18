/**
 * DealSense Module - Smart Auction & Negotiation Assistant for eBay
 *
 * Based on proven eBay bidding strategies:
 * - Last-second sniping (5-10 seconds before end)
 * - Odd-cent bid optimization (beat round-number bidders)
 * - Single decisive bid strategy (no nibbling)
 * - Research-based limits using sold comps
 * - Time-based competition analysis
 */

export class DealSense {
  /**
   * Analyze an eBay listing and generate smart recommendations
   */
  static analyze(productData, priceData) {
    if (!productData || productData.site !== 'ebay') {
      return null;
    }

    // Check for critical red flags first
    const redFlags = this.checkCriticalRedFlags(productData);
    if (redFlags.length > 0) {
      return {
        blocked: true,
        redFlags,
        message: 'DealSense blocked - critical issues detected',
        severity: 'critical'
      };
    }

    const afp = this.calculateAdjustedFairPrice(priceData);
    const listing = productData.listing || {};
    const hasAuction = !!listing.auction;
    const hasBestOffer = !!listing.bestOffer;

    if (!hasAuction && !hasBestOffer) {
      return null; // No auction or best offer - DealSense not applicable
    }

    const result = {
      afp,
      confidence: this.calculateConfidence(priceData),
      competitionScore: this.analyzeCompetition(productData, listing),
      listingQuality: this.analyzeListingQuality(productData),
      sellerSignals: this.analyzeSellerSignals(productData)
    };

    // CRITICAL: Only show ONE strategy - prioritize based on which saves more money
    // If both auction and best offer exist, choose the better strategy
    if (hasAuction && hasBestOffer) {
      // Auction is ending soon (< 24 hours) - prioritize sniping
      const auctionTiming = this.analyzeAuctionTiming(listing.auction);
      if (auctionTiming && auctionTiming.urgency !== 'low') {
        // Auction ending soon - use snipe strategy
        result.snipeBids = this.generateSnipeBids(afp, result.competitionScore, priceData);
        result.auctionTiming = auctionTiming;
        result.strategy = 'auction';
        result.strategyReason = 'Auction ending soon - snipe to win at best price';
      } else {
        // Auction has time remaining - compare current bid to best offer potential
        const currentBid = listing.auction?.currentBid?.amount || 0;
        const fairOfferEstimate = afp?.value ? afp.value * 0.78 : 0;

        if (fairOfferEstimate > 0 && fairOfferEstimate < currentBid) {
          // Best offer likely cheaper - use offer strategy
          result.offerTiers = this.generateBestOfferTiers(afp, result.sellerSignals, productData);
          result.negotiationMessages = this.generateNegotiationMessages(result.offerTiers, productData);
          result.strategy = 'offer';
          result.strategyReason = `Best Offer (~$${fairOfferEstimate.toFixed(0)}) likely cheaper than auction (current: $${currentBid.toFixed(2)})`;
        } else {
          // Auction likely better - use snipe strategy
          result.snipeBids = this.generateSnipeBids(afp, result.competitionScore, priceData);
          result.auctionTiming = auctionTiming;
          result.strategy = 'auction';
          result.strategyReason = 'Auction bidding likely to secure better price than offer';
        }
      }
    } else if (hasAuction) {
      result.snipeBids = this.generateSnipeBids(afp, result.competitionScore, priceData);
      result.auctionTiming = this.analyzeAuctionTiming(listing.auction);
      result.strategy = 'auction';
    } else if (hasBestOffer) {
      result.offerTiers = this.generateBestOfferTiers(afp, result.sellerSignals, productData);
      result.negotiationMessages = this.generateNegotiationMessages(result.offerTiers, productData);
      result.strategy = 'offer';
    }

    return result;
  }

  /**
   * Check for critical red flags that should block DealSense
   */
  static checkCriticalRedFlags(productData) {
    const flags = [];
    const title = (productData.title || '').toLowerCase();
    const condition = (productData.condition || '').toLowerCase();
    const specs = productData.specs || productData.itemSpecifics || {};

    // Check for BAD IMEI in title
    if (title.includes('bad imei') || title.includes('badimei') || title.includes('bad esn')) {
      flags.push({
        type: 'bad_imei',
        severity: 'critical',
        message: 'BAD IMEI/ESN - Device is blacklisted and cannot be activated on most carriers',
        action: 'DO NOT BID - This device has severe restrictions'
      });
    }

    // Check for iCloud locked
    if (title.includes('icloud') && (title.includes('locked') || title.includes('activation'))) {
      flags.push({
        type: 'icloud_locked',
        severity: 'critical',
        message: 'iCloud Locked - Device is permanently locked to previous owner',
        action: 'DO NOT BID - Device is unusable'
      });
    }

    // Check for "For parts or not working" condition
    if (condition.includes('for parts') || condition.includes('not working') || condition.includes('defective')) {
      flags.push({
        type: 'broken',
        severity: 'critical',
        message: 'Item listed as broken/for parts - does not function properly',
        action: 'DO NOT BID unless you plan to repair or use for parts'
      });
    }

    // Check specs for Condition field
    if (specs.Condition) {
      const specCondition = specs.Condition.toLowerCase();
      if (specCondition.includes('for parts') || specCondition.includes('not working')) {
        flags.push({
          type: 'broken',
          severity: 'critical',
          message: 'Item condition: For parts or not working',
          action: 'DO NOT BID - Item is defective'
        });
      }
    }

    return flags;
  }

  /**
   * Calculate Adjusted Fair Price (AFP) from market data
   */
  static calculateAdjustedFairPrice(priceData) {
    if (!priceData) {
      return null;
    }

    // Use median as baseline
    let baseline = priceData.median;

    // Fallback to average of min/max if no median
    if (!baseline && priceData.min && priceData.max) {
      baseline = (priceData.min + priceData.max) / 2;
    }

    if (!baseline) {
      return null;
    }

    // Apply confidence factor based on data quality
    const confidenceFactor = this.calculateConfidenceFactor(priceData);
    const afp = baseline * confidenceFactor;

    return {
      value: afp,
      baseline,
      confidenceFactor,
      source: priceData.source || 'comparables'
    };
  }

  /**
   * Calculate confidence factor based on comparable count and recency
   */
  static calculateConfidenceFactor(priceData) {
    if (!priceData) return 0.8; // Default moderate confidence

    const compCount = priceData.compCount || priceData.count || 0;

    // More comparables = higher confidence (caps at 10 comps)
    let factor = Math.min(1.0, compCount / 10);

    // Reduce confidence if very few comparables
    if (compCount < 3) {
      factor *= 0.7;
    }

    // Ensure minimum confidence of 0.5
    return Math.max(0.5, factor);
  }

  /**
   * Calculate overall confidence score (0-100)
   */
  static calculateConfidence(priceData) {
    const factor = this.calculateConfidenceFactor(priceData);
    return Math.round(factor * 100);
  }

  /**
   * Generate snipe bid recommendations with odd-cent optimization
   */
  static generateSnipeBids(afp, competitionScore, priceData) {
    if (!afp?.value) {
      return null;
    }

    const baseValue = afp.value;

    // Generate three tiers based on competition and rarity
    const tiers = {
      conservative: {
        label: 'Conservative',
        description: 'Good value, lower risk',
        multiplier: 0.90
      },
      fair: {
        label: 'Fair Market',
        description: 'Market rate, balanced approach',
        multiplier: 1.00
      },
      aggressive: {
        label: 'Aggressive',
        description: 'Higher chance to win, premium paid',
        multiplier: 1.05
      }
    };

    const bids = {};

    Object.keys(tiers).forEach(key => {
      const tier = tiers[key];
      const rawBid = baseValue * tier.multiplier;
      const optimizedBid = this.optimizeBidWithOddCents(rawBid);

      bids[key] = {
        label: tier.label,
        description: tier.description,
        amount: optimizedBid,
        formatted: `$${optimizedBid.toFixed(2)}`,
        reasoning: this.generateBidReasoning(optimizedBid, baseValue, tier.multiplier)
      };
    });

    return {
      bids,
      recommended: competitionScore === 'high' ? 'aggressive' : 'fair',
      strategy: 'Bid in the last 5-10 seconds for best results',
      timing: 'Wait until final 5-10 seconds to place your bid'
    };
  }

  /**
   * Optimize bid with odd cents to beat round-number bidders
   */
  static optimizeBidWithOddCents(baseBid) {
    const wholeDollars = Math.floor(baseBid);

    // Add strategic cents between $0.37 and $0.87
    // This beats most round-number bids ($X.00, $X.50, etc.)
    const oddCents = [0.37, 0.47, 0.57, 0.67, 0.77, 0.83, 0.87];
    const randomCents = oddCents[Math.floor(Math.random() * oddCents.length)];

    return wholeDollars + randomCents;
  }

  /**
   * Generate reasoning text for a bid amount
   */
  static generateBidReasoning(bidAmount, afpValue, multiplier) {
    const percentDiff = ((bidAmount - afpValue) / afpValue * 100).toFixed(0);
    const diffText = multiplier < 1.0
      ? `${Math.abs(percentDiff)}% below market`
      : multiplier > 1.0
        ? `${percentDiff}% above market`
        : 'at market rate';

    return `${diffText} - odd cents beat round-number bidders`;
  }

  /**
   * Generate Best Offer tiers based on seller signals
   */
  static generateBestOfferTiers(afp, sellerSignals, productData) {
    if (!afp?.value) {
      return null;
    }

    const baseValue = afp.value;
    const isDesperateList = sellerSignals.desperation === 'high';
    const isNewListing = sellerSignals.listingAge < 7;

    // Adjust tiers based on seller desperation
    const tiers = {
      lowball: {
        label: 'Lowball',
        description: isDesperateList ? 'Seller likely motivated - worth trying' : 'May be rejected, but worth a shot',
        multiplier: 0.60
      },
      fair: {
        label: 'Fair Offer',
        description: 'Reasonable starting point for negotiation',
        multiplier: 0.78
      },
      strong: {
        label: 'Strong Offer',
        description: isNewListing ? 'Competitive for new listing' : 'High acceptance chance',
        multiplier: 0.88
      }
    };

    const offers = {};

    Object.keys(tiers).forEach(key => {
      const tier = tiers[key];
      const rawOffer = baseValue * tier.multiplier;
      const roundedOffer = Math.round(rawOffer); // Offers are usually whole dollars

      offers[key] = {
        label: tier.label,
        description: tier.description,
        amount: roundedOffer,
        formatted: `$${roundedOffer.toFixed(2)}`,
        acceptance: this.estimateAcceptanceChance(tier.multiplier, sellerSignals)
      };
    });

    return {
      offers,
      recommended: isDesperateList ? 'lowball' : isNewListing ? 'strong' : 'fair'
    };
  }

  /**
   * Estimate acceptance chance for an offer
   */
  static estimateAcceptanceChance(multiplier, sellerSignals) {
    let baseChance = 0;

    if (multiplier >= 0.85) {
      baseChance = 75;
    } else if (multiplier >= 0.75) {
      baseChance = 50;
    } else {
      baseChance = 25;
    }

    // Boost chance if seller shows desperation
    if (sellerSignals.desperation === 'high') {
      baseChance += 15;
    } else if (sellerSignals.desperation === 'medium') {
      baseChance += 7;
    }

    return `${Math.min(95, baseChance)}%`;
  }

  /**
   * Generate negotiation message templates
   */
  static generateNegotiationMessages(offerTiers, productData) {
    if (!offerTiers) return null;

    const title = productData.title || 'this item';
    const messages = {};

    Object.keys(offerTiers.offers).forEach(key => {
      const offer = offerTiers.offers[key];

      if (key === 'lowball') {
        messages[key] = `Hi! I'm interested in ${title}. Would you consider ${offer.formatted}? I'm a serious buyer ready to pay immediately. Thanks!`;
      } else if (key === 'fair') {
        messages[key] = `Hello, I'd like to purchase ${title}. I can offer ${offer.formatted} and pay right away. Please let me know if this works for you. Thank you!`;
      } else {
        messages[key] = `Hi, I'm very interested in ${title} and ready to complete the purchase today. I can offer ${offer.formatted}. Looking forward to hearing from you!`;
      }
    });

    return messages;
  }

  /**
   * Analyze competition level
   */
  static analyzeCompetition(productData, listing) {
    const watchers = productData.engagement?.watchers || 0;
    const bidCount = listing.auction?.bidCount || 0;
    const timeLeft = listing.auction?.timeLeft;

    // High watchers + high bids = high competition
    if (watchers > 50 || bidCount > 15) {
      return 'high';
    }

    // Moderate activity
    if (watchers > 20 || bidCount > 5) {
      return 'medium';
    }

    // Low activity
    return 'low';
  }

  /**
   * Analyze listing quality to find hidden gems
   */
  static analyzeListingQuality(productData) {
    const title = productData.title || '';
    const description = productData.description || '';
    const hasImage = !!productData.mainImage;

    let score = 10; // Start at perfect
    const insights = [];

    // Check for common typos (indicates poor listing = fewer competitors)
    const commonTypos = ['iphone', 'nintindo', 'porceline', 'vintige', 'collectable'];
    const hasTypo = commonTypos.some(typo => title.toLowerCase().includes(typo));

    if (hasTypo) {
      insights.push('Possible typo in title - may have fewer bidders');
      score -= 3; // Lower quality listing
    }

    // Check for poor title (too short or too generic)
    if (title.length < 20) {
      insights.push('Short title - potentially under-optimized');
      score -= 2;
    }

    // Check for missing image
    if (!hasImage) {
      insights.push('No main image - significant red flag');
      score -= 4;
    }

    // Check for minimal description
    if (!description || description.length < 50) {
      insights.push('Minimal description - seller may not be experienced');
      score -= 1;
    }

    return {
      score: Math.max(0, score),
      quality: score >= 8 ? 'high' : score >= 5 ? 'medium' : 'low',
      insights,
      hiddenGem: score < 6 // Low quality = potentially hidden gem
    };
  }

  /**
   * Analyze seller for desperation signals
   */
  static analyzeSellerSignals(productData) {
    const seller = productData.seller || {};
    const engagement = productData.engagement || {};

    // Estimate listing age from scrapedAt (we don't have exact creation date)
    // This is a placeholder - in production, you'd track actual listing date
    const listingAge = 14; // Default assumption: 14 days old

    let desperationScore = 0;
    const signals = [];

    // High watchers but no bids = seller overpriced or buyers hesitant
    if (engagement.watchers > 30 && (!productData.listing?.auction?.bidCount || productData.listing.auction.bidCount === 0)) {
      desperationScore += 2;
      signals.push('High watchers but no bids - price may be too high');
    }

    // Best Offer enabled = seller open to negotiation
    if (productData.listing?.bestOffer) {
      desperationScore += 1;
      signals.push('Best Offer enabled - seller open to negotiation');
    }

    // Lower seller rating = potentially more motivated
    if (seller.positivePercent && seller.positivePercent < 98) {
      desperationScore += 1;
      signals.push('Seller rating below 98% - may be motivated to sell');
    }

    // Low feedback count = inexperienced seller
    if (seller.feedbackCount && seller.feedbackCount < 100) {
      desperationScore += 1;
      signals.push('New seller (low feedback) - may accept lower offers');
    }

    const desperation = desperationScore >= 3 ? 'high' : desperationScore >= 1 ? 'medium' : 'low';

    return {
      desperation,
      listingAge,
      signals,
      score: desperationScore
    };
  }

  /**
   * Analyze auction timing for competition insights
   */
  static analyzeAuctionTiming(auction) {
    if (!auction?.timeLeft) {
      return null;
    }

    const timeLeft = auction.timeLeft.toLowerCase();

    // Parse time remaining
    let hoursLeft = 0;
    if (timeLeft.includes('d')) {
      const days = parseInt(timeLeft.match(/(\d+)d/)?.[1] || 0);
      hoursLeft = days * 24;
    }
    if (timeLeft.includes('h')) {
      hoursLeft += parseInt(timeLeft.match(/(\d+)h/)?.[1] || 0);
    }

    let urgency = 'low';
    let message = 'Plenty of time to watch and plan';

    if (hoursLeft < 1) {
      urgency = 'critical';
      message = 'Auction ending very soon - prepare to snipe now!';
    } else if (hoursLeft < 6) {
      urgency = 'high';
      message = 'Auction ending soon - get ready to bid in final seconds';
    } else if (hoursLeft < 24) {
      urgency = 'medium';
      message = 'Auction ending today - set a reminder for final 10 seconds';
    }

    return {
      timeLeft: auction.timeLeft,
      hoursLeft,
      urgency,
      message,
      snipeWindow: hoursLeft < 1 ? 'NOW' : hoursLeft < 6 ? 'Soon' : 'Later'
    };
  }

  /**
   * Detect potential bidding war patterns
   */
  static detectBiddingWarPattern(auction) {
    if (!auction?.bidCount) return false;

    // High bid count relative to time remaining suggests bidding war
    // This is a heuristic - in production, you'd analyze bid history
    return auction.bidCount > 20;
  }

  /**
   * Generate actionable recommendation summary
   */
  static generateRecommendation(dealSenseData, productData) {
    if (!dealSenseData) return null;

    const recommendations = [];
    const warnings = [];

    // Auction recommendations
    if (dealSenseData.snipeBids) {
      const recommended = dealSenseData.snipeBids.recommended;
      const bid = dealSenseData.snipeBids.bids[recommended];

      recommendations.push({
        type: 'snipe',
        title: 'Recommended Snipe Bid',
        action: `Bid ${bid.formatted} in the last 5-10 seconds`,
        priority: 'high'
      });

      if (dealSenseData.auctionTiming?.urgency === 'critical') {
        warnings.push('Auction ending imminently - bid now if interested!');
      }
    }

    // Best Offer recommendations
    if (dealSenseData.offerTiers) {
      const recommended = dealSenseData.offerTiers.recommended;
      const offer = dealSenseData.offerTiers.offers[recommended];

      recommendations.push({
        type: 'offer',
        title: 'Recommended Best Offer',
        action: `Start with ${offer.formatted} (${offer.acceptance} acceptance chance)`,
        priority: 'medium'
      });
    }

    // Competition insights
    if (dealSenseData.competitionScore === 'low') {
      recommendations.push({
        type: 'insight',
        title: 'Low Competition Detected',
        action: 'Good opportunity for a below-market bid',
        priority: 'low'
      });
    }

    // Hidden gem detection
    if (dealSenseData.listingQuality?.hiddenGem) {
      recommendations.push({
        type: 'insight',
        title: 'Potential Hidden Gem',
        action: 'Poor listing quality means fewer competitors - great opportunity!',
        priority: 'medium'
      });
    }

    return {
      recommendations,
      warnings,
      summary: this.generateSummary(dealSenseData, productData)
    };
  }

  /**
   * Generate summary text
   */
  static generateSummary(dealSenseData, productData) {
    const parts = [];

    if (dealSenseData.afp) {
      parts.push(`Fair market value: ${dealSenseData.afp.value.toFixed(2)}`);
    }

    if (dealSenseData.competitionScore) {
      parts.push(`${dealSenseData.competitionScore} competition`);
    }

    if (dealSenseData.confidence) {
      parts.push(`${dealSenseData.confidence}% confidence`);
    }

    return parts.join(' • ');
  }
}
