const { test, expect } = require('@playwright/test');

const TEST_PRODUCT = {
  id: 42,
  active: true,
  name: 'GA4 測試商品',
  price: 250,
  desc: '用於 GA4 追蹤測試',
  image: '',
  images: [],
  badge: '',
  badgeColor: '',
  order: 0,
  categoryId: 2,
};

const TEST_CATEGORY = { id: 2, name: '千層酥系列', color: '#c4d4a8', order: 0 };

async function mockStoreAndCapture(page) {
  // 攔截 dataLayer.push（比覆寫 gtag 更可靠：頁面的 function gtag(){dataLayer.push(arguments)} 會覆蓋 window.gtag）
  await page.addInitScript(() => {
    window._ga4Events = [];
    // 在頁面 script 執行前先建立 dataLayer，並替換 push 方法
    const _dl = [];
    const _origPush = Array.prototype.push;
    _dl.push = function() {
      const item = arguments[0]; // Arguments object from gtag('event', ...)
      if (item && item[0] === 'event') {
        window._ga4Events.push([item[0], item[1], item[2]]);
      }
      return _origPush.apply(this, arguments);
    };
    window.dataLayer = _dl;
  });

  await page.route('**/googletagmanager.com/**', route => route.abort());
  await page.route('**/google-analytics.com/**', route => route.abort());

  await page.route('**/api/store/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.route('**/auth/v1/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null, session: null }) });
  });
}

// ═══════════════════════════════════════════════════════════════
test.describe('GA4 — 商品詳情頁', () => {

  test('[regression] 商品頁載入 → 觸發 view_item 事件', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-name', { timeout: 8000 });

    const events = await page.evaluate(() => window._ga4Events);
    const viewItem = events.find(e => e[0] === 'event' && e[1] === 'view_item');
    expect(viewItem).toBeTruthy();
  });

  test('[regression] view_item 事件包含正確商品名稱', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-name', { timeout: 8000 });

    const events = await page.evaluate(() => window._ga4Events);
    const viewItem = events.find(e => e[0] === 'event' && e[1] === 'view_item');
    expect(viewItem[2].items[0].item_name).toBe('GA4 測試商品');
  });

  test('[regression] view_item 事件包含正確價格', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-name', { timeout: 8000 });

    const events = await page.evaluate(() => window._ga4Events);
    const viewItem = events.find(e => e[0] === 'event' && e[1] === 'view_item');
    expect(viewItem[2].value).toBe(250);
    expect(viewItem[2].currency).toBe('TWD');
  });

  test('[regression] view_item 事件包含分類名稱', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-name', { timeout: 8000 });

    const events = await page.evaluate(() => window._ga4Events);
    const viewItem = events.find(e => e[0] === 'event' && e[1] === 'view_item');
    expect(viewItem[2].items[0].item_category).toBe('千層酥系列');
  });

  test('[regression] 加入購物車 → 觸發 add_to_cart 事件', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
      localStorage.setItem('bb_cart', '[]');
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart-big', { timeout: 8000 });
    await page.click('.btn-add-cart-big');

    const events = await page.evaluate(() => window._ga4Events);
    const addToCart = events.find(e => e[0] === 'event' && e[1] === 'add_to_cart');
    expect(addToCart).toBeTruthy();
  });

  test('[regression] add_to_cart 事件包含正確商品名稱與價格', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
      localStorage.setItem('bb_cart', '[]');
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart-big', { timeout: 8000 });
    await page.click('.btn-add-cart-big');

    const events = await page.evaluate(() => window._ga4Events);
    const addToCart = events.find(e => e[0] === 'event' && e[1] === 'add_to_cart');
    expect(addToCart[2].items[0].item_name).toBe('GA4 測試商品');
    expect(addToCart[2].items[0].price).toBe(250);
    expect(addToCart[2].currency).toBe('TWD');
  });

  test('[regression] add_to_cart 事件 value = 數量 × 價格', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
      localStorage.setItem('bb_cart', '[]');
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/product-detail?id=42', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });

    // 加到 2 件
    await page.click('.qty-btn:has-text("+")');
    await page.click('.btn-add-cart-big');

    const events = await page.evaluate(() => window._ga4Events);
    const addToCart = events.find(e => e[0] === 'event' && e[1] === 'add_to_cart');
    expect(addToCart[2].value).toBe(500); // 250 × 2
    expect(addToCart[2].items[0].quantity).toBe(2);
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('GA4 — 商品列表頁', () => {

  test('[regression] 商品列表加入購物車 → 觸發 add_to_cart 事件', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
      localStorage.setItem('bb_cart', '[]');
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/products', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart', { timeout: 8000 });
    await page.locator('.btn-add-cart').first().click();

    const events = await page.evaluate(() => window._ga4Events);
    const addToCart = events.find(e => e[0] === 'event' && e[1] === 'add_to_cart');
    expect(addToCart).toBeTruthy();
  });

  test('[regression] 商品列表 add_to_cart 包含 item_name', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
      localStorage.setItem('bb_cart', '[]');
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/products', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart', { timeout: 8000 });
    await page.locator('.btn-add-cart').first().click();

    const events = await page.evaluate(() => window._ga4Events);
    const addToCart = events.find(e => e[0] === 'event' && e[1] === 'add_to_cart');
    expect(addToCart[2].items[0].item_name).toBe('GA4 測試商品');
  });

  test('[regression] 商品列表 add_to_cart 包含分類名稱', async ({ page }) => {
    await mockStoreAndCapture(page);
    await page.addInitScript(({ p, cat }) => {
      localStorage.setItem('bb_products', JSON.stringify([p]));
      localStorage.setItem('bb_categories', JSON.stringify([cat]));
      localStorage.setItem('bb_cart', '[]');
    }, { p: TEST_PRODUCT, cat: TEST_CATEGORY });

    await page.goto('/products', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart', { timeout: 8000 });
    await page.locator('.btn-add-cart').first().click();

    const events = await page.evaluate(() => window._ga4Events);
    const addToCart = events.find(e => e[0] === 'event' && e[1] === 'add_to_cart');
    expect(addToCart[2].items[0].item_category).toBe('千層酥系列');
  });

});
