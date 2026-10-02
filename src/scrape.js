const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PRODUCT_URL =
  'https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI';

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

function parsePrice(value) {
  if (value == null) return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function parseAvailability(value) {
  const text = cleanText(value);
  if (!text) return null;

  const normalized = text.toLowerCase();
  if (/pre[-\s]?order/.test(normalized)) return 'pre_order';
  if (/out\s*of\s*stock|sold\s*out|unavailable/.test(normalized)) {
    return 'out_of_stock';
  }
  if (/in\s*stock|available/.test(normalized)) return 'in_stock';
  return null;
}

function absoluteUrl(href, baseUrl) {
  const cleaned = cleanText(href);
  if (!cleaned || cleaned === '#' || cleaned.startsWith('javascript:')) {
    return null;
  }
  try {
    return new URL(cleaned, baseUrl).href;
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

/**
 * Prefer larger gallery images and drop unrelated / related-product assets.
 */
function normalizeProductImages(urls, pageUrl) {
  const absolute = urls
    .map((raw) => absoluteUrl(raw, pageUrl))
    .filter(Boolean);

  // Infer the product image folder from the first gallery-looking URL.
  let productFolder = null;
  for (const url of absolute) {
    const match = url.match(/\/Pd_page\/[^/]+\/\d{4}\/([^/]+)\//i);
    if (match) {
      productFolder = match[1];
      break;
    }
  }

  const productLike = absolute.filter((url) => {
    if (!/asset-us-store\.msi\.com\/image\/cache\/catalog\/Pd_page/i.test(url)) {
      return false;
    }
    if (productFolder && !url.includes(`/${productFolder}/`)) return false;
    return true;
  });

  // Upgrade thumbnails to full-size when pattern allows, then dedupe by base name.
  const byKey = new Map();
  for (const url of productLike) {
    const upgraded = url.replace(/-\d+x\d+(\.\w+)(\?.*)?$/i, '-1024x1024$1');
    const key = upgraded.replace(/-\d+x\d+(?=\.\w+)/i, '');
    const current = byKey.get(key);
    const score = /1024x1024/.test(url) ? 3 : /400x400/.test(url) ? 1 : 2;
    if (!current || score > current.score) {
      byKey.set(key, { url: upgraded, score });
    }
  }

  return [...byKey.values()]
    .map((item) => item.url)
    .sort((a, b) => {
      const num = (value) => {
        const match = value.match(/-(\d+)-\d+x\d+\.\w+$/i);
        return match ? Number(match[1]) : 999;
      };
      return num(a) - num(b);
    });
}

async function dismissCookieBanner(page) {
  try {
    const accept = page.getByRole('button', { name: /^accept$/i }).first();
    if (await accept.isVisible({ timeout: 3000 })) {
      await accept.click({ timeout: 3000 });
    }
  } catch {
    // Banner may be absent.
  }
}

async function launchBrowser() {
  const stealthArgs = ['--disable-blink-features=AutomationControlled'];
  const attempts = [
    { channel: 'chrome', headless: true, args: ['--headless=new', ...stealthArgs] },
    { channel: 'chrome', headless: false, args: stealthArgs },
    { headless: true, args: ['--headless=new', ...stealthArgs] },
    { headless: false, args: stealthArgs },
  ];

  let lastError;
  for (const launchOptions of attempts) {
    try {
      const browser = await chromium.launch(launchOptions);
      return browser;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to launch a browser');
}

async function createContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });

  return context;
}

async function extractProductData(page, pageUrl) {
  return page.evaluate((baseUrl) => {
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    const abs = (href) => {
      if (!href || href === '#' || href.startsWith('javascript:')) return null;
      try {
        return new URL(href, baseUrl).href;
      } catch {
        return null;
      }
    };

    const productRoot =
      document.querySelector('.product-detail') || document.body;

    // Title: product heading first, then breadcrumb active, then image alt.
    const title =
      text(productRoot.querySelector('h2.crop-text-2.title, h2.title')) ||
      text(document.querySelector('ol.breadcrumb li.breadcrumb-item.active')) ||
      document.querySelector('#imagePopup')?.getAttribute('alt') ||
      document.querySelector('#imagePopup')?.getAttribute('title') ||
      '';

    // Brand: meta/logo/text; MSI store pages are MSI-branded.
    let brand =
      text(document.querySelector('[itemprop="brand"]')) ||
      document.querySelector('meta[property="product:brand"]')?.content ||
      '';
    if (!brand) {
      const logoAlt = document
        .querySelector('img[alt*="MSI" i]')
        ?.getAttribute('alt');
      if (logoAlt && /msi/i.test(logoAlt)) brand = 'MSI';
    }
    if (!brand && /msi/i.test(document.title || '')) brand = 'MSI';

    // Breadcrumbs (skip Home and current product)
    const category_tree = [];
    for (const item of document.querySelectorAll('ol.breadcrumb li.breadcrumb-item')) {
      const link = item.querySelector('a');
      const name = text(link || item);
      if (!name || /^home$/i.test(name)) continue;
      if (item.classList.contains('active')) continue;
      if (title && name.toLowerCase() === title.toLowerCase()) continue;
      category_tree.push({
        name,
        url: link ? abs(link.getAttribute('href')) : null,
      });
    }

    // Price + availability from the dedicated price wrapper when present.
    const priceWrapper = document.querySelector('#prices-wrapper') || productRoot;
    const priceText =
      text(priceWrapper.querySelector('#prices-new, .prices-new')) ||
      text(priceWrapper.querySelector('.price-new, .price'));
    const oldPriceText = text(
      priceWrapper.querySelector('.price-old, .prices-old, .price-was')
    );

    let availabilityText = '';
    for (const el of priceWrapper.querySelectorAll('span, div, p')) {
      const value = text(el);
      if (/in stock|out of stock|pre-?order|sold out/i.test(value) && value.length < 40) {
        availabilityText = value;
        break;
      }
    }

    // Description: first meaningful product paragraph.
    let description = '';
    for (const el of productRoot.querySelectorAll('p, div')) {
      const value = text(el);
      if (
        value.length > 80 &&
        value.length < 800 &&
        /motherboard|Z890|TOMAHAWK|Wi-?Fi/i.test(value) &&
        el.children.length <= 2
      ) {
        description = value;
        break;
      }
    }
    if (!description) {
      description =
        document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content ||
        '';
    }

    // Images from the main product gallery only (not related products).
    const imageCandidates = [];
    const mainImage = document.querySelector('#imagePopup');
    const mainSrc = mainImage?.getAttribute('src') || null;
    if (mainSrc) imageCandidates.push(mainSrc);

    // Infer product image folder from the main image path, e.g. .../Z890TOMAHAWKWIFI/...
    let productFolder = null;
    if (mainSrc) {
      const parts = mainSrc.split('/');
      const file = parts[parts.length - 1] || '';
      const folder = parts[parts.length - 2] || '';
      if (folder && !/^\d+x\d+$/i.test(folder)) productFolder = folder;
      else if (file) productFolder = file.replace(/-\d+.*$/, '');
    }

    for (const img of document.querySelectorAll('#carouselImages img')) {
      const src =
        img.getAttribute('popup_img') ||
        img.getAttribute('data-src') ||
        img.getAttribute('src');
      if (!src) continue;
      if (productFolder && !src.includes(productFolder)) continue;
      imageCandidates.push(src);
    }

    // Hidden preload full-size images near the gallery.
    if (productFolder) {
      for (const img of document.querySelectorAll('.product-detail img')) {
        const src = img.getAttribute('src');
        if (src && src.includes(productFolder) && /1024x1024/i.test(src)) {
          imageCandidates.push(src);
        }
      }
    }

    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    if (ogImage) imageCandidates.push(ogImage);

    // Specs from specification tables.
    const specs = [];
    const seen = new Set();
    const tables = document.querySelectorAll(
      '.product-detail table, table.table, table'
    );
    for (const table of tables) {
      for (const row of table.querySelectorAll('tr')) {
        const cells = row.querySelectorAll('th, td');
        if (cells.length < 2) continue;
        const name = text(cells[0]);
        const value = text(cells[1]);
        if (!name || name.length > 80) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        // Skip unrelated warranty policy tables without tech labels.
        if (!value && name.length < 3) continue;
        seen.add(key);
        specs.push({ name, value: value || null });
      }
    }

    // IDs
    const itemId =
      document.querySelector('input[name="product_id"]')?.value ||
      document.querySelector('[data-product-id]')?.getAttribute('data-product-id') ||
      null;

    // Ratings / reviews if a clear average is present.
    let starRating = null;
    let reviewCount = null;
    const avgBlock = [...document.querySelectorAll('h3, h4, div, span')].find(
      (el) => /average customer rating/i.test(text(el))
    );
    if (avgBlock) {
      const section = avgBlock.closest('div') || avgBlock.parentElement;
      const sectionText = text(section);
      const ratingMatch = sectionText.match(/(\d+(?:\.\d+)?)\s*(?:out of|\/)\s*5/i);
      if (ratingMatch) starRating = ratingMatch[1];
      const countMatch = sectionText.match(/based on\s+(\d+)\s+reviews?/i) ||
        sectionText.match(/(\d+)\s+reviews?/i);
      if (countMatch) reviewCount = countMatch[1];
    }

    // Fallback: sum bars like "5 2", "4 1" in rating snapshot.
    if (reviewCount == null) {
      let total = 0;
      let weighted = 0;
      for (const el of document.querySelectorAll('.pagination.rating-link')) {
        const parts = text(el).match(/^(\d)\s+(\d+)$/);
        if (!parts) continue;
        const stars = Number(parts[1]);
        const count = Number(parts[2]);
        total += count;
        weighted += stars * count;
      }
      if (total > 0) {
        reviewCount = String(total);
        if (starRating == null) {
          starRating = (weighted / total).toFixed(2);
        }
      }
    }

    return {
      title,
      brand,
      description,
      category_tree,
      priceText,
      oldPriceText,
      availabilityText,
      imageCandidates,
      specs,
      itemId,
      starRating,
      reviewCount,
    };
  }, pageUrl);
}

function buildProduct(pageUrl, raw) {
  const category_tree = (raw.category_tree || [])
    .map((item) => ({
      name: cleanText(item.name),
      url: item.url ? absoluteUrl(item.url, pageUrl) : null,
    }))
    .filter((item) => item.name);

  const product_category = category_tree.length
    ? category_tree.map((item) => item.name).join(' > ')
    : null;

  const currentPrice = parsePrice(raw.priceText);
  const oldPrice = parsePrice(raw.oldPriceText);

  let price = currentPrice;
  let sale_price = null;
  if (oldPrice != null && currentPrice != null && oldPrice > currentPrice) {
    price = oldPrice;
    sale_price = currentPrice;
  }

  const images = normalizeProductImages(raw.imageCandidates || [], pageUrl);
  const image_url = images[0] || null;
  const additional_image_urls = images.slice(1);

  const specs = (raw.specs || [])
    .map((spec) => ({
      name: cleanText(spec.name),
      value: cleanText(spec.value),
    }))
    .filter((spec) => spec.name);

  const manufacturerSpec = specs.find((spec) =>
    /manufacturer\s*(number|part|no\.?)/i.test(spec.name)
  );

  return {
    url: pageUrl,
    item_id: cleanText(raw.itemId),
    title: cleanText(raw.title),
    brand: cleanText(raw.brand),
    product_category,
    category_tree,
    description: cleanText(raw.description),
    price,
    sale_price,
    availability: parseAvailability(raw.availabilityText),
    image_url,
    additional_image_urls,
    specs,
    star_rating: parsePrice(raw.starRating),
    review_count:
      raw.reviewCount != null ? Math.round(Number(raw.reviewCount)) || null : null,
    gtin: null,
    mpn: cleanText(manufacturerSpec?.value),
    scraped_at: new Date().toISOString(),
  };
}

async function scrapeProduct(url = PRODUCT_URL) {
  const browser = await launchBrowser();
  const context = await createContext(browser);
  const page = await context.newPage();

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (!response) {
      throw new Error('No response received from product page');
    }

    const status = response.status();
    if (status >= 400) {
      throw new Error(`Failed to load product page (HTTP ${status}). The site may be blocking automated browsers.`);
    }

    await dismissCookieBanner(page);

    await page.waitForSelector('.product-detail, #prices-new, ol.breadcrumb', {
      timeout: 20000,
    });

    // Allow gallery / dynamic bits to settle.
    await page.waitForTimeout(1500);

    const finalUrl = page.url();
    const raw = await extractProductData(page, finalUrl);
    const product = buildProduct(finalUrl, raw);

    if (!product.title && product.price == null) {
      throw new Error('Product content was not found on the page');
    }

    return product;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  try {
    console.log('Scraping MSI product page...');
    const product = await scrapeProduct(PRODUCT_URL);

    const outputDir = path.join(__dirname, '..', 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'product.json');
    fs.writeFileSync(outputPath, JSON.stringify(product, null, 2), 'utf8');

    console.log(`Saved: ${outputPath}`);
    console.log(`Title: ${product.title}`);
    console.log(`Price: ${product.price}`);
    console.log(`Availability: ${product.availability}`);
    console.log(`Images: ${1 + product.additional_image_urls.length}`);
    console.log(`Specs: ${product.specs.length}`);
  } catch (error) {
    console.error('Scrape failed:', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  scrapeProduct,
  parsePrice,
  parseAvailability,
  cleanText,
};
