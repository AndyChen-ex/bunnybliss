const { test, expect } = require('@playwright/test');

// ── 常數 ─────────────────────────────────────────────────────────────────────
const ADMIN_PWD = 'bunnybliss';
const SUPABASE_PROJECT = 'xpnqnkjxxifbrfpshxia';

// 測試用假 JWT（exp: year 2286，讓 getSession() 不觸發 refresh）
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

// 在每次頁面載入前預注入 Supabase session（localStorage），
// 讓 getSession() 直接回傳 session，不需實際 API call
async function injectSession(page) {
  await page.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: `sb-${SUPABASE_PROJECT}-auth-token`, session: FAKE_SESSION });

  // 備援：mock 所有 Supabase auth API 呼叫
  await page.route('**/auth/v1/**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FAKE_SESSION),
    });
  });
}

// 等 auth.js 確認登入狀態
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
    test.setTimeout(60000); // 多步驟 E2E 流程需要較長時間

    // ── Step 1: 注入 session + 購物車，前往結帳頁 ─────────────────────────
    await injectSession(page);

    await page.addInitScript(() => {
      localStorage.setItem('bb_cart', JSON.stringify([{
        id: 'e2e-p1',
        name: 'E2E 測試餅乾',
        price: 200,
        qty: 2,
        image: '',
      }]));
    });

    await page.route('**/api/store/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    await page.goto('/checkout');
    await waitForLogin(page);

    // auth gate 應已隱藏
    await expect(page.locator('#auth-gate')).not.toHaveClass(/show/);

    // 等表單渲染完成
    await page.waitForSelector('#c-name', { timeout: 6000 });

    // ── Step 2: 填寫結帳表單 ───────────────────────────────────────────────
    await page.fill('#c-name', 'E2E 測試用戶');
    await page.fill('#c-phone', '0912345678');
    await page.fill('#c-email', TEST_USER.email);

    // 配送：宅配到府
    await page.locator('input[name=shipping][value=home]').check();
    await page.waitForSelector('#home-city', { state: 'visible' });
    await page.selectOption('#home-city', '台北市');
    await page.fill('#home-district', '中山區');
    await page.fill('#home-addr', '測試路 1 號');

    // 付款：第一個選項（LINE Pay 或 ATM）
    await page.locator('input[name=payment]').first().check();

    // ── Step 3: 送出訂單 ───────────────────────────────────────────────────
    await page.click('button[onclick="submitOrder()"]');

    // 等確認畫面
    await page.waitForSelector('#confirm-overlay.show', { timeout: 8000 });
    await expect(page.locator('.confirm-h')).toHaveText('訂單已成立！');

    // 取得訂單編號
    const orderIdText = await page.locator('#confirm-oid').innerText();
    const orderId = orderIdText.replace('訂單編號：', '').trim();
    expect(orderId.length).toBeGreaterThan(0);

    // 確認訂單存在 localStorage
    const savedOrder = await page.evaluate((id) => {
      const orders = JSON.parse(localStorage.getItem('bb_orders') || '[]');
      return orders.find(o => o.id === id) || null;
    }, orderId);
    expect(savedOrder).not.toBeNull();
    expect(savedOrder.status).toBe('待付款');

    // ── Step 4: 前往後台管理 ───────────────────────────────────────────────
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    // 輸入後台密碼
    await page.waitForSelector('#login-pwd');
    await page.fill('#login-pwd', ADMIN_PWD);
    await page.click('button[onclick="doLogin()"]');

    // 等後台主介面載入
    await page.waitForSelector('#app.visible', { timeout: 8000 });

    // 切換到訂單管理（用 evaluate 避免手機版側邊欄不可見問題）
    await page.evaluate(() => switchPanel('orders'));
    await page.waitForSelector('#panel-orders', { state: 'visible' });

    // 確認訂單出現在表格
    await expect(page.locator('#orders-tbody')).toContainText(orderId);

    // ── Step 5: 更新訂單狀態為「已完成」 ──────────────────────────────────
    // 找到對應訂單的 status select（包含訂單編號的那一行）
    const orderRow = page.locator('tr').filter({ hasText: orderId });
    const statusSelect = orderRow.locator('.order-status-select');
    await statusSelect.selectOption('已完成');

    // 確認 localStorage 已更新
    const updatedStatus = await page.evaluate((id) => {
      return JSON.parse(localStorage.getItem('bb_orders') || '[]')
        .find(o => o.id === id)?.status;
    }, orderId);
    expect(updatedStatus).toBe('已完成');

    // ── Step 6: 前往會員中心查看訂單 ─────────────────────────────────────
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await waitForLogin(page);

    // 主頁面應顯示
    await expect(page.locator('#main-wrap')).toBeVisible();

    // 確認 email 顯示正確
    await expect(page.locator('#profile-email')).toHaveValue(TEST_USER.email);

    // 確認訂單出現
    await expect(page.locator('#orders-wrap')).toContainText(orderId);

    // 確認狀態為「已完成」
    const statusBadge = page.locator(`#order-${orderId} .status-badge`);
    await expect(statusBadge).toHaveText('已完成');
    await expect(statusBadge).toHaveClass(/status-已完成/);
  });

  // ── 子流程測試 ──────────────────────────────────────────────────────────

  test('[regression] 未登入訪問結帳頁 → 顯示 auth gate', async ({ page }) => {
    // 不注入 session，模擬未登入
    await page.route('**/auth/v1/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: null, session: null }),
      });
    });
    await page.goto('/checkout');
    // 等 auth.js 確認為未登入
    await page.waitForFunction(() => window._bbUser === null, { timeout: 8000 });
    await expect(page.locator('#auth-gate')).toHaveClass(/show/);
  });

  test('[regression] 未登入訪問會員中心 → 顯示登入提示', async ({ page }) => {
    await page.route('**/auth/v1/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: null, session: null }),
      });
    });
    await page.goto('/profile');
    await page.waitForFunction(() => window._bbUser === null, { timeout: 8000 });
    await expect(page.locator('#guest-gate')).toHaveClass(/show/);
    await expect(page.locator('#main-wrap')).toBeHidden();
  });

  test('[regression] 後台訂單篩選 → 僅顯示該狀態', async ({ page }) => {
    // 預先注入多筆不同狀態的訂單
    await page.addInitScript(() => {
      localStorage.setItem('bb_orders', JSON.stringify([
        { id: 'ORD-AAA', createdAt: new Date().toISOString(), status: '待付款', customer: { name: 'A', phone: '0911111111', email: 'a@test.com' }, shipping: { method: 'home', address: '台北', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 100, total: 160 },
        { id: 'ORD-BBB', createdAt: new Date().toISOString(), status: '已完成', customer: { name: 'B', phone: '0922222222', email: 'b@test.com' }, shipping: { method: 'home', address: '台中', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 200, total: 260 },
      ]));
    });

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-pwd', ADMIN_PWD);
    await page.click('button[onclick="doLogin()"]');
    await page.waitForSelector('#app.visible');
    await page.evaluate(() => switchPanel('orders'));
    await page.waitForSelector('#panel-orders', { state: 'visible' });

    // 用 evaluate 篩選（避免手機版按鈕不可見）
    await page.evaluate(() => setOrderFilter('已完成'));
    await expect(page.locator('#orders-tbody')).toContainText('ORD-BBB');
    await expect(page.locator('#orders-tbody')).not.toContainText('ORD-AAA');
  });

  test('[regression] 會員只看到自己的訂單', async ({ page }) => {
    await injectSession(page);

    // 注入兩筆訂單：一筆屬於測試用戶，一筆屬於其他人
    await page.addInitScript((userEmail) => {
      localStorage.setItem('bb_orders', JSON.stringify([
        { id: 'MY-ORDER', createdAt: new Date().toISOString(), status: '待付款', customer: { name: '我', phone: '0911', email: userEmail }, shipping: { method: 'home', address: '台北', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 100, total: 160 },
        { id: 'OTHER-ORDER', createdAt: new Date().toISOString(), status: '待付款', customer: { name: '其他人', phone: '0922', email: 'other@test.com' }, shipping: { method: 'home', address: '高雄', fee: 60 }, payment: { method: 'transfer' }, items: [], subtotal: 300, total: 360 },
      ]));
    }, TEST_USER.email);

    await page.goto('/profile');
    await waitForLogin(page);
    await expect(page.locator('#orders-wrap')).toContainText('MY-ORDER');
    await expect(page.locator('#orders-wrap')).not.toContainText('OTHER-ORDER');
  });

});
