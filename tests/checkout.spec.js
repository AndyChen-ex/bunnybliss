const { test, expect } = require('@playwright/test');

const SUPABASE_PROJECT = 'xpnqnkjxxifbrfpshxia';

const FAKE_TOKEN = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiJlMmUtdXNlci1pZCIsImF1ZCI6ImF1dGhlbnRpY2F0ZWQiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImV4cCI6OTk5OTk5OTk5OX0',
  'mock_signature',
].join('.');

const TEST_USER = {
  id: 'e2e-user-id',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'checkout-test@bunnybliss.com',
  email_confirmed_at: new Date().toISOString(),
  user_metadata: { name: '結帳測試用戶', phone: '0987654321' },
};

const FAKE_SESSION = {
  access_token: FAKE_TOKEN,
  refresh_token: 'mock-refresh',
  expires_in: 3600,
  expires_at: 9999999999,
  token_type: 'bearer',
  user: TEST_USER,
};

const CART_ITEMS = [
  { name: '捲捲棒（原味）', price: 280, qty: 1, image: '' },
  { name: '巧克力捲捲棒',   price: 300, qty: 2, image: '' },
];

async function injectSession(page) {
  await page.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: `sb-${SUPABASE_PROJECT}-auth-token`, session: FAKE_SESSION });

  await page.route('**/auth/v1/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SESSION) });
  });
  await page.route('**/api/profile', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: '結帳測試用戶', phone: '0987654321' }) });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
  });
  await page.route('**/api/orders', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/store/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
}

async function setupCheckout(page, cartItems = CART_ITEMS) {
  await injectSession(page);
  await page.addInitScript((items) => {
    localStorage.setItem('bb_cart', JSON.stringify(items));
  }, cartItems);
}

async function waitForForm(page) {
  await page.waitForFunction(() => window._bbUser?.email, { timeout: 8000 });
  await page.waitForSelector('#c-name', { timeout: 8000 });
}

// ═══════════════════════════════════════════════════════════════
test.describe('結帳頁 — 購物車狀態', () => {

  test('[regression] 空購物車 → 顯示空狀態', async ({ page }) => {
    await injectSession(page);
    await page.addInitScript(() => localStorage.setItem('bb_cart', '[]'));
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._bbUser !== undefined, { timeout: 8000 });
    await expect(page.locator('#main .empty-state')).toBeVisible();
    await expect(page.locator('#main .empty-state')).toContainText('購物車是空的');
  });

  test('[regression] 空購物車 → 有「前往商品頁」連結', async ({ page }) => {
    await injectSession(page);
    await page.addInitScript(() => localStorage.setItem('bb_cart', '[]'));
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._bbUser !== undefined, { timeout: 8000 });
    const link = page.locator('#main a[href="/products"]');
    await expect(link).toBeVisible();
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('結帳頁 — 訂單金額', () => {

  test('[regression] 小計 = 商品金額加總', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);
    // 280×1 + 300×2 = 880
    await expect(page.locator('.sum-row').first()).toContainText('NT$880');
  });

  test('[regression] 運費顯示 NT$60', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);
    await expect(page.locator('.sum-row').nth(1)).toContainText('NT$60');
  });

  test('[regression] 總計 = 小計 + 運費', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);
    // 880 + 60 = 940
    await expect(page.locator('.sum-total .amt')).toHaveText('NT$940');
  });

  test('[regression] 訂單明細顯示商品名稱', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);
    await expect(page.locator('.summary-items')).toContainText('捲捲棒（原味）');
    await expect(page.locator('.summary-items')).toContainText('巧克力捲捲棒');
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('結帳頁 — 表單驗證', () => {

  // 驗證失敗時顯示 .ferr 元素（非 toast）並阻止下單
  test('[regression] 未填姓名 → 顯示錯誤提示、不送出訂單', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', 'test@example.com');
    await page.click('button[onclick="submitOrder()"]');

    await expect(page.locator('.ferr')).toContainText('姓名');
    await expect(page.locator('#confirm-overlay')).not.toHaveClass(/show/);
  });

  test('[regression] 電話少於 10 碼 → 顯示錯誤提示', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.fill('#c-name', '測試用戶');
    await page.fill('#c-phone', '091');
    await page.fill('#c-email', 'test@example.com');
    await page.click('button[onclick="submitOrder()"]');

    await expect(page.locator('.ferr')).toContainText('10 碼');
  });

  test('[regression] 未選配送方式 → 顯示錯誤提示', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.fill('#c-name', '測試用戶');
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', 'test@example.com');
    await page.click('button[onclick="submitOrder()"]');

    await expect(page.locator('.ferr')).toContainText('配送');
  });

  test('[regression] 選宅急便但未填縣市 → 顯示錯誤提示', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.fill('#c-name', '測試用戶');
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', 'test@example.com');
    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });
    await page.click('button[onclick="submitOrder()"]');

    await expect(page.locator('.ferr')).toContainText('縣市');
  });

  test('[regression] 選宅急便填縣市後未填地址 → 顯示錯誤提示', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.fill('#c-name', '測試用戶');
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', 'test@example.com');
    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });
    await page.selectOption('#home-city', '臺北市');
    await page.waitForFunction(() => document.getElementById('home-district')?.options.length > 1);
    await page.locator('#home-district').selectOption({ index: 1 });
    await page.click('button[onclick="submitOrder()"]');

    await expect(page.locator('.ferr')).toContainText('地址');
  });

  test('[regression] 未選付款方式 → 顯示錯誤提示', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.fill('#c-name', '測試用戶');
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', 'test@example.com');
    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });
    await page.selectOption('#home-city', '臺北市');
    await page.waitForFunction(() => document.getElementById('home-district')?.options.length > 1);
    await page.locator('#home-district').selectOption({ index: 1 });
    await page.fill('#home-addr', '中正路 1 號');
    await page.click('button[onclick="submitOrder()"]');

    await expect(page.locator('.ferr')).toContainText('付款');
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('結帳頁 — 城市地區級聯', () => {

  test('[regression] 選擇縣市後地區下拉有選項', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });

    const districtBefore = await page.locator('#home-district').evaluate(el => el.options.length);
    expect(districtBefore).toBe(1); // 只有預設「請先選縣市」

    await page.selectOption('#home-city', '臺北市');
    await page.waitForFunction(() => document.getElementById('home-district')?.options.length > 1);

    const districtAfter = await page.locator('#home-district').evaluate(el => el.options.length);
    expect(districtAfter).toBeGreaterThan(1);
  });

  test('[regression] 更換縣市 → 地區選項重置', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });

    await page.selectOption('#home-city', '臺北市');
    await page.waitForFunction(() => document.getElementById('home-district')?.options.length > 1);
    await page.locator('#home-district').selectOption({ index: 1 });

    // 切換到其他縣市
    await page.selectOption('#home-city', '高雄市');
    await page.waitForFunction(
      () => !document.getElementById('home-district')?.options[1]?.value.includes('松')
    );
    const districtVal = await page.locator('#home-district').inputValue();
    expect(districtVal).toBe(''); // 重置為空
  });

});

// ═══════════════════════════════════════════════════════════════
test.describe('結帳頁 — 自動填入', () => {

  test('[regression] 登入後顯示自動填入選項', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);
    await expect(page.locator('#autofill-row')).toBeVisible();
  });

  test('[regression] 勾選自動填入 → 姓名填入', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.locator('#autofill-cb').check();
    await expect(page.locator('#c-name')).toHaveValue('結帳測試用戶');
  });

  test('[regression] 勾選自動填入 → email 填入', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.locator('#autofill-cb').check();
    await expect(page.locator('#c-email')).toHaveValue('checkout-test@bunnybliss.com');
  });

  test('[regression] 取消勾選 → 欄位清空', async ({ page }) => {
    await setupCheckout(page);
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    await waitForForm(page);

    await page.locator('#autofill-cb').check();
    await expect(page.locator('#c-name')).not.toHaveValue('');

    await page.locator('#autofill-cb').uncheck();
    await expect(page.locator('#c-name')).toHaveValue('');
    await expect(page.locator('#c-email')).toHaveValue('');
  });

});
