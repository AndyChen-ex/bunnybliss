const { test, expect } = require('@playwright/test');

// ── 固定測試帳號 ──────────────────────────────────────────────────────────────
// 在 Supabase 後台用 "Add user > Auto Confirm User" 建立此帳號
const FIXED_USER = {
  email: 'testuser@bunnybliss.com',
  password: 'test123456',
  name: '測試用戶',
};

// ── Mock helpers ──────────────────────────────────────────────────────────────

async function mockLoginApi(page, success = true) {
  await page.route('**/auth/v1/token**', route => {
    if (success) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LWlkIiwiZXhwIjo5OTk5OTk5OTk5fQ.mock',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'mock-refresh-token',
          user: {
            id: 'test-user-id',
            email: FIXED_USER.email,
            user_metadata: { name: FIXED_USER.name },
            email_confirmed_at: new Date().toISOString(),
          },
        }),
      });
    } else {
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'invalid_credentials', message: 'Invalid login credentials' }),
      });
    }
  });
}

// NOTE: 無法在自動化測試中驗證實際 email 寄送；
// emailConfirmRequired=true 模擬「Supabase 回傳 session=null 需驗證」的情境
async function mockSignupApi(page, emailConfirmRequired = true) {
  await page.route('**/auth/v1/signup**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'new-user-id',
          email: 'new@test.com',
          email_confirmed_at: emailConfirmRequired ? null : new Date().toISOString(),
        },
        session: emailConfirmRequired ? null : {
          access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJuZXctaWQiLCJleHAiOjk5OTk5OTk5OTl9.mock',
          user: { id: 'new-user-id', email: 'new@test.com', user_metadata: { name: '新用戶' } },
        },
      }),
    });
  });
}

async function mockCheckEmail(page, exists = false) {
  await page.route('**/api/check-email', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ exists }),
    });
  });
}

// 等 auth.js 初始化完成（_bbUser 從 undefined 變成 null 或 user）
async function waitForAuth(page) {
  await page.waitForFunction(() => window._bbUser !== undefined, { timeout: 8000 });
}

// 開啟 Modal — 用 evaluate 直接呼叫 openAuth()，桌機/手機皆可用
async function openAuthModal(page, tab = 'login') {
  await page.goto('/');
  await waitForAuth(page);
  await page.evaluate((t) => openAuth(t), tab);
  await page.waitForSelector('#auth-overlay.active');
}

async function getToast(page) {
  await page.waitForSelector('#toast.show', { timeout: 6000 });
  return page.locator('#toast').innerText();
}

// ═════════════════════════════════════════════════════════════════════════════
// 登入測試
// ═════════════════════════════════════════════════════════════════════════════

test.describe('登入', () => {

  test('[regression] 正確帳密 → toast 成功、Modal 關閉', async ({ page }) => {
    await mockLoginApi(page, true);
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', FIXED_USER.password);
    await page.click('button[onclick="doLogin()"]');

    expect(await getToast(page)).toBe('登入成功！歡迎回來');
    await expect(page.locator('#auth-overlay')).not.toHaveClass(/active/);
  });

  test('[regression] 登入後 auth state 更新為已登入', async ({ page }) => {
    await mockLoginApi(page, true);
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', FIXED_USER.password);
    await page.click('button[onclick="doLogin()"]');

    // 等 _bbUser 更新（viewport 無關，桌機手機皆可用）
    await page.waitForFunction(() => !!window._bbUser, { timeout: 5000 });
    const email = await page.evaluate(() => window._bbUser?.email);
    expect(email).toBe(FIXED_USER.email);
  });

  test('[regression] 錯誤密碼 → toast 錯誤訊息、Modal 保持開啟', async ({ page }) => {
    await mockLoginApi(page, false);
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', 'wrongpassword');
    await page.click('button[onclick="doLogin()"]');

    expect(await getToast(page)).toContain('電子信箱或密碼錯誤');
    await expect(page.locator('#auth-overlay')).toHaveClass(/active/);
  });

  test('[edge] email 欄位空白 → toast 提示、不送出 API', async ({ page }) => {
    let apiCalled = false;
    await page.route('**/auth/v1/token**', () => { apiCalled = true; });
    await openAuthModal(page, 'login');

    await page.fill('#login-pass', FIXED_USER.password);
    await page.click('button[onclick="doLogin()"]');

    expect(await getToast(page)).toBe('請填寫電子信箱與密碼');
    expect(apiCalled).toBe(false);
  });

  test('[edge] 密碼欄位空白 → toast 提示、不送出 API', async ({ page }) => {
    let apiCalled = false;
    await page.route('**/auth/v1/token**', () => { apiCalled = true; });
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.click('button[onclick="doLogin()"]');

    expect(await getToast(page)).toBe('請填寫電子信箱與密碼');
    expect(apiCalled).toBe(false);
  });

  test('[edge] 連按多次登入鈕 → 只送出一次 API（防重複）', async ({ page }) => {
    let callCount = 0;
    await page.route('**/auth/v1/token**', route => {
      callCount++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LWlkIiwiZXhwIjo5OTk5OTk5OTk5fQ.mock',
          token_type: 'bearer',
          user: { id: 'test-user-id', email: FIXED_USER.email, user_metadata: { name: FIXED_USER.name } },
        }),
      });
    });
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', FIXED_USER.password);

    // 在瀏覽器內同步觸發三次，確保 _authLoading guard 在 await 前已生效
    await page.evaluate(() => {
      const btn = document.querySelector('button[onclick="doLogin()"]');
      btn.click(); btn.click(); btn.click();
    });

    await getToast(page);
    expect(callCount).toBe(1);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 行動版登入測試
// ═════════════════════════════════════════════════════════════════════════════

test.describe('行動版登入', () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14

  test('[mobile] 開啟 modal → modal 顯示', async ({ page }) => {
    await page.goto('/');
    await waitForAuth(page);
    await page.evaluate(() => openAuth('login'));
    await expect(page.locator('#auth-overlay')).toHaveClass(/active/);
    await expect(page.locator('#panel-login')).toHaveClass(/active/);
  });

  test('[mobile] 切換到註冊頁籤', async ({ page }) => {
    await openAuthModal(page, 'login');
    await page.click('#tab-register');
    await expect(page.locator('#panel-register')).toHaveClass(/active/);
    await expect(page.locator('#panel-login')).not.toHaveClass(/active/);
  });

  test('[mobile] 正確帳密登入 → toast + modal 關閉', async ({ page }) => {
    await mockLoginApi(page, true);
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', FIXED_USER.password);
    await page.click('button[onclick="doLogin()"]');

    expect(await getToast(page)).toBe('登入成功！歡迎回來');
    await expect(page.locator('#auth-overlay')).not.toHaveClass(/active/);
  });

  test('[mobile] 登入成功 → 行動版導覽顯示已登入', async ({ page }) => {
    await mockLoginApi(page, true);
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', FIXED_USER.password);
    await page.click('button[onclick="doLogin()"]');

    await page.waitForSelector('#mob-auth-user', { state: 'visible' });
    await expect(page.locator('#mob-auth-guest')).toBeHidden();
  });

  test('[mobile] 錯誤密碼 → toast 錯誤', async ({ page }) => {
    await mockLoginApi(page, false);
    await openAuthModal(page, 'login');

    await page.fill('#login-email', FIXED_USER.email);
    await page.fill('#login-pass', 'badpass');
    await page.click('button[onclick="doLogin()"]');

    expect(await getToast(page)).toContain('電子信箱或密碼錯誤');
  });

  test('[mobile] 漢堡選單開關正常', async ({ page }) => {
    await page.goto('/');
    await waitForAuth(page);

    await page.click('#hamburger');
    await expect(page.locator('#mob-drawer')).toHaveClass(/open/);

    await page.click('.mobile-nav-close');
    await expect(page.locator('#mob-drawer')).not.toHaveClass(/open/);
  });

  test('[mobile] 購物車按鈕開啟抽屜', async ({ page }) => {
    await page.goto('/');
    await waitForAuth(page);

    await page.click('.btn-cart');
    await expect(page.locator('#cart-drawer')).toHaveClass(/open/);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 註冊測試
// ═════════════════════════════════════════════════════════════════════════════

test.describe('註冊', () => {

  test('[regression] 新 email + 合法密碼 → 顯示「驗證信已送出」', async ({ page }) => {
    await mockCheckEmail(page, false);
    await mockSignupApi(page, true);
    await openAuthModal(page, 'register');

    await page.fill('#reg-name', '新用戶');
    await page.fill('#reg-phone', '0912345678');
    await page.fill('#reg-email', 'newuser@test.com');
    await page.fill('#reg-pass', 'password123');
    const pass2 = page.locator('#reg-pass2');
    if (await pass2.count()) await pass2.fill('password123');

    await page.click('button[onclick="doRegister()"]');
    expect(await getToast(page)).toBe('驗證信已送出，請查收 Email 完成驗證！');
  });

  test('[regression] 已存在 email → 提示已註冊、不送出 signup API', async ({ page }) => {
    await mockCheckEmail(page, true);
    let signupCalled = false;
    await page.route('**/auth/v1/signup**', () => { signupCalled = true; });
    await openAuthModal(page, 'register');

    await page.fill('#reg-name', FIXED_USER.name);
    await page.fill('#reg-phone', '0912345678');
    await page.fill('#reg-email', FIXED_USER.email);
    await page.fill('#reg-pass', 'anypassword');
    const pass2 = page.locator('#reg-pass2');
    if (await pass2.count()) await pass2.fill('anypassword');

    await page.click('button[onclick="doRegister()"]');
    expect(await getToast(page)).toBe('此 Email 已註冊，請直接登入');
    expect(signupCalled).toBe(false);
  });

  test('[edge] 未填姓名 → toast 提示、不送 check-email', async ({ page }) => {
    let checkCalled = false;
    await page.route('**/api/check-email', () => { checkCalled = true; });
    await openAuthModal(page, 'register');

    await page.fill('#reg-email', 'test@test.com');
    await page.fill('#reg-pass', 'password123');
    await page.click('button[onclick="doRegister()"]');

    expect(await getToast(page)).toBe('請填寫所有欄位');
    expect(checkCalled).toBe(false);
  });

  test('[edge] 密碼少於 6 字元 → toast 提示', async ({ page }) => {
    await openAuthModal(page, 'register');

    await page.fill('#reg-name', '測試');
    await page.fill('#reg-phone', '0912345678');
    await page.fill('#reg-email', 'test@test.com');
    await page.fill('#reg-pass', '123');
    const pass2 = page.locator('#reg-pass2');
    if (await pass2.count()) await pass2.fill('123');

    await page.click('button[onclick="doRegister()"]');
    expect(await getToast(page)).toBe('密碼至少需要 6 個字元');
  });

  test('[edge] 兩次密碼不一致 → toast 提示', async ({ page }) => {
    await openAuthModal(page, 'register');
    const pass2 = page.locator('#reg-pass2');
    if (await pass2.count() === 0) { test.skip(); return; }

    await page.fill('#reg-name', '測試');
    await page.fill('#reg-phone', '0912345678');
    await page.fill('#reg-email', 'test@test.com');
    await page.fill('#reg-pass', 'password123');
    await pass2.fill('different999');

    await page.click('button[onclick="doRegister()"]');
    expect(await getToast(page)).toBe('兩次密碼不一致');
  });

  test('[edge] email 格式不合法 → 瀏覽器原生驗證阻擋、不送 check-email', async ({ page }) => {
    let checkCalled = false;
    await page.route('**/api/check-email', () => { checkCalled = true; });
    await openAuthModal(page, 'register');

    await page.fill('#reg-name', '測試');
    await page.locator('#reg-email').fill('not-an-email');
    await page.fill('#reg-pass', 'password123');
    await page.click('button[onclick="doRegister()"]');

    await page.waitForTimeout(500);
    expect(checkCalled).toBe(false);
  });

});
