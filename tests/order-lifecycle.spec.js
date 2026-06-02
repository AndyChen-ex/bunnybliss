const { test, expect } = require('@playwright/test');

// ── 常數 ─────────────────────────────────────────────────────────────────────
const ADMIN_PWD = 'bunnybliss';
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
  email: 'e2e-order@bunnybliss.com',
  email_confirmed_at: new Date().toISOString(),
  user_metadata: { name: 'E2E 測試用戶' },
};

const FAKE_SESSION = {
  access_token: FAKE_TOKEN,
  refresh_token: 'mock-refresh-e2e',
  expires_in: 3600,
  expires_at: 9999999999,
  token_type: 'bearer',
  user: TEST_USER,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function injectSession(page) {
  await page.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: `sb-${SUPABASE_PROJECT}-auth-token`, session: FAKE_SESSION });

  await page.route('**/auth/v1/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SESSION) });
  });

  // 預設 mock：profile 空、orders 空（各 test 可覆寫）
  await page.route('**/api/profile', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
  });
  await page.route('**/api/orders', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
  });
}

async function waitForLogin(page) {
  await page.waitForFunction(
    () => window._bbUser?.email === 'e2e-order@bunnybliss.com',
    { timeout: 8000 }
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 完整訂單生命週期 E2E
// ═════════════════════════════════════════════════════════════════════════════

test.describe('訂單生命週期：下單 → 後台管理 → 完成', () => {

  test('完整流程：結帳下單 → 後台更新狀態 → 會員查看', async ({ page }) => {
    test.setTimeout(60000);

    // 動態 mock：捕獲 POST /api/orders，PATCH 更新狀態，GET 回傳訂單
    let capturedOrder = null;

    await injectSession(page);

    // 覆寫 /api/orders（後加的 route 優先）
    await page.route('**/api/orders', async route => {
      const method = route.request().method();
      if (method === 'POST') {
        capturedOrder = route.request().postDataJSON();
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      } else if (method === 'GET') {
        const orders = capturedOrder
          ? [{ ...capturedOrder, created_at: capturedOrder.createdAt }]
          : [];
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orders) });
      } else {
        route.fulfill({ status: 200, body: '{"ok":true}' });
      }
    });

    // mock 後台訂單 API
    await page.route('**/api/admin/orders**', async route => {
      const method = route.request().method();
      if (method === 'GET') {
        const orders = capturedOrder
          ? [{ ...capturedOrder, created_at: capturedOrder.createdAt }]
          : [];
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orders) });
      } else if (method === 'PATCH') {
        const body = route.request().postDataJSON();
        if (capturedOrder) capturedOrder = { ...capturedOrder, status: body.status };
        route.fulfill({ status: 200, body: '{"ok":true}' });
      } else {
        route.continue();
      }
    });

    await page.addInitScript(() => {
      localStorage.setItem('bb_cart', JSON.stringify([{
        id: 'e2e-p1', name: 'E2E 測試餅乾', price: 200, qty: 2, image: '',
      }]));
    });
    await page.route('**/api/store/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    // ── Step 1: 結帳頁 ──────────────────────────────────────────────────────
    await page.goto('/checkout');
    await waitForLogin(page);
    await expect(page.locator('#auth-gate')).not.toHaveClass(/show/);
    await page.waitForSelector('#c-name', { timeout: 8000 });

    await page.fill('#c-name', 'E2E 測試用戶');
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', TEST_USER.email);
    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });
    await page.selectOption('#home-city', '台北市');
    await page.fill('#home-district', '中山區');
    await page.fill('#home-addr', '測試路 1 號');
    await page.locator('input[name=payment]').first().check();

    // ── Step 2: 送出訂單 ─────────────────────────────────────────────────────
    await page.click('button[onclick="submitOrder()"]');
    await page.waitForSelector('#confirm-overlay.show', { timeout: 8000 });
    await expect(page.locator('.confirm-h')).toHaveText('訂單已成立！');

    const orderIdText = await page.locator('#confirm-oid').innerText();
    const orderId = orderIdText.replace('訂單編號：', '').trim();
    expect(orderId.length).toBeGreaterThan(0);

    // 確認訂單被捕獲到 API mock
    await page.waitForFunction(() => true); // flush microtasks
    expect(capturedOrder).not.toBeNull();
    expect(capturedOrder.status).toBe('待付款');

    // ── Step 3: 後台管理 ─────────────────────────────────────────────────────
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-pwd');
    await page.fill('#login-pwd', ADMIN_PWD);
    await page.click('button[onclick="doLogin()"]');
    await page.waitForSelector('#app.visible', { timeout: 8000 });
    await page.evaluate(() => switchPanel('orders'));
    await page.waitForSelector('#panel-orders', { state: 'visible' });
    await expect(page.locator('#orders-tbody')).toContainText(orderId);

    // ── Step 4: 更新狀態 ─────────────────────────────────────────────────────
    const orderRow = page.locator('tr').filter({ hasText: orderId });
    await orderRow.locator('.order-status-select').selectOption('已完成');
    // 等 PATCH 完成（API mock 更新了 capturedOrder）
    await page.waitForFunction(() => true);
    expect(capturedOrder.status).toBe('已完成');

    // ── Step 5: 會員中心查看 ─────────────────────────────────────────────────
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.waitForFunction(
      () => !document.getElementById('orders-wrap')?.textContent?.includes('載入中'),
      { timeout: 8000 }
    );
    await expect(page.locator('#main-wrap')).toBeVisible();
    await expect(page.locator('#orders-wrap')).toContainText(orderId);
    await expect(page.locator(`#order-${orderId} .status-badge`)).toHaveText('已完成');
  });

  // ── 子流程 ──────────────────────────────────────────────────────────────────

  test('[regression] 未登入訪問結帳頁 → 顯示 auth gate', async ({ page }) => {
    await page.route('**/api/store/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });
    await page.goto('/checkout', { waitUntil: 'domcontentloaded' });
    // 等 auth.js 完整初始化（_bbUser 從 undefined 變成 null）
    await page.waitForFunction(() => window._bbUser !== undefined, { timeout: 8000 });
    // 讓 _onAuthChange(null) 完成 DOM 更新（Playwright retry 等到有 show）
    await expect(page.locator('#auth-gate')).toHaveClass(/show/, { timeout: 5000 });
  });

  test('[regression] 未登入訪問會員中心 → 顯示登入提示', async ({ page }) => {
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._bbUser !== undefined, { timeout: 8000 });
    await expect(page.locator('#guest-gate')).toHaveClass(/show/, { timeout: 5000 });
    await expect(page.locator('#main-wrap')).toBeHidden();
  });

  test('[regression] 後台訂單篩選 → 僅顯示該狀態', async ({ page }) => {
    const orders = [
      { id: 'ORD-AAA', created_at: new Date().toISOString(), status: '待付款', customer: { name: 'A', phone: '0911', email: 'a@test.com' }, shipping: { method: 'home', address: '台北', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 100, total: 160 },
      { id: 'ORD-BBB', created_at: new Date().toISOString(), status: '已完成', customer: { name: 'B', phone: '0922', email: 'b@test.com' }, shipping: { method: 'home', address: '台中', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 200, total: 260 },
    ];

    // mock 後台訂單 API
    await page.route('**/api/admin/orders**', async route => {
      if (route.request().method() === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orders) });
      } else if (route.request().method() === 'PATCH') {
        route.fulfill({ status: 200, body: '{"ok":true}' });
      } else { route.continue(); }
    });

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-pwd', ADMIN_PWD);
    await page.click('button[onclick="doLogin()"]');
    await page.waitForSelector('#app.visible');
    await page.evaluate(() => switchPanel('orders'));
    await page.waitForSelector('#panel-orders', { state: 'visible' });
    await page.waitForFunction(() => document.getElementById('orders-tbody')?.textContent?.length > 0);

    await page.evaluate(() => setOrderFilter('已完成'));
    await expect(page.locator('#orders-tbody')).toContainText('ORD-BBB');
    await expect(page.locator('#orders-tbody')).not.toContainText('ORD-AAA');
  });

  test('[regression] 會員只看到自己的訂單', async ({ page }) => {
    const myOrders = [
      { id: 'MY-ORDER', created_at: new Date().toISOString(), status: '待付款', customer: { name: '我', phone: '0911', email: TEST_USER.email }, shipping: { method: 'home', address: '台北', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 100, total: 160 },
    ];

    await injectSession(page);

    // 覆寫 /api/orders 回傳自己的訂單
    await page.route('**/api/orders', route => {
      if (route.request().method() === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(myOrders) });
      } else {
        route.fulfill({ status: 200, body: '{"ok":true}' });
      }
    });

    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.waitForFunction(
      () => !document.getElementById('orders-wrap')?.textContent?.includes('載入中'),
      { timeout: 8000 }
    );
    await expect(page.locator('#orders-wrap')).toContainText('MY-ORDER');
    await expect(page.locator('#orders-wrap')).not.toContainText('OTHER-ORDER');
  });

});
