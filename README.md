# MSI Product Page Scraper

Small Playwright + JavaScript scraper for one MSI US Store product detail page.

**Target URL:** https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI

## Requirements

- Node.js 18+
- Playwright Chromium (installed via npm script)
- Optional but recommended on macOS: Google Chrome (helps when the store's bot protection blocks stock Chromium)

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm run scrape
```

Writes (or overwrites) `output/product.json`.

## Output schema

The scraper returns one JSON object with:

- `url`, `item_id`, `title`, `brand`
- `product_category`, `category_tree`
- `description`, `price`, `sale_price`, `availability`
- `image_url`, `additional_image_urls`
- `specs` (`name` / `value` pairs)
- `star_rating`, `review_count`, `gtin`, `mpn`
- `scraped_at` (ISO 8601)

Missing scalar fields are `null`. List fields use `[]` when empty. Prices are numbers (for example `"$259.99"` → `259.99`).

## Notes

- Values are read from the live page (DOM), not hardcoded.
- Selectors prefer stable hooks such as `#prices-new`, `ol.breadcrumb`, `.product-detail`, and specification tables.
- The MSI store sits behind Akamai bot protection. The scraper uses a realistic browser profile and prefers the system Chrome channel when available.
