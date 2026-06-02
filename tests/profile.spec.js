const { test, expect } = require('@playwright/test');

// ── 常數 & 假資料 ──────────────────────────────────────────────────────────────
const SUPABASE_PROJECT = 'xpnqnkjxxifbrfpshxia';
const FAKE_TOKEN = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiJwcm9maWxlLXVzZXIiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjk5OTk5OTk5OTl9',
  'mock_sig',
].join('.');

const TEST_USER = {
  id: 'profile-user-id',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'profile-test@bunnybliss.com',
  email_confirmed_at: new Date().toISOString(),
  user_metadata: { name: '測試會員' },
};

const FAKE_SESSION = {
  access_token: FAKE_TOKEN,
  refresh_token: 'mock-refresh-profile',
  expires_in: 3600,
  expires_at: 9999999999,
  token_type: 'bearer',
  user: TEST_USER,
};

function makeOrder(overrides = {}) {
  return {
    id: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    created_at: new Date().toISOString(),
    status: '待付款',
    customer: { name: '測試會員', phone: '0912345678', email: TEST_USER.email },
    shipping: { method: 'home', address: '台北市中山區測試路1號', fee: 60 },
    payment: { method: 'transfer' },
    items: [{ id: 'p1', name: '測試餅乾', price: 200, qty: 2, image: '' }],
    subtotal: 400,
    total: 460,
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function injectSession(page, user = TEST_USER) {
  const session = { ...FAKE_SESSION, user };
  await page.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: `sb-${SUPABASE_PROJECT}-auth-token`, session });

  await page.route('**/auth/v1/**', route => {
    const url = route.request().url();
    if (url.includes('/user') && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON?.() || {};
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...user, user_metadata: { ...user.user_metadata, ...body.data } }),
      });
    } else if (url.includes('/logout')) {
      route.fulfill({ status: 204, body: '' });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    }
  });

  // 預設 mock：profile 無資料、orders 空陣列
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

// 覆寫 /api/orders GET 回傳指定訂單（需在 injectSession 之後呼叫，後加的 route 優先）
async function mockOrders(page, orders) {
  await page.route('**/api/orders', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(orders) });
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
  });
}

async function waitForLogin(page) {
  await page.waitForFunction(() => window._bbUser !== undefined, { timeout: 8000 });
}

async function gotoProfile(page) {
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await waitForLogin(page);
  // 等訂單區塊完成渲染（不再顯示「載入中…」）
  await page.waitForFunction(
    () => {
      const w = document.getElementById('orders-wrap');
      return w && !w.textContent.includes('載入中');
    },
    { timeout: 8000 }
  );
}

async function getToast(page) {
  await page.waitForSelector('#toast.show', { timeout: 6000 });
  return page.locator('#toast').innerText();
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Auth / Guest gate
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — Auth 狀態', () => {

  test('[regression] 未登入 → guest gate 顯示、主內容隱藏', async ({ page }) => {
    await page.route('**/auth/v1/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null, session: null }) });
    });
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._bbUser === null, { timeout: 8000 });

    await expect(page.locator('#guest-gate')).toHaveClass(/show/);
    await expect(page.locator('#main-wrap')).toBeHidden();
  });

  test('[regression] 未登入 → guest gate 有「前往登入」連結', async ({ page }) => {
    await page.route('**/auth/v1/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null, session: null }) });
    });
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window._bbUser === null, { timeout: 8000 });

    await expect(page.locator('#guest-gate a[href="/"]')).toBeVisible();
  });

  test('[regression] 登入後 → guest gate 隱藏、主內容顯示', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await expect(page.locator('#guest-gate')).not.toHaveClass(/show/);
    await expect(page.locator('#main-wrap')).toBeVisible();
  });

  test('[regression] 登入後 → email 顯示正確', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await expect(page.locator('#profile-email')).toHaveValue(TEST_USER.email);
  });

  test('[regression] 登入後 → 姓名預填來自 user_metadata', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await expect(page.locator('#profile-name')).toHaveValue(TEST_USER.user_metadata.name);
  });

  test('[regression] email 欄位為 readonly（不可編輯）', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    const isReadonly = await page.locator('#profile-email').getAttribute('readonly');
    expect(isReadonly).not.toBeNull();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 2. 儲存個人資料
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — 儲存個人資料', () => {

  test('[regression] 合法姓名 → 呼叫 updateUser、toast 成功', async ({ page }) => {
    let updateCalled = false;
    await injectSession(page);
    await page.route('**/auth/v1/user', route => {
      if (route.request().method() === 'PUT') {
        updateCalled = true;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_USER) });
      } else { route.continue(); }
    });
    await gotoProfile(page);

    await page.fill('#profile-name', '新姓名');
    await page.click('#btn-save-profile');

    expect(await getToast(page)).toBe('資料已更新！');
    expect(updateCalled).toBe(true);
  });

  test('[regression] 空白姓名 → toast 提示、不呼叫 API', async ({ page }) => {
    let updateCalled = false;
    await injectSession(page);
    await page.route('**/auth/v1/user', route => {
      if (route.request().method() === 'PUT') { updateCalled = true; }
      route.continue();
    });
    await gotoProfile(page);

    await page.fill('#profile-name', '');
    await page.click('#btn-save-profile');

    expect(await getToast(page)).toBe('請填寫姓名');
    expect(updateCalled).toBe(false);
  });

  test('[edge] 儲存中 → 按鈕 disabled 且文字改為「儲存中…」', async ({ page }) => {
    await injectSession(page);
    await page.route('**/auth/v1/user', async route => {
      if (route.request().method() === 'PUT') {
        await new Promise(r => setTimeout(r, 300));
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_USER) });
      } else { route.continue(); }
    });
    await gotoProfile(page);

    await page.fill('#profile-name', '測試');
    await page.click('#btn-save-profile');

    await expect(page.locator('#btn-save-profile')).toBeDisabled();
    await expect(page.locator('#btn-save-profile')).toHaveText('儲存中…');
    await getToast(page);
    await expect(page.locator('#btn-save-profile')).not.toBeDisabled();
    await expect(page.locator('#btn-save-profile')).toHaveText('儲存資料');
  });

  test('[edge] API 回傳錯誤 → toast 顯示錯誤訊息', async ({ page }) => {
    await injectSession(page);
    await page.route('**/auth/v1/user', route => {
      if (route.request().method() === 'PUT') {
        route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: '更新失敗' }) });
      } else { route.continue(); }
    });
    await gotoProfile(page);

    await page.fill('#profile-name', '測試名稱');
    await page.click('#btn-save-profile');

    const toast = await getToast(page);
    expect(toast).toContain('儲存失敗');
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 3. 登出
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — 登出', () => {

  test('[regression] 點登出 → 導向首頁', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await page.click('button[onclick="logout()"]');
    await expect(page).toHaveURL('/');
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 4. 訂單列表
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — 訂單列表', () => {

  test('[regression] 無訂單 → 顯示空狀態', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await expect(page.locator('.order-empty')).toBeVisible();
    await expect(page.locator('.order-empty p')).toHaveText('尚無訂單記錄');
  });

  test('[regression] 有訂單 → 顯示訂單卡片', async ({ page }) => {
    const order = makeOrder({ id: 'ORD-TEST-001' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await expect(page.locator('.order-item')).toHaveCount(1);
    await expect(page.locator('#orders-wrap')).toContainText('ORD-TEST-001');
  });

  test('[regression] 只顯示自己的訂單（API 已過濾，驗證數量）', async ({ page }) => {
    const myOrders = [makeOrder({ id: 'MY-001' }), makeOrder({ id: 'MY-002' })];
    await injectSession(page);
    await mockOrders(page, myOrders); // API 只回傳自己的訂單
    await gotoProfile(page);

    await expect(page.locator('.order-item')).toHaveCount(2);
    await expect(page.locator('#orders-wrap')).not.toContainText('OTHER');
  });

  test('[regression] 多筆訂單顯示', async ({ page }) => {
    const orders = [makeOrder({ id: 'ORD-A' }), makeOrder({ id: 'ORD-B' })];
    await injectSession(page);
    await mockOrders(page, orders);
    await gotoProfile(page);

    await expect(page.locator('.order-item')).toHaveCount(2);
  });

  test('[regression] 訂單卡片顯示狀態徽章', async ({ page }) => {
    const order = makeOrder({ id: 'ORD-STATUS', status: '待付款' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    const badge = page.locator('.status-badge');
    await expect(badge).toHaveText('待付款');
    await expect(badge).toHaveClass(/status-待付款/);
  });

  test('[regression] 訂單卡片顯示金額', async ({ page }) => {
    const order = makeOrder({ id: 'ORD-AMT', total: 460 });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await expect(page.locator('.order-total-head')).toHaveText('NT$460');
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 5. 訂單篩選
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — 訂單篩選', () => {

  test('[regression] 預設篩選為「全部」（active chip）', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await expect(page.locator('.filter-chip.active')).toHaveText('全部');
  });

  test('[regression] 篩選特定狀態 → 只顯示該狀態的訂單', async ({ page }) => {
    const orders = [
      makeOrder({ id: 'ORD-PAY', status: '待付款' }),
      makeOrder({ id: 'ORD-DONE', status: '已完成' }),
    ];
    await injectSession(page);
    await mockOrders(page, orders);
    await gotoProfile(page);

    await page.click('.filter-chip[data-status="已完成"]');
    await expect(page.locator('#orders-wrap')).toContainText('ORD-DONE');
    await expect(page.locator('#orders-wrap')).not.toContainText('ORD-PAY');
  });

  test('[regression] 切換篩選 → active chip 更新', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);

    await page.click('.filter-chip[data-status="待付款"]');
    await expect(page.locator('.filter-chip[data-status="待付款"]')).toHaveClass(/active/);
    await expect(page.locator('.filter-chip[data-status="全部"]')).not.toHaveClass(/active/);
  });

  test('[regression] 篩選無符合 → 顯示「沒有「X」的訂單」', async ({ page }) => {
    const order = makeOrder({ status: '待付款' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await page.click('.filter-chip[data-status="已完成"]');
    await expect(page.locator('.order-empty p')).toHaveText('沒有「已完成」的訂單');
  });

  test('[regression] 篩選後切回「全部」→ 顯示全部訂單', async ({ page }) => {
    const orders = [
      makeOrder({ id: 'ORD-1', status: '待付款' }),
      makeOrder({ id: 'ORD-2', status: '已完成' }),
    ];
    await injectSession(page);
    await mockOrders(page, orders);
    await gotoProfile(page);

    await page.click('.filter-chip[data-status="已完成"]');
    await expect(page.locator('.order-item')).toHaveCount(1);

    await page.click('.filter-chip[data-status="全部"]');
    await expect(page.locator('.order-item')).toHaveCount(2);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 6. 訂單展開 / 收合
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — 訂單展開收合', () => {

  test('[regression] 點擊訂單標頭 → 展開顯示明細', async ({ page }) => {
    const order = makeOrder({ id: 'ORD-EXPAND' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await expect(page.locator('.order-body')).toBeHidden();
    await page.click('.order-head');
    await expect(page.locator('#order-ORD-EXPAND')).toHaveClass(/open/);
    await expect(page.locator('.order-body')).toBeVisible();
  });

  test('[regression] 展開後再點 → 收合', async ({ page }) => {
    const order = makeOrder({ id: 'ORD-COLLAPSE' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await page.click('.order-head');
    await expect(page.locator('.order-body')).toBeVisible();

    await page.click('.order-head');
    await expect(page.locator('#order-ORD-COLLAPSE')).not.toHaveClass(/open/);
    await expect(page.locator('.order-body')).toBeHidden();
  });

  test('[regression] 展開後顯示商品名稱、配送資訊、金額', async ({ page }) => {
    const order = makeOrder({
      id: 'ORD-DETAIL',
      items: [{ id: 'p1', name: '手工餅乾', price: 200, qty: 3, image: '' }],
      subtotal: 600, total: 660,
    });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await page.click('.order-head');
    const body = page.locator('.order-body');
    await expect(body).toContainText('手工餅乾');
    await expect(body).toContainText('宅配到府');
    await expect(body).toContainText('NT$660');
  });

  test('[edge] 多筆訂單各自獨立展開', async ({ page }) => {
    const orders = [makeOrder({ id: 'ORD-X1' }), makeOrder({ id: 'ORD-X2' })];
    await injectSession(page);
    await mockOrders(page, orders);
    await gotoProfile(page);

    await page.locator('.order-head').first().click();
    await expect(page.locator('#order-ORD-X1')).toHaveClass(/open/);
    await expect(page.locator('#order-ORD-X2')).not.toHaveClass(/open/);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 7. 行動版
// ═════════════════════════════════════════════════════════════════════════════

test.describe('會員中心 — 行動版', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('[mobile] 登入後主內容正常顯示', async ({ page }) => {
    await injectSession(page);
    await gotoProfile(page);
    await expect(page.locator('#main-wrap')).toBeVisible();
  });

  test('[mobile] 儲存資料 → 成功', async ({ page }) => {
    await injectSession(page);
    await page.route('**/auth/v1/user', route => {
      if (route.request().method() === 'PUT') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_USER) });
      } else { route.continue(); }
    });
    await gotoProfile(page);

    await page.fill('#profile-name', '行動會員');
    await page.click('#btn-save-profile');
    expect(await getToast(page)).toBe('資料已更新！');
  });

  test('[mobile] 篩選 chip 正常操作', async ({ page }) => {
    const order = makeOrder({ status: '待付款' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await page.click('.filter-chip[data-status="待付款"]');
    await expect(page.locator('.filter-chip[data-status="待付款"]')).toHaveClass(/active/);
    await expect(page.locator('.order-item')).toHaveCount(1);
  });

  test('[mobile] 訂單展開收合正常', async ({ page }) => {
    const order = makeOrder({ id: 'ORD-M1' });
    await injectSession(page);
    await mockOrders(page, [order]);
    await gotoProfile(page);

    await page.click('.order-head');
    await expect(page.locator('#order-ORD-M1')).toHaveClass(/open/);
  });

});
