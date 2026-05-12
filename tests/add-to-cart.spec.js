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

async function seedProducts(page) {
  await page.addInitScript((product) => {
    localStorage.setItem('bb_products', JSON.stringify([product]));
    localStorage.setItem('bb_cart', '[]');
  }, SEED_PRODUCT);
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
    await expect(page).toHaveURL(/product-detail\.html\?id=test-001/);
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
