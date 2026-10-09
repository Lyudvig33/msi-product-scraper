const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");

const PRODUCT_URL =
  "https://us-store.msi.com/Motherboards/Intel-Platform-Motherboard/INTEL-Z890/MAG-Z890-TOMAHAWK-WIFI";

const OUTPUT_PATH = path.join(__dirname, "..", "output", "product.json");

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function parsePrice(value) {
  const text = cleanText(value);
  if (!text) return null;

  const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function normalizeAvailability(value) {
  const text = cleanText(value);
  if (!text) return null;

  const normalized = text.toLowerCase();
  if (normalized.includes("pre-order") || normalized.includes("preorder") || normalized.includes("pre order")) {
    return "pre_order";
  }
  if (
    normalized.includes("out of stock") ||
    normalized.includes("sold out") ||
    normalized.includes("unavailable")
  ) {
    return "out_of_stock";
  }
  if (normalized.includes("in stock") || normalized.includes("add to cart")) {
    return "in_stock";
  }

  return null;
}

function parseRating(value) {
  const text = cleanText(value);
  if (!text) {
    return { star_rating: null, review_count: null };
  }

  const ratingMatch = text.match(/(\d+(?:\.\d+)?)/);
  const countMatch = text.match(/\((\d[\d,]*)\)/);

  return {
    star_rating: ratingMatch ? Number(ratingMatch[1]) : null,
    review_count: countMatch ? Number(countMatch[1].replace(/,/g, "")) : null,
  };
}

function extractBrand(logoAlt) {
  const text = cleanText(logoAlt);
  if (!text) return null;

  const match = text.match(/^([A-Za-z0-9]+)/);
  return match ? match[1].toUpperCase() : null;
}

function findSpec(specs, pattern) {
  const match = specs.find((spec) => pattern.test(spec.name));
  return match ? match.value : null;
}

function imageOrder(url) {
  const match = String(url).match(/-(\d+)-\d+x\d+\./);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function buildCategory(crumbs) {
  const categories = crumbs.filter((crumb, index) => {
    const name = cleanText(crumb.name);
    if (!name) return false;
    if (index === 0 && name.toLowerCase() === "home") return false;
    if (crumb.current) return false;
    return true;
  });

  return {
    product_category: categories.length
      ? categories.map((crumb) => cleanText(crumb.name)).join(" > ")
      : null,
    category_tree: categories.map((crumb) => ({
      name: cleanText(crumb.name),
      url: crumb.url || null,
    })),
  };
}

function normalizeProduct(raw) {
  const specs = raw.specs
    .map((spec) => ({
      name: cleanText(spec.name),
      value: cleanText(spec.value),
    }))
    .filter((spec) => spec.name);

  const currentPrice = parsePrice(raw.currentPriceText);
  const previousPrice = parsePrice(raw.previousPriceText);
  const hasSale = previousPrice != null && currentPrice != null && previousPrice !== currentPrice;
  const rating = parseRating(raw.ratingText);
  const category = buildCategory(raw.crumbs);

  const mainImage = raw.mainImage || null;
  const additionalImageUrls = [...new Set(raw.imageUrls)]
    .filter((url) => url && url !== mainImage)
    .sort((a, b) => imageOrder(a) - imageOrder(b));

  return {
    url: raw.url,
    item_id: cleanText(raw.itemId),
    title: cleanText(raw.title),
    brand: extractBrand(raw.logoAlt),
    product_category: category.product_category,
    category_tree: category.category_tree,
    description: cleanText(raw.description),
    price: hasSale ? previousPrice : currentPrice,
    sale_price: hasSale ? currentPrice : null,
    availability: normalizeAvailability(raw.availabilityText),
    image_url: mainImage,
    additional_image_urls: additionalImageUrls,
    specs,
    star_rating: rating.star_rating,
    review_count: rating.review_count,
    gtin: findSpec(specs, /^(gtin|upc|ean)$/i),
    mpn: findSpec(specs, /manufacturer number|mpn|part number/i),
    scraped_at: new Date().toISOString(),
  };
}

async function extractFromPage(page) {
  return page.evaluate(() => {
    const text = (element) => (element ? element.textContent : null);
    const productRoot = document.querySelector(".product-detail");

    const titleElement = productRoot?.querySelector("h2.title");
    const descriptionElement = titleElement?.nextElementSibling?.querySelector("p");
    const priceElement = document.querySelector("#prices-new");
    const priceBlock = priceElement?.parentElement || null;
    const previousPriceElement = priceBlock?.querySelector(".price-old, del, s");

    const crumbs = [...document.querySelectorAll("ol.breadcrumb > li")].map((item) => {
      const link = item.querySelector("a");
      return {
        name: item.textContent,
        url: link ? link.href : null,
        current: item.classList.contains("active"),
      };
    });

    const imageUrls = [
      ...document.querySelectorAll(
        ".product-detail img.product-detail-thumb-bto, .product-detail img[popup_img]"
      ),
    ]
      .filter((image) => !image.closest(".swiper-slide-duplicate"))
      .map((image) => image.getAttribute("popup_img") || image.currentSrc || image.src);

    const specs = [...document.querySelectorAll(".product-detail table.table-borderless tr")].map(
      (row) => ({
        name: text(row.querySelector("th")),
        value: text(row.querySelector("td")),
      })
    );

    return {
      url: location.href,
      itemId: productRoot?.querySelector('input[name="product_id"]')?.value || null,
      title: text(titleElement),
      logoAlt: document.querySelector('header img[alt], img[alt*="MSI" i], img[alt*="msi" i]')?.alt || null,
      description: text(descriptionElement),
      currentPriceText: text(priceElement),
      previousPriceText: text(previousPriceElement),
      availabilityText: priceBlock ? priceBlock.innerText : null,
      crumbs,
      mainImage: document.querySelector("#imagePopup")?.src || null,
      imageUrls,
      specs,
      ratingText: text(document.querySelector("#average-rating-info")),
    };
  });
}

async function scrape() {
  // The store blocks Playwright's headless shell (403). The full Chrome build
  // still runs headless; a normal Chrome user agent avoids that block.
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome-for-testing",
  });

  try {
    const page = await browser.newPage({
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    });

    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#prices-new", { timeout: 30000 });
    await page.waitForSelector(".product-detail h2.title", { timeout: 30000 });
    await page.waitForSelector(".product-detail table.table-borderless tr", { timeout: 30000 });

    const raw = await extractFromPage(page);
    const product = normalizeProduct(raw);

    if (!product.title || product.price == null) {
      throw new Error("Product title or price was not found on the page.");
    }

    await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(product, null, 2)}\n`, "utf8");

    console.log(`Saved ${OUTPUT_PATH}`);
    console.log(`${product.title} | price ${product.price} | ${product.availability}`);
  } finally {
    await browser.close();
  }
}

scrape().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
