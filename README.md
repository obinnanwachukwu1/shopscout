# ShopScout

AI-powered Chrome extension that acts as a trustworthy shopping co-pilot for Amazon and eBay. Uses Claude 4.5 as an agentic AI to autonomously analyze products, compare prices, verify specifications, and answer questions about your shopping decisions.

## Features

### 🎯 Smart Product Analysis
- **Live Price Fairness**: Autonomous cross-site price comparison with real-time market data from Amazon and eBay
- **AI-Powered Spec Verification**: Claude validates product specifications against current web data
- **Review Intelligence**: Sentiment analysis from Amazon reviews with helpful/total vote counts
- **External Review Search**: Autonomous web search for expert reviews and ratings
- **Buy Score**: Weighted scoring system combining price, reviews, shipping, and condition

### 🤖 Agentic AI Capabilities
- **Autonomous Research**: Claude acts as an agent with tool use and function calling
- **Multi-Step Workflows**: Automatically chains scraping → analyzing → scoring → recommending
- **Smart Web Search**: RAG-powered search with BM25 ranking and content quality assessment
- **Context-Aware Chat**: Ask questions about products with source-cited, grounded answers

### 🏷️ Category Intelligence
- **Adaptive Analysis**: Category-aware logic for Electronics, Fashion, Beauty, Home, Collectibles, and more
- **DealSense for eBay**: Smart auction bidding recommendations and offer analysis
- **Mode Switching**: Different analysis strategies based on product category

## Architecture

**100% client-side** with optional local proxy. All analysis runs in your browser using:
- Chrome Extension Manifest V3 (service worker architecture)
- Anthropic Claude 4.5 API (Haiku for speed, Sonnet for depth)
- Client-side web scraping via content scripts
- Local Playwright proxy for CORS bypass (optional)

### How It Works

1. **Product Detection**: Content scripts extract product data from Amazon/eBay pages
2. **Agentic Analysis**: Background service worker orchestrates Claude API calls with tool use
3. **Price Comparison**: Autonomous DuckDuckGo search to find alternative listings
4. **Spec Verification**: Web search to validate product specifications
5. **Review Analysis**: Claude analyzes review sentiment and extracts key insights
6. **Buy Score**: Weighted algorithm combines all signals into a single recommendation

## Quick Start

### Prerequisites
- Node.js 16+ and npm
- Chrome browser
- Anthropic Claude API key ([get one here](https://console.anthropic.com/))

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/shopscout.git
cd shopscout

# Install dependencies
npm install

# Build the extension
npm run build
```

### Configuration

Create a `config.local.js` file in the root directory:

```javascript
export const CLAUDE_API_KEY = 'sk-ant-your-api-key-here';
```

### Load Extension in Chrome

1. Navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `shopscout` directory (not the dist folder)

### Optional: Start Local Proxy

For best results with web search (bypasses CORS restrictions):

```bash
# Install Playwright browsers (one-time setup)
npx playwright install chromium

# Start the proxy server
npm run proxy
```

The proxy runs on `http://127.0.0.1:9000`. See [PROXY_README.md](./PROXY_README.md) for details.

## Usage

1. **Visit Amazon or eBay**: Navigate to any product page
2. **Open Side Panel**: Click the ShopScout icon in Chrome's toolbar
3. **Wait for Analysis**: Claude analyzes the product (5-10 seconds)
4. **Review Results**: See price comparisons, buy score, and AI insights
5. **Ask Questions**: Use the chat to ask specific questions about the product

### Example Questions
- "Is this a good deal compared to similar products?"
- "What do reviews say about battery life?"
- "Are there cheaper alternatives on eBay?"
- "What are the key specifications I should know?"

## Project Structure

```
shopscout/
├── manifest.json              # Chrome extension manifest (V3)
├── background.js              # Service worker - orchestrates all logic
├── content-script.js          # Injected into pages for DOM access
├── sidepanel.html/js          # Main UI (product analysis view)
├── chat.html/js               # Chat interface for Q&A
├── build.js                   # esbuild bundler
├── proxy-server.js            # Local Playwright proxy for CORS bypass
├── config.local.js            # Your API key (gitignored)
├── src/
│   ├── modules/
│   │   ├── claude-api.js      # Claude API client with streaming
│   │   ├── web-search.js      # RAG-powered DuckDuckGo search
│   │   ├── price-comparison.js # Cross-site price analysis
│   │   ├── buy-score-calculator.js # Weighted scoring algorithm
│   │   └── category-detector.js # Product category detection
│   ├── scrapers/
│   │   ├── amazon-extractor.js # Amazon product data scraper
│   │   └── ebay-extractor.js   # eBay product data scraper
│   └── analyzers/
│       └── stop-condition-checker.js # When to skip analysis
└── icons/                     # Extension icons
```

## Key Technologies

### RAG (Retrieval-Augmented Generation)
ShopScout uses advanced RAG techniques for web search:

- **BM25 Scoring**: Term frequency saturation with length normalization
- **Smart Chunking**: Paragraph-aware text splitting with sentence boundaries
- **Content Quality Assessment**: Filters navigation/boilerplate, prioritizes informative content
- **Query Signal Extraction**: Bigram/trigram phrases, entity detection, term weighting
- **Context-Aware Snippets**: Extracts most relevant portions based on query match positions

### Agentic AI Pattern
Claude acts as an autonomous agent:

1. **Tool Use**: Claude calls web search tools when it needs more information
2. **Function Calling**: Structured extraction of product data and search queries
3. **Multi-Step Reasoning**: Chains multiple actions (search → extract → compare → synthesize)
4. **Self-Directed**: Claude decides when to search, what to search for, and how to interpret results

### Buy Score Algorithm
Weighted average of:
- **Price Score** (30%): Comparison to market average
- **Review Score** (30%): Star rating and sentiment
- **Shipping Score** (20%): Speed and cost
- **Condition Score** (20%): New vs used, seller rating

## Development

### Build Commands

```bash
npm run build        # One-time build
npm run watch        # Watch mode for development
npm run dev          # Clean + watch
npm run clean        # Remove dist folder
npm run proxy        # Start CORS proxy server
```

### Development Workflow

1. Make changes to source files
2. Run `npm run watch` to auto-rebuild
3. Click "Reload" on extension in `chrome://extensions/`
4. Test on Amazon/eBay product pages

### Debugging

- **Background Script**: `chrome://extensions/` → ShopScout → "Service worker" → Inspect
- **Side Panel**: Right-click side panel → Inspect
- **Content Script**: Open DevTools on product page, check Console
- **Proxy Server**: Terminal output shows fetch logs

## Configuration Options

### Environment Variables

```bash
PORT=9000                          # Proxy server port
SHOPSCOUT_WEB_SEARCH_WORKERS=4     # Number of worker threads for search
```

### Feature Flags (in background.js)

```javascript
ENABLE_EXTERNAL_REVIEWS: false     // Enable external review search (disabled by default)
ENABLE_SPEC_ANALYSIS: false        // Enable spec verification (disabled by default)
```

## RAG Configuration (in web-search.js)

```javascript
RAG_CHUNK_SIZE: 1200              // Characters per chunk
RAG_CHUNK_OVERLAP: 200            // Overlap between chunks
RAG_MAX_CHUNKS_PER_RESULT: 4      // Top chunks sent to Claude
RAG_MIN_SCORE: 0.15               // Minimum relevance score threshold
```

## Troubleshooting

### "No product detected"
- Make sure you're on an actual product page, not a search results page
- Try refreshing the page
- Check console for errors

### Web search failing (502 errors)
- Start the proxy server: `npm run proxy`
- Make sure port 9000 is not in use
- Check that Playwright is installed: `npx playwright install chromium`

### Claude API errors
- Verify your API key in `config.local.js`
- Check your API usage at https://console.anthropic.com/
- Ensure you have sufficient credits

### Extension not loading
- Check Chrome console for syntax errors
- Make sure you ran `npm run build`
- Try disabling and re-enabling the extension

## Performance

- **Initial Analysis**: 5-10 seconds (includes web searches and AI processing)
- **Chat Responses**: 2-5 seconds (streaming response)
- **Memory Usage**: ~50-100 MB (Chrome extension overhead)
- **API Costs**: ~$0.01-0.03 per product analysis (Claude API pricing)

## Privacy & Security

- **100% Client-Side**: All data processing happens in your browser
- **No Backend**: No data sent to ShopScout servers (we don't have any!)
- **API Direct**: Claude API calls go directly from your browser to Anthropic
- **No Tracking**: No analytics, no telemetry, no user tracking
- **Local Proxy**: Optional proxy runs on your machine, only you can access it

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly on Amazon and eBay
5. Submit a pull request

## Roadmap

- [ ] Support for more e-commerce sites (Walmart, Target, BestBuy)
- [ ] Price history tracking
- [ ] Browser notifications for price drops
- [ ] Export analysis to PDF/CSV
- [ ] Multi-language support
- [ ] Firefox and Edge extensions

## License

MIT License - see LICENSE file for details

## Acknowledgments

- Built with [Claude 4.5](https://www.anthropic.com/claude) by Anthropic
- Web scraping powered by [Playwright](https://playwright.dev/)
- Search via [DuckDuckGo](https://duckduckgo.com/)

## Support

- Report bugs via [GitHub Issues](https://github.com/yourusername/shopscout/issues)
- For API questions, see [Anthropic Documentation](https://docs.anthropic.com/)

---

**Note**: This is an independent project and is not affiliated with Amazon, eBay, or Anthropic.
