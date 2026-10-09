# MSI product scraper

Playwright scraper for one MSI US store product page. It reads the live page and writes `output/product.json`.

```bash
npm install
npx playwright install chromium
npm run scrape
```

The store returns 403 to Playwright's default headless shell. The scraper stays headless and uses the installed Chrome for Testing build with a normal Chrome user agent.
