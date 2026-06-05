/**
 * 商品 CRUD 測試 — 後台操作 → API → 前台顯示
 *
 * 覆蓋：新增 / 修改 / 刪除 / 上架下架，
 * 以及每個操作在前台 products.html 的顯示驗證。
 */

const { test, expect } = require('@playwright/test');

const ADMIN_PWD = 'bunnybliss';

// ── 共用假商品工廠 ─────────────────────────────────────────────────────────────
function makeProduct(overrides = {}) {
  return {
    id: 1, name: '測試捲捲棒', price: 300, active: true,
    images: [], image: '', desc: '測試描述', badge: '', badgeColor: '',
    priceTiers: [], order: 0, categoryId: null,
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 清空後台 localStorage，避免 DEFAULT_PRODUCTS 干擾。
 * 手動登入後 initFromServer 不執行，必須靠 addInitScript 設初始狀態。
 */
async function resetAdminStorage(page, initialProducts = []) {
  await page.addInitScript((products) => {
    localStorage.setItem('bb_products',   JSON.stringify(products));
    localStorage.setItem('bb_categories', JSON.stringify([]));
    localStorage.setItem('bb_banners',    JSON.stringify([]));
    localStorage.setItem('bb_addons',     JSON.stringify([]));
    localStorage.setItem('bb_settings',   JSON.stringify({}));
  }, initialProducts);
}

/**
 * 模擬 /api/store/products GET / POST
 * 回傳 API 狀態 getter，讓測試可以驗證 POST payload
 */
async function mockProductsApi(page, initialProducts = []) {
  let _products = [...initialProducts];
  let _savedPayload = null;

  // Wildcard 先加（低優先）
  await page.route('**/api/store/**', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });

  // Products 後加（高優先）
  await page.route('**/api/store/products', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(_products) });
    } else if (route.request().method() === 'POST') {
      _savedPayload = route.request().postDataJSON();
      _products = _savedPayload;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    } else { route.continue(); }
  });

  return {
    getProducts: () => _products,
    getSavedPayload: () => _savedPayload,
  };
}

/** 前往後台並切換到商品管理 */
async function gotoAdminProducts(page) {
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await page.fill('#login-pwd', ADMIN_PWD);
  await page.click('button[onclick="doLogin()"]');
  await page.waitForSelector('#app.visible', { timeout: 10000 });
  await page.evaluate(() => switchPanel('products'));
  await page.waitForSelector('#panel-products', { state: 'visible' });
}

/** 等 toast 出現並回傳文字 */
async function getToast(page) {
  await page.waitForSelector('#toast.show', { timeout: 6000 });
  return page.locator('#toast').innerText();
}

/** 填寫商品表單（對 number input 使用 evaluate 確保值正確） */
async function fillProductForm(page, { name, price }) {
  if (name !== undefined) await page.fill('#p-name', name);
  if (price !== undefined) {
    // 數字 input 用 evaluate 確保不被預設值干擾
    await page.evaluate((v) => {
      const el = document.getElementById('p-price');
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(price));
  }
}

/** 前往前台商品頁並等待渲染 */
async function gotoProducts(page) {
  await page.goto('/products', { waitUntil: 'domcontentloaded' });
  // 等 loadStoreData 完成、renderProducts 執行
  await page.waitForFunction(
    () => typeof renderProducts !== 'undefined' &&
          document.querySelector('.shop-main') !== null,
    { timeout: 8000 }
  );
  await page.waitForTimeout(300);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. 後台商品管理基本功能
// ═════════════════════════════════════════════════════════════════════════════

test.describe('後台商品管理', () => {

  test('[regression] 新增商品 → 後台列表顯示、API 被呼叫', async ({ page }) => {
    await resetAdminStorage(page, []);
    const { getSavedPayload } = await mockProductsApi(page, []);
    await gotoAdminProducts(page);

    // 點「+ 新增商品」
    await page.click('#topbar-add-btn');
    await page.waitForSelector('#product-modal-overlay.active');
    expect(await page.locator('#product-modal-title').innerText()).toBe('新增商品');

    await fillProductForm(page, { name: '巧克力捲捲棒', price: 350 });
    await page.click('button[onclick="saveProduct()"]');

    expect(await getToast(page)).toContain('新增');
    await expect(page.locator('#product-modal-overlay')).not.toHaveClass(/active/);
    await expect(page.locator('#products-tbody')).toContainText('巧克力捲捲棒');

    await page.waitForTimeout(300);
    const payload = getSavedPayload();
    expect(payload).not.toBeNull();
    const saved = payload?.find(p => p.name === '巧克力捲捲棒');
    expect(saved).toBeDefined();
    expect(saved.price).toBe(350);
    expect(saved.active).toBe(true);
  });

  test('[regression] 修改商品名稱 → 後台列表更新', async ({ page }) => {
    const product = makeProduct({ id: 1, name: '原始名稱', price: 200 });
    await resetAdminStorage(page, [product]);
    const { getSavedPayload } = await mockProductsApi(page, [product]);
    await gotoAdminProducts(page);

    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('原始名稱'));

    await page.locator('#products-tbody .btn-edit').click();
    await page.waitForSelector('#product-modal-overlay.active');
    expect(await page.locator('#product-modal-title').innerText()).toBe('編輯商品');

    await fillProductForm(page, { name: '修改後名稱' });
    await page.click('button[onclick="saveProduct()"]');

    expect(await getToast(page)).toContain('更新');
    await expect(page.locator('#products-tbody')).toContainText('修改後名稱');
    await expect(page.locator('#products-tbody')).not.toContainText('原始名稱');

    await page.waitForTimeout(300);
    const saved = getSavedPayload()?.find(p => p.id === 1);
    expect(saved?.name).toBe('修改後名稱');
  });

  test('[regression] 修改商品價格', async ({ page }) => {
    const product = makeProduct({ id: 1, name: '價格測試商品', price: 100 });
    await resetAdminStorage(page, [product]);
    const { getSavedPayload } = await mockProductsApi(page, [product]);
    await gotoAdminProducts(page);

    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('價格測試商品'));
    await page.locator('#products-tbody .btn-edit').click();
    await page.waitForSelector('#product-modal-overlay.active');

    await fillProductForm(page, { price: 500 });
    await page.click('button[onclick="saveProduct()"]');

    await page.waitForTimeout(300);
    const saved = getSavedPayload()?.find(p => p.id === 1);
    expect(saved?.price).toBe(500);
  });

  test('[regression] 刪除商品 → 後台列表移除、API 被呼叫', async ({ page }) => {
    const products = [
      makeProduct({ id: 1, name: '要刪除的商品', order: 0 }),
      makeProduct({ id: 2, name: '保留的商品', order: 1 }),
    ];
    await resetAdminStorage(page, products);
    const { getSavedPayload } = await mockProductsApi(page, products);
    await gotoAdminProducts(page);

    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('要刪除的商品'));

    await page.locator('#products-tbody .btn-delete').first().click();
    await page.waitForSelector('#confirm-overlay.active');

    await page.click('#confirm-ok');
    expect(await getToast(page)).toBe('已刪除');

    await expect(page.locator('#products-tbody')).not.toContainText('要刪除的商品');
    await expect(page.locator('#products-tbody')).toContainText('保留的商品');

    await page.waitForTimeout(300);
    const payload = getSavedPayload();
    expect(payload?.length).toBe(1);
    expect(payload?.[0].name).toBe('保留的商品');
  });

  test('[regression] 下架商品 → active 改為 false', async ({ page }) => {
    const product = makeProduct({ id: 1, name: '上架中商品', active: true });
    await resetAdminStorage(page, [product]);
    const { getSavedPayload } = await mockProductsApi(page, [product]);
    await gotoAdminProducts(page);

    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('上架中商品'));

    // 按鈕文字「下架」（active=true 時顯示「下架」按鈕）
    await page.locator('#products-tbody .btn-toggle').first().click();
    await page.waitForTimeout(300);

    const saved = getSavedPayload()?.find(p => p.id === 1);
    expect(saved?.active).toBe(false);
    await expect(page.locator('#products-tbody .btn-toggle').first()).toContainText('上架');
  });

  test('[regression] 再次上架 → active 回到 true', async ({ page }) => {
    const product = makeProduct({ id: 1, name: '已下架商品', active: false });
    await resetAdminStorage(page, [product]);
    const { getSavedPayload } = await mockProductsApi(page, [product]);
    await gotoAdminProducts(page);

    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('已下架商品'));

    await page.locator('#products-tbody .btn-toggle').first().click();
    await page.waitForTimeout(300);

    const saved = getSavedPayload()?.find(p => p.id === 1);
    expect(saved?.active).toBe(true);
  });

  test('[edge] 新增商品名稱空白 → toast 提示、不送 API', async ({ page }) => {
    let apiCalled = false;
    await resetAdminStorage(page, []);
    await page.route('**/api/store/products', route => {
      if (route.request().method() === 'POST') apiCalled = true;
      route.fulfill({ status: 200, body: '[]' });
    });
    await gotoAdminProducts(page);

    await page.click('#topbar-add-btn');
    await page.waitForSelector('#product-modal-overlay.active');
    await fillProductForm(page, { price: 100 });
    await page.click('button[onclick="saveProduct()"]');

    expect(await getToast(page)).toContain('商品名稱');
    expect(apiCalled).toBe(false);
    await expect(page.locator('#product-modal-overlay')).toHaveClass(/active/);
  });

  test('[edge] 新增商品價格為 0 → toast 提示、不送 API', async ({ page }) => {
    let apiCalled = false;
    await resetAdminStorage(page, []);
    await page.route('**/api/store/products', route => {
      if (route.request().method() === 'POST') apiCalled = true;
      route.fulfill({ status: 200, body: '[]' });
    });
    await gotoAdminProducts(page);

    await page.click('#topbar-add-btn');
    await page.waitForSelector('#product-modal-overlay.active');
    await fillProductForm(page, { name: '有名稱無價格' });
    // 不設定 price（保持 0）
    await page.click('button[onclick="saveProduct()"]');

    expect(await getToast(page)).toContain('售價');
    expect(apiCalled).toBe(false);
  });

  test('[regression] 取消新增 → 商品未新增', async ({ page }) => {
    await resetAdminStorage(page, []);
    const { getSavedPayload } = await mockProductsApi(page, []);
    await gotoAdminProducts(page);

    await page.click('#topbar-add-btn');
    await page.waitForSelector('#product-modal-overlay.active');
    await fillProductForm(page, { name: '取消用商品', price: 100 });

    await page.locator('#product-modal-overlay button.btn-cancel').click();
    await expect(page.locator('#product-modal-overlay')).not.toHaveClass(/active/);

    expect(getSavedPayload()).toBeNull();
    await expect(page.locator('#products-tbody')).not.toContainText('取消用商品');
  });

  test('[regression] 刪除確認對話框可取消', async ({ page }) => {
    const product = makeProduct({ id: 1, name: '不要刪我', order: 0 });
    await resetAdminStorage(page, [product]);
    const { getSavedPayload } = await mockProductsApi(page, [product]);
    await gotoAdminProducts(page);

    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('不要刪我'));
    await page.locator('#products-tbody .btn-delete').first().click();
    await page.waitForSelector('#confirm-overlay.active');

    await page.locator('#confirm-overlay .btn-cancel').click();
    await expect(page.locator('#confirm-overlay')).not.toHaveClass(/active/);

    await expect(page.locator('#products-tbody')).toContainText('不要刪我');
    expect(getSavedPayload()).toBeNull();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// 2. 後台改動 → 前台顯示
// ═════════════════════════════════════════════════════════════════════════════

test.describe('後台改動 → 前台顯示', () => {

  /** 在同一頁面完成後台操作再前往前台，共用 mock 狀態。
   *  注意：Playwright route 是 LIFO（後加優先），wildcard 先加 = 低優先 */
  async function setupSharedMock(page, initialProducts = []) {
    let _products = [...initialProducts];

    // 1. 先加 wildcard（低優先）：catch 其他 store api，返回 null
    await page.route('**/api/store/**', route => {
      route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    });

    // 2. 後加 products（高優先）：精確攔截 GET/POST
    await page.route('**/api/store/products', route => {
      if (route.request().method() === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(_products) });
      } else if (route.request().method() === 'POST') {
        _products = route.request().postDataJSON();
        route.fulfill({ status: 200, body: '{"ok":true}' });
      } else { route.continue(); }
    });

    return () => _products;
  }

  test('[integration] 後台新增商品 → 前台商品列表出現', async ({ page }) => {
    await resetAdminStorage(page, []);
    const getState = await setupSharedMock(page, []);

    await gotoAdminProducts(page);
    await page.click('#topbar-add-btn');
    await page.waitForSelector('#product-modal-overlay.active');
    await fillProductForm(page, { name: '全新上市餅乾', price: 280 });
    await page.click('button[onclick="saveProduct()"]');
    await getToast(page);
    await page.waitForTimeout(300);

    await gotoProducts(page);
    await expect(page.locator('.product-card')).toContainText('全新上市餅乾');
  });

  test('[integration] 後台修改商品名稱 → 前台更新', async ({ page }) => {
    const initialProducts = [makeProduct({ id: 1, name: '舊商品名稱', price: 200 })];
    await resetAdminStorage(page, initialProducts);
    await setupSharedMock(page, initialProducts);

    await gotoAdminProducts(page);
    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('舊商品名稱'));
    await page.locator('#products-tbody .btn-edit').click();
    await page.waitForSelector('#product-modal-overlay.active');
    await fillProductForm(page, { name: '改過的商品名稱' });
    await page.click('button[onclick="saveProduct()"]');
    await getToast(page);
    await page.waitForTimeout(300);

    await gotoProducts(page);
    await expect(page.locator('.product-card')).toContainText('改過的商品名稱');
    await expect(page.locator('.shop-main')).not.toContainText('舊商品名稱');
  });

  test('[integration] 後台刪除商品 → 前台不再顯示', async ({ page }) => {
    const initialProducts = [
      makeProduct({ id: 1, name: '被刪除的商品', order: 0 }),
      makeProduct({ id: 2, name: '留下來的商品', order: 1 }),
    ];
    await resetAdminStorage(page, initialProducts);
    await setupSharedMock(page, initialProducts);

    await gotoAdminProducts(page);
    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('被刪除的商品'));
    await page.locator('#products-tbody .btn-delete').first().click();
    await page.waitForSelector('#confirm-overlay.active');
    await page.click('#confirm-ok');
    await getToast(page);
    await page.waitForTimeout(300);

    await gotoProducts(page);
    await expect(page.locator('.shop-main')).not.toContainText('被刪除的商品');
    await expect(page.locator('.product-card')).toContainText('留下來的商品');
  });

  test('[integration] 後台下架商品 → 前台不顯示', async ({ page }) => {
    const initialProducts = [makeProduct({ id: 1, name: '即將下架商品', active: true })];
    await resetAdminStorage(page, initialProducts);
    await setupSharedMock(page, initialProducts);

    await gotoAdminProducts(page);
    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('即將下架商品'));
    await page.locator('#products-tbody .btn-toggle').first().click();
    await page.waitForTimeout(300);

    await gotoProducts(page);
    await expect(page.locator('.shop-main')).not.toContainText('即將下架商品');
  });

  test('[integration] 後台上架商品 → 前台顯示', async ({ page }) => {
    const initialProducts = [makeProduct({ id: 1, name: '等待上架商品', active: false })];
    await resetAdminStorage(page, initialProducts);
    await setupSharedMock(page, initialProducts);

    await gotoAdminProducts(page);
    await page.waitForFunction(() => document.getElementById('products-tbody')?.textContent?.includes('等待上架商品'));
    // active=false 時按鈕顯示「上架」，點它讓 active=true
    await page.locator('#products-tbody .btn-toggle').first().click();
    await page.waitForTimeout(300);

    await gotoProducts(page);
    await expect(page.locator('.product-card')).toContainText('等待上架商品');
  });

  test('[integration] 後台新增多商品 → 前台全部顯示', async ({ page }) => {
    await resetAdminStorage(page, []);
    await setupSharedMock(page, []);

    await gotoAdminProducts(page);

    for (const { name, price } of [{ name: '商品甲', price: 100 }, { name: '商品乙', price: 200 }]) {
      await page.click('#topbar-add-btn');
      await page.waitForSelector('#product-modal-overlay.active');
      await fillProductForm(page, { name, price });
      await page.click('button[onclick="saveProduct()"]');
      await getToast(page);
      await page.waitForTimeout(200);
    }

    await gotoProducts(page);
    await expect(page.locator('.products-grid')).toContainText('商品甲');
    await expect(page.locator('.products-grid')).toContainText('商品乙');
    await expect(page.locator('.product-card')).toHaveCount(2);
  });

});
