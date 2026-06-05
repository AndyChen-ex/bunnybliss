const { test, expect } = require('@playwright/test');

const TEST_PRODUCT = {
  id: 99,
  active: true,
  name: '測試捲捲棒',
  price: 350,
  desc: '這是測試商品描述',
  image: '',
  images: [],
  badge: '',
  badgeColor: '',
  order: 0,
  categoryId: 1,
};

const TEST_CATEGORY = { id: 1, name: '捲捲棒系列', color: '#f2b8c6', order: 0 };

async function setupProductDetail(page, product = TEST_PRODUCT) {
  await page.addInitScript(({ p, cat }) => {
    localStorage.setItem('bb_products', JSON.stringify([p]));
    localStorage.setItem('bb_categories', JSON.stringify([cat]));
    localStorage.setItem('bb_cart', '[]');
  }, { p: product, cat: TEST_CATEGORY });

  await page.route('**/api/store/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.route('**/auth/v1/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null, session: null }) });
  });
}

// ═══════════════════════════════════════════════════════════════
test.describe('商品詳情頁 — 渲染', () => {

  test('[regression] 顯示商品名稱', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-name', { timeout: 8000 });
    await expect(page.locator('.detail-name')).toHaveText('測試捲捲棒');
  });

  test('[regression] 顯示商品價格', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-price-display', { timeout: 8000 });
    await expect(page.locator('#detail-price-display')).toContainText('NT$350');
  });

  test('[regression] 麵包屑顯示商品名稱', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.breadcrumb', { timeout: 8000 });
    await expect(page.locator('.breadcrumb')).toContainText('測試捲捲棒');
  });

  test('[regression] 分類標籤顯示', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-cat-tag', { timeout: 8000 });
    await expect(page.locator('.detail-cat-tag')).toContainText('捲捲棒系列');
  });

  test('[edge] 無效商品 id → 顯示找不到商品', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=9999', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.not-found', { timeout: 8000 });
    await expect(page.locator('.not-found')).toContainText('找不到此商品');
  });

  test('[edge] 無效商品頁有「回到商品列表」連結', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=9999', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.not-found', { timeout: 8000 });
    await expect(page.locator('.btn-back[href="/products"]')).toBeVisible();
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('商品詳情頁 — 數量控制', () => {

  test('[regression] 預設數量為 1', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });
    await expect(page.locator('#detail-qty')).toHaveValue('1');
  });

  test('[regression] 點 + → 數量增加', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });

    await page.click('.qty-btn:has-text("＋"), .qty-btn:has-text("+")');
    await expect(page.locator('#detail-qty')).toHaveValue('2');
  });

  test('[regression] 點 − → 數量減少', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });

    // 先加到 2
    await page.click('.qty-btn:has-text("＋"), .qty-btn:has-text("+")');
    await expect(page.locator('#detail-qty')).toHaveValue('2');

    // 再減回 1
    await page.click('.qty-btn:has-text("−")');
    await expect(page.locator('#detail-qty')).toHaveValue('1');
  });

  test('[regression] 數量最小為 1，點 − 不會低於 1', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });

    await page.click('.qty-btn:has-text("−")');
    await expect(page.locator('#detail-qty')).toHaveValue('1');
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('商品詳情頁 — 加入購物車', () => {

  test('[regression] 加入購物車 → toast 顯示商品名稱', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart-big', { timeout: 8000 });

    await page.click('.btn-add-cart-big');
    await expect(page.locator('#toast')).toContainText('測試捲捲棒');
  });

  test('[regression] 加入購物車 → badge 數字 +1', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart-big', { timeout: 8000 });

    await expect(page.locator('#cart-badge')).not.toHaveClass(/visible/);
    await page.click('.btn-add-cart-big');
    await expect(page.locator('#cart-badge')).toHaveClass(/visible/);
    await expect(page.locator('#cart-badge')).toHaveText('1');
  });

  test('[regression] 數量 3 加入購物車 → badge 顯示 3', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });

    // 加到 3
    await page.click('.qty-btn:has-text("+")');
    await page.click('.qty-btn:has-text("+")');
    await expect(page.locator('#detail-qty')).toHaveValue('3');

    await page.click('.btn-add-cart-big');
    await expect(page.locator('#cart-badge')).toHaveText('3');
  });

  test('[regression] 加入購物車 → toast 顯示數量', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#detail-qty', { timeout: 8000 });

    await page.click('.qty-btn:has-text("+")');
    await page.click('.btn-add-cart-big');
    await expect(page.locator('#toast')).toContainText('× 2');
  });

  test('[regression] 重複加入購物車 → 數量累加（不重複建立）', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart-big', { timeout: 8000 });

    await page.click('.btn-add-cart-big');
    await page.click('.btn-add-cart-big');

    const cartLen = await page.evaluate(() => {
      const cart = JSON.parse(localStorage.getItem('bb_cart') || '[]');
      return cart.length;
    });
    expect(cartLen).toBe(1); // 同一商品合併，不新增第二筆

    await expect(page.locator('#cart-badge')).toHaveText('2');
  });

  test('[regression] 加入購物車 → 購物車抽屜內有商品', async ({ page }) => {
    await setupProductDetail(page);
    await page.goto('/product-detail?id=99', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.btn-add-cart-big', { timeout: 8000 });

    await page.click('.btn-add-cart-big');
    await page.click('#cart-badge');  // 點 badge 或購物車按鈕
    await expect(page.locator('#cart-drawer')).toHaveClass(/open/);
    await expect(page.locator('#cart-items-list')).toContainText('測試捲捲棒');
  });

});
