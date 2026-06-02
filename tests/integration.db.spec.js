/**
 * DB 整合測試 — 完全不 mock，真實打到 Supabase
 * 執行方式: npx playwright test --config playwright.db.config.js
 *
 * 測試帳號由 global setup (tests/setup/db-setup.js) 建立
 * 每個 test 結束後用 service key 清理測試資料
 */

const { test, expect } = require('@playwright/test');
const {
  TEST_USER,
  getTestSession,
  injectRealSession,
  waitForLogin,
  cleanupOrders,
  cleanupProfile,
  getOrdersFromDB,
  getProfileFromDB,
} = require('./setup/db-helpers');

// ═════════════════════════════════════════════════════════════════════════════
// 1. Auth — 真實 Supabase 登入
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Auth（真實 DB）', () => {

  test('[DB] 正確帳密登入 → Supabase 回傳真實 session', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window._sb, { timeout: 8000 });

    await page.evaluate(() => openAuth('login'));
    await page.waitForSelector('#auth-overlay.active');

    await page.fill('#login-email', TEST_USER.email);
    await page.fill('#login-pass', TEST_USER.password);
    await page.click('button[onclick="doLogin()"]');

    // 等真實登入完成（_bbUser 被 Supabase session 填入）
    await page.waitForFunction(
      (email) => window._bbUser?.email === email,
      TEST_USER.email,
      { timeout: 10000 }
    );

    // 確認 Supabase 給的是真實 user（有 id）
    const userId = await page.evaluate(() => window._bbUser?.id);
    expect(userId).toBeTruthy();
    expect(userId).not.toBe('mock');
  });

  test('[DB] 錯誤密碼 → Supabase 回傳 invalid credentials', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => !!window._sb, { timeout: 8000 });

    await page.evaluate(() => openAuth('login'));
    await page.waitForSelector('#auth-overlay.active');

    await page.fill('#login-email', TEST_USER.email);
    await page.fill('#login-pass', 'wrong-password-123');
    await page.click('button[onclick="doLogin()"]');

    await page.waitForSelector('#toast.show', { timeout: 8000 });
    const toast = await page.locator('#toast').innerText();
    expect(toast).toContain('電子信箱或密碼錯誤');
  });

  test('[DB] check-email API → 真實查詢 Supabase 用戶列表', async ({ page }) => {
    // 用已存在的 email
    const res = await page.request.post('/api/check-email', {
      data: { email: TEST_USER.email },
    });
    const body = await res.json();
    expect(body.exists).toBe(true);
  });

  test('[DB] check-email 不存在的 email → false', async ({ page }) => {
    const res = await page.request.post('/api/check-email', {
      data: { email: `not-exists-${Date.now()}@example.com` },
    });
    const body = await res.json();
    expect(body.exists).toBe(false);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Profile — 真實讀寫 profiles 表
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Profile（真實 DB）', () => {

  test.afterEach(async () => {
    await cleanupProfile();
  });

  test('[DB] 儲存姓名與電話 → 真實寫入 profiles 表', async ({ page }) => {
    const session = await getTestSession();
    await injectRealSession(page, session);

    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.waitForFunction(
      () => !document.getElementById('orders-wrap')?.textContent?.includes('載入中'),
      { timeout: 8000 }
    );

    const newName = `測試姓名_${Date.now()}`;
    const newPhone = '0912345678';

    await page.fill('#profile-name', newName);
    await page.fill('#profile-phone', newPhone);
    await page.click('#btn-save-profile');

    await page.waitForSelector('#toast.show', { timeout: 8000 });
    const toast = await page.locator('#toast').innerText();
    expect(toast).toBe('資料已更新！');

    // 直接查 DB 確認資料真的有寫入
    const profile = await getProfileFromDB();
    expect(profile).not.toBeNull();
    expect(profile.name).toBe(newName);
    expect(profile.phone).toBe(newPhone);
    expect(profile.email).toBe(TEST_USER.email);
  });

  test('[DB] GET /api/profile → 回傳剛存入的資料', async ({ page }) => {
    const session = await getTestSession();

    // 先用 API 寫入 profile
    await page.request.post('/api/profile', {
      data: { name: 'API Test', phone: '0987654321' },
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    // 再用 GET 讀取
    const res = await page.request.get('/api/profile', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const profile = await res.json();
    expect(profile.name).toBe('API Test');
    expect(profile.phone).toBe('0987654321');
  });

  test('[DB] PATCH /api/profile → 部分更新', async ({ page }) => {
    const session = await getTestSession();

    // 先建立初始資料
    await page.request.post('/api/profile', {
      data: { name: '初始姓名', phone: '0900000000' },
      headers: { Authorization: `Bearer ${session.access_token}` },
    });

    // 只更新電話
    await page.request.patch('/api/profile', {
      data: { phone: '0911111111' },
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    });

    const profile = await getProfileFromDB();
    expect(profile.name).toBe('初始姓名'); // 姓名不變
    expect(profile.phone).toBe('0911111111'); // 電話更新
  });

  test('[DB] 未授權請求 → 回傳 401', async ({ page }) => {
    const res = await page.request.get('/api/profile');
    expect(res.status()).toBe(401);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Orders — 真實讀寫 orders 表
// ═════════════════════════════════════════════════════════════════════════════

test.describe('Orders（真實 DB）', () => {

  test.afterEach(async () => {
    await cleanupOrders();
  });

  test('[DB] POST /api/orders → 訂單寫入 Supabase', async ({ page }) => {
    const session = await getTestSession();

    const order = {
      id: `DB-TEST-${Date.now()}`,
      createdAt: new Date().toISOString(),
      status: '待付款',
      customer: { name: TEST_USER.name, phone: '0912345678', email: TEST_USER.email },
      shipping: { method: 'home', address: '台北市中山區測試路1號', fee: 60 },
      payment: { method: 'transfer' },
      items: [{ id: 'p1', name: '測試餅乾', price: 200, qty: 2, image: '' }],
      subtotal: 400,
      total: 460,
    };

    const res = await page.request.post('/api/orders', {
      data: order,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // 直接查 DB 確認訂單存在
    const orders = await getOrdersFromDB();
    const saved = orders.find(o => o.id === order.id);
    expect(saved).toBeDefined();
    expect(saved.status).toBe('待付款');
    expect(saved.total).toBe(460);
    expect(saved.user_email).toBe(TEST_USER.email);
  });

  test('[DB] GET /api/orders → 回傳自己的訂單', async ({ page }) => {
    const session = await getTestSession();

    // 先寫入兩筆訂單
    for (let i = 0; i < 2; i++) {
      await page.request.post('/api/orders', {
        data: {
          id: `DB-GET-TEST-${i}-${Date.now()}`,
          createdAt: new Date().toISOString(),
          status: '待付款',
          customer: { name: TEST_USER.name, phone: '0912', email: TEST_USER.email },
          shipping: { method: 'home', address: '台北', fee: 60 },
          payment: { method: 'transfer' },
          items: [],
          subtotal: 100,
          total: 160,
        },
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      });
    }

    // 讀取訂單
    const res = await page.request.get('/api/orders', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const orders = await res.json();
    expect(orders.length).toBeGreaterThanOrEqual(2);
    // 確認只有自己的訂單
    orders.forEach(o => expect(o.user_email).toBe(TEST_USER.email));
  });

  test('[DB] 未授權 GET /api/orders → 401', async ({ page }) => {
    const res = await page.request.get('/api/orders');
    expect(res.status()).toBe(401);
  });

  test('[DB] Profile 頁面顯示真實訂單', async ({ page }) => {
    const session = await getTestSession();
    const orderId = `DB-PROFILE-${Date.now()}`;

    // 先寫入一筆訂單
    await page.request.post('/api/orders', {
      data: {
        id: orderId,
        createdAt: new Date().toISOString(),
        status: '已付款',
        customer: { name: TEST_USER.name, phone: '0912', email: TEST_USER.email },
        shipping: { method: 'home', address: '台北', fee: 60 },
        payment: { method: 'transfer' },
        items: [{ id: 'p1', name: '真實測試餅乾', price: 300, qty: 1, image: '' }],
        subtotal: 300,
        total: 360,
      },
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    });

    // 注入 session 到瀏覽器，前往 profile
    await injectRealSession(page, session);
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.waitForFunction(
      () => !document.getElementById('orders-wrap')?.textContent?.includes('載入中'),
      { timeout: 10000 }
    );

    // 確認訂單顯示在 UI
    await expect(page.locator('#orders-wrap')).toContainText(orderId);
    await expect(page.locator('#orders-wrap')).toContainText('已付款');
    await expect(page.locator('.status-badge')).toHaveClass(/status-已付款/);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 4. 完整訂單生命週期 — 前端到 DB 到 Admin 到 Profile
// ═════════════════════════════════════════════════════════════════════════════

test.describe('完整訂單生命週期（真實 DB）', () => {
  test.setTimeout(90000);

  test.afterEach(async () => {
    await cleanupOrders();
  });

  test('[DB E2E] 結帳 → DB → 後台更新狀態 → Profile 查看', async ({ page }) => {
    const session = await getTestSession();
    await injectRealSession(page, session);

    // 注入購物車
    await page.addInitScript(() => {
      localStorage.setItem('bb_cart', JSON.stringify([{
        id: 'db-e2e-p1',
        name: 'DB整合測試餅乾',
        price: 250,
        qty: 1,
        image: '',
      }]));
    });

    // ── Step 1: 前往結帳頁 ────────────────────────────────────────────────
    await page.goto('/checkout');
    await waitForLogin(page);
    await expect(page.locator('#auth-gate')).not.toHaveClass(/show/);
    await page.waitForSelector('#c-name', { timeout: 8000 });

    // 填寫表單
    await page.fill('#c-name', TEST_USER.name);
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', TEST_USER.email);
    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });
    await page.selectOption('#home-city', '台北市');
    await page.fill('#home-district', '中山區');
    await page.fill('#home-addr', 'DB整合測試路1號');
    await page.locator('input[name=payment]').first().check();

    // ── Step 2: 送出訂單 → 寫入 Supabase ─────────────────────────────────
    await page.click('button[onclick="submitOrder()"]');
    await page.waitForSelector('#confirm-overlay.show', { timeout: 10000 });
    await expect(page.locator('.confirm-h')).toHaveText('訂單已成立！');

    const orderIdText = await page.locator('#confirm-oid').innerText();
    const orderId = orderIdText.replace('訂單編號：', '').trim();
    expect(orderId).toBeTruthy();

    // 確認訂單真的在 DB
    const dbOrders = await getOrdersFromDB();
    const dbOrder = dbOrders.find(o => o.id === orderId);
    expect(dbOrder).toBeDefined();
    expect(dbOrder.status).toBe('待付款');
    expect(dbOrder.user_email).toBe(TEST_USER.email);
    expect(dbOrder.total).toBe(310); // 250 + 60 shipping

    // ── Step 3: 後台更新狀態 ─────────────────────────────────────────────
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-pwd', 'bunnybliss');
    await page.click('button[onclick="doLogin()"]');
    await page.waitForSelector('#app.visible', { timeout: 8000 });
    await page.evaluate(() => switchPanel('orders'));
    await page.waitForSelector('#panel-orders', { state: 'visible' });

    // 等訂單出現（從真實 DB 載入）
    await page.waitForFunction(
      (id) => document.getElementById('orders-tbody')?.textContent?.includes(id),
      orderId,
      { timeout: 10000 }
    );

    // 更新狀態為「已出貨」
    const orderRow = page.locator('tr').filter({ hasText: orderId });
    await orderRow.locator('.order-status-select').selectOption('已出貨');

    // 等 PATCH 打到真實 DB（給點時間）
    await page.waitForTimeout(500);

    // 直接查 DB 確認狀態已更新
    const updatedOrders = await getOrdersFromDB();
    const updatedOrder = updatedOrders.find(o => o.id === orderId);
    expect(updatedOrder.status).toBe('已出貨');

    // ── Step 4: Profile 查看最終狀態 ─────────────────────────────────────
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);
    await page.waitForFunction(
      () => !document.getElementById('orders-wrap')?.textContent?.includes('載入中'),
      { timeout: 10000 }
    );

    await expect(page.locator('#orders-wrap')).toContainText(orderId);
    await expect(page.locator(`#order-${orderId} .status-badge`)).toHaveText('已出貨');
  });

});
