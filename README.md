# ShopScout

AI-powered, 100% client-side Chrome extension that acts as a trustworthy shopping co-pilot for Amazon and eBay.

## Features

- **Live Price Fairness**: Cross-site price comparison with real-time market data
- **AI-Powered Analysis**: Claude 4.5-powered spec verification and review sentiment analysis
- **Adaptive Intelligence**: Category-aware analysis (Electronics, Fashion, Beauty, Collectibles, etc.)
- **DealSense**: Smart auction bidding and offer recommendations for eBay
- **Grounded Q&A**: Ask questions about products with source-cited answers

## Architecture

100% client-side with no backend required. All analysis runs in your browser using:
- Chrome Extension Manifest V3
- Anthropic Claude 4.5 API (Haiku & Sonnet)
- Client-side web scraping and data analysis

## Development

```bash
npm install
npm run build
```

Load the extension in Chrome:
1. Navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist` directory

## Project Structure

```
shopscout/
├── manifest.json           # Extension configuration
├── background.js          # Service worker (The Brain)
├── content-script.js      # Page scraper
├── sidepanel.html         # UI structure
├── sidepanel.js           # UI logic
├── src/
│   ├── modules/           # Core modules (API, scoring, etc.)
│   ├── scrapers/          # Site-specific scrapers
│   └── analyzers/         # Analysis engines
└── icons/                 # Extension icons
```

## Configuration

Create a `config.local.js` file with your Claude API key:

```javascript
export const CLAUDE_API_KEY = 'your-api-key-here';
```

## Documentation

Comprehensive documentation is available in `local_docs/`:
- `QUICK_START.md` - 5-minute setup guide
- `IMPLEMENTATION_GUIDE.md` - Full technical documentation
- `HACKATHON_GUIDE.md` - Demo and presentation guide
- `TESTING_GUIDE.md` - Testing procedures
- `PROJECT_STATUS.md` - Development status and roadmap
- `PROJECT_SUMMARY.txt` - Visual project overview

## License

MIT
