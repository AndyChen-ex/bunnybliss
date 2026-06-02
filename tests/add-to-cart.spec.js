const { test, expect } = require('@playwright/test');

// 測試用假商品，注入到 localStorage
const SEED_PRODUCT = {
  id: 'test-001',
  name: '測試餅乾',
  desc: '測試用商品',
  price: 200,
  active: true,
  images: [],
  image: '',
  badge: '',
  priceTiers: [],
};

const SEED_PRODUCTS_MULTI = [
  { id: 'p1', name: '便宜餅乾', desc: '', price: 100, active: true, images: [], image: '', badge: '', priceTiers: [] },
  { id: 'p2', name: '中價餅乾', desc: '', price: 300, active: true, images: [], image: '', badge: '', priceTiers: [] },
  { id: 'p3', name: '貴的餅乾', desc: '', price: 600, active: true, images: [], image: '', badge: '', priceTiers: [] },
];

async function seedProducts(page) {
  await page.addInitScript((product) => {
    localStorage.setItem('bb_products', JSON.stringify([product]));
    localStorage.setItem('bb_cart', '[]');
  }, SEED_PRODUCT);
}

async function seedMultiProducts(page) {
  // Mock API so page always gets exactly our test products (不受真實 Supabase 資料影響)
  await page.route('**/api/store/products', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SEED_PRODUCTS_MULTI),
    });
  });
}

// 直接呼叫 JS 函式套用篩選，不依賴 DOM 可見性（桌機/手機皆可用）
async function applyPriceFilter(page, min = null, max = null) {
  await page.evaluate(({ min, max }) => {
    const minEl = document.getElementById('price-min');
    const maxEl = document.getElementById('price-max');
    if (min !== null) minEl.value = String(min);
    if (max !== null) maxEl.value = String(max);
    applyFilter();
  }, { min, max });
}

test.describe('首頁 + 按鈕加入購物車', () => {
  test('桌機：點 + 不跳頁，購物車數量 +1', async ({ page }) => {
    await seedProducts(page);
    await page.goto('/');
    await page.waitForSelector('.btn-add-cart');

    const initialUrl = page.url();
    await page.locator('.btn-add-cart').first().click();

    // 不跳頁
    expect(page.url()).toBe(initialUrl);

    // 購物車 badge 顯示 1
    await expect(page.locator('#cart-badge')).toHaveText('1');
  });

  test('手機：tap + 不跳頁，購物車數量 +1', async ({ page, isMobile }) => {
    test.skip(!isMobile, '僅在手機 project 執行');
    await seedProducts(page);
    await page.goto('/');
    await page.waitForSelector('.btn-add-cart');

    const initialUrl = page.url();
    await page.locator('.btn-add-cart').first().tap();

    expect(page.url()).toBe(initialUrl);
    await expect(page.locator('#cart-badge')).toHaveText('1');
  });

  test('連點兩次 +，購物車數量變 2', async ({ page }) => {
    await seedProducts(page);
    await page.goto('/');
    await page.waitForSelector('.btn-add-cart');

    await page.locator('.btn-add-cart').first().click();
    await page.locator('.btn-add-cart').first().click();

    await expect(page.locator('#cart-badge')).toHaveText('2');
  });

  test('點商品圖片跳轉到詳細頁', async ({ page }) => {
    await seedProducts(page);
    await page.goto('/');
    await page.waitForSelector('.product-card');

    await page.locator('.product-card a').first().click();
    await expect(page).toHaveURL(/product-detail/);
  });
});

test.describe('商品頁 + 按鈕加入購物車', () => {
  test('桌機：點 + 不跳頁，購物車數量 +1', async ({ page }) => {
    await seedProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.btn-add-cart');

    const initialUrl = page.url();
    await page.locator('.btn-add-cart').first().click();

    expect(page.url()).toBe(initialUrl);
    await expect(page.locator('#cart-badge')).toHaveText('1');
  });

  test('手機：tap + 不跳頁，購物車數量 +1', async ({ page, isMobile }) => {
    test.skip(!isMobile, '僅在手機 project 執行');
    await seedProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.btn-add-cart');

    const initialUrl = page.url();
    await page.locator('.btn-add-cart').first().tap();

    expect(page.url()).toBe(initialUrl);
    await expect(page.locator('#cart-badge')).toHaveText('1');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 價格篩選測試
// ═════════════════════════════════════════════════════════════════════════════

test.describe('商品頁價格篩選', () => {

  test('[regression] 套用最低價篩選 → 只顯示符合的商品', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await applyPriceFilter(page, 250, null);
    await expect(page.locator('.product-card')).toHaveCount(2); // 300 和 600
  });

  test('[regression] 套用最高價篩選 → 只顯示符合的商品', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await applyPriceFilter(page, null, 200);
    await expect(page.locator('.product-card')).toHaveCount(1); // 只有 100
  });

  test('[regression] 套用區間篩選', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await applyPriceFilter(page, 150, 400);
    await expect(page.locator('.product-card')).toHaveCount(1); // 只有 300
  });

  test('[regression] 套用篩選後清除 → 顯示全部商品', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await applyPriceFilter(page, 500, null);
    await expect(page.locator('.product-card')).toHaveCount(1);

    await page.evaluate(() => clearFilter());
    await expect(page.locator('.product-card')).toHaveCount(3);
  });

  test('[regression] 套用篩選後清除 → 輸入欄清空', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await applyPriceFilter(page, 200, 500);
    await page.evaluate(() => clearFilter());

    const vals = await page.evaluate(() => ({
      min: document.getElementById('price-min').value,
      max: document.getElementById('price-max').value,
    }));
    expect(vals.min).toBe('');
    expect(vals.max).toBe('');
  });

  test('[edge] 清除按鈕預設隱藏、套用後顯示', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    const hiddenBefore = await page.evaluate(() =>
      document.getElementById('btn-clear-filter').style.display === 'none'
    );
    expect(hiddenBefore).toBe(true);

    await applyPriceFilter(page, 100, null);
    const visibleAfter = await page.evaluate(() =>
      document.getElementById('btn-clear-filter').style.display !== 'none'
    );
    expect(visibleAfter).toBe(true);
  });

  test('[edge] 欄位空白套用 → 清除按鈕保持隱藏', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await page.evaluate(() => applyFilter());
    const hidden = await page.evaluate(() =>
      document.getElementById('btn-clear-filter').style.display === 'none'
    );
    expect(hidden).toBe(true);
  });

  test('[edge] 無商品符合篩選 → 商品清單為空', async ({ page }) => {
    await seedMultiProducts(page);
    await page.goto('/products.html');
    await page.waitForSelector('.product-card');

    await applyPriceFilter(page, 9999, null);
    await expect(page.locator('.product-card')).toHaveCount(0);

    const clearVisible = await page.evaluate(() =>
      document.getElementById('btn-clear-filter').style.display !== 'none'
    );
    expect(clearVisible).toBe(true);
  });

});
