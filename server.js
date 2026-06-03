require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
console.log('[Cloudinary] config loaded:', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  has_key: !!process.env.CLOUDINARY_API_KEY,
  has_secret: !!process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.', { extensions: ['html'] }));

// 國內物流使用 CheckMacValue MD5（不是 SHA256），Node.js 版本精確翻譯自 PHP SDK
// 參考：ECPay-API-Skill/guides/13-checkmacvalue.md §Node.js
function ecpayUrlEncode(source) {
  // encodeURIComponent 空格→%20，需替換為 +；並補上 PHP urlencode 會編碼但 encodeURIComponent 不編碼的字元
  let encoded = encodeURIComponent(source)
    .replace(/%20/g, '+')
    .replace(/~/g, '%7e')
    .replace(/'/g, '%27');
  encoded = encoded.toLowerCase();
  const replacements = { '%2d': '-', '%5f': '_', '%2e': '.', '%21': '!', '%2a': '*', '%28': '(', '%29': ')' };
  for (const [old, char] of Object.entries(replacements)) {
    encoded = encoded.split(old).join(char);
  }
  return encoded;
}

function generateCheckMacValue(params, method = 'md5') {
  const hashKey = process.env.ECPAY_HASH_KEY;
  const hashIV = process.env.ECPAY_HASH_IV;

  const filtered = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'CheckMacValue'));
  const sorted = Object.keys(filtered).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const paramStr = sorted.map(k => `${k}=${filtered[k]}`).join('&');
  const raw = `HashKey=${hashKey}&${paramStr}&HashIV=${hashIV}`;

  return crypto.createHash(method).update(ecpayUrlEncode(raw), 'utf8').digest('hex').toUpperCase();
}

// 快取：key = CvsType，value = { storeInfo: [...], fetchedAt: timestamp }
const cache = {};
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小時（綠界每日 20:00 更新）

async function fetchFromEcpay(cvsType) {
  const params = { MerchantID: process.env.ECPAY_MERCHANT_ID, CvsType: cvsType };
  if (process.env.ECPAY_PLATFORM_ID) params.PlatformID = process.env.ECPAY_PLATFORM_ID;
  params.CheckMacValue = generateCheckMacValue(params);

  const body = new URLSearchParams(params).toString();
  console.log('[ECPay] POST →', process.env.ECPAY_LOGISTICS_URL);
  console.log('[ECPay] Body  :', body);

  const { data } = await axios.post(process.env.ECPAY_LOGISTICS_URL, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    timeout: 15000,
  });
  console.log('[ECPay] Response:', JSON.stringify(data).slice(0, 300));
  return data;
}

// 從 Authorization header 驗證 JWT 並回傳 user
async function verifyUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return error ? null : user;
}

// ── ECPay AIO 金流（信用卡）────────────────────────────────────────────────

// MerchantTradeDate 必須是台灣時間 yyyy/MM/dd HH:mm:ss
function getMerchantTradeDate() {
  return new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(/-/g, '/');
}

// CheckMacValue SHA256（AIO 金流專用，與物流 MD5 分開）
function generatePaymentCMV(params) {
  const hashKey = process.env.ECPAY_PAYMENT_HASH_KEY;
  const hashIV = process.env.ECPAY_PAYMENT_HASH_IV;
  const filtered = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'CheckMacValue'));
  const sorted = Object.keys(filtered).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const raw = `HashKey=${hashKey}&${sorted.map(k => `${k}=${filtered[k]}`).join('&')}&HashIV=${hashIV}`;
  return crypto.createHash('sha256').update(ecpayUrlEncode(raw), 'utf8').digest('hex').toUpperCase();
}

// timing-safe CheckMacValue 驗證（SKILL.md AI 注意事項：禁止用 ==）
function verifyPaymentCMV(params) {
  const received = (params.CheckMacValue || '').toUpperCase();
  const { CheckMacValue: _, ...rest } = params;
  const expected = generatePaymentCMV(rest);
  const bufA = Buffer.from(expected);
  const bufB = Buffer.from(received);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// POST /api/ecpay/credit — 產生 AIO 自動提交表單，導向綠界信用卡付款頁
app.post('/api/ecpay/credit', async (req, res) => {
  try {
    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ error: '未授權' });

    const { orderId, totalAmount, itemName } = req.body;
    if (!orderId || !totalAmount || !itemName) return res.status(400).json({ error: '缺少必要參數' });

    // 環境變數檢查
    const mid  = process.env.ECPAY_PAYMENT_MERCHANT_ID;
    const hkey = process.env.ECPAY_PAYMENT_HASH_KEY;
    const hiv  = process.env.ECPAY_PAYMENT_HASH_IV;
    if (!mid || !hkey || !hiv) {
      console.error('[ECPay credit] 缺少環境變數:', { mid: !!mid, hkey: !!hkey, hiv: !!hiv });
      return res.status(500).json({ error: 'ECPay 環境變數未設定，請在 Render 加入 ECPAY_PAYMENT_MERCHANT_ID / ECPAY_PAYMENT_HASH_KEY / ECPAY_PAYMENT_HASH_IV' });
    }

    // MerchantTradeNo：最長 20 字元，僅英數字，永久唯一
    const tradeNo = `BB${Math.floor(Date.now() / 1000)}${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`.slice(0, 20);

    const siteUrl = process.env.SITE_URL || 'https://bunnybliss.onrender.com';

    // ItemName：過濾特殊字元，限 200 字
    const safeItemName = String(itemName).replace(/[<>&"']/g, '').trim().slice(0, 200) || '甜點商品';

    const params = {
      MerchantID:        mid,
      MerchantTradeNo:   tradeNo,
      MerchantTradeDate: getMerchantTradeDate(),
      PaymentType:       'aio',
      TotalAmount:       Number(totalAmount),
      TradeDesc:         'Bliss',
      ItemName:          safeItemName,
      ReturnURL:         `${siteUrl}/api/ecpay/notify`,
      ChoosePayment:     'Credit',
      EncryptType:       1,
      ClientBackURL:     `${siteUrl}/`,
      CustomField1:      String(orderId).slice(0, 50),
    };

    console.log('[ECPay credit] 建立訂單:', tradeNo, 'orderId:', orderId, 'amount:', totalAmount);
    params.CheckMacValue = generatePaymentCMV(params);

    // 記錄 ECPay 交易編號（非關鍵，失敗不中斷）
    supabase.from('orders')
      .update({ payment: { method: 'credit', ecpay_trade_no: tradeNo } })
      .eq('id', orderId)
      .then(() => {})
      .catch(e => console.warn('[ECPay credit] 記錄 tradeNo 失敗:', e.message));

    const actionUrl = process.env.ECPAY_PAYMENT_URL || 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5';
    const inputs = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`)
      .join('\n');

    // 回傳自動提交表單（瀏覽器 document.write 後即跳轉）
    res.send(`<!DOCTYPE html><html><body>
<form id="f" action="${actionUrl}" method="POST">${inputs}</form>
<script>document.getElementById('f').submit();</script>
</body></html>`);

  } catch (err) {
    console.error('[ECPay credit] 例外錯誤:', err.message, err.stack);
    res.status(500).json({ error: '建立付款表單失敗：' + err.message });
  }
});

// POST /api/ecpay/notify — ReturnURL，接收綠界付款結果通知（Server-to-Server）
// ⚠️ 必須在 10 秒內回應純文字 1|OK；僅支援 port 80/443
app.post('/api/ecpay/notify', express.urlencoded({ extended: false }), async (req, res) => {
  // AIO Callback 是 Form POST，RtnCode 為字串
  if (!verifyPaymentCMV(req.body)) {
    console.error('[ECPay notify] CheckMacValue 驗證失敗', req.body.MerchantTradeNo);
    return res.status(200).type('text/plain').send('1|OK'); // 仍須回 1|OK 避免重試
  }

  const { RtnCode, SimulatePaid, CustomField1: orderId, TradeAmt } = req.body;

  if (String(RtnCode) === '1' && String(SimulatePaid) !== '1' && orderId) {
    // 驗證金額一致性，防止竄改
    const { data: order } = await supabase.from('orders').select('total').eq('id', orderId).single();
    if (order && parseInt(TradeAmt) !== order.total) {
      console.error(`[ECPay notify] 金額不符！ECPay=${TradeAmt} DB=${order.total} 訂單=${orderId}`);
      return res.status(200).type('text/plain').send('1|OK'); // 仍須回 1|OK，但不更新狀態
    }
    // 金額一致，更新訂單狀態
    await supabase.from('orders').update({ status: '已付款' }).eq('id', orderId)
      .then(({ error }) => { if (error) console.error('[ECPay notify] 更新訂單失敗', error.message); });
  }

  // ⚠️ 必須回純文字 1|OK，HTTP 200
  res.status(200).type('text/plain').send('1|OK');
});

// GET /api/config — 回傳前端需要的公開設定
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// POST /api/check-email — 檢查 email 是否已被註冊
// 用 GoTrue REST API 直接以 email 查詢單筆，不拉全部用戶清單
app.post('/api/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const { data } = await axios.get(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users`,
      {
        params: { email, page: 1, per_page: 1 },
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    res.json({ exists: (data?.users?.length || 0) > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Profile API ──────────────────────────────────────────────────────────────

// GET /api/profile
app.get('/api/profile', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '未授權' });
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error && error.code === 'PGRST116') return res.json(null);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/profile — 建立或更新會員資料
app.post('/api/profile', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '未授權' });
  const { name, phone } = req.body;
  const { error } = await supabase.from('profiles').upsert({
    id: user.id,
    email: user.email,
    name: name ?? user.user_metadata?.name ?? '',
    phone: phone ?? '',
    updated_at: new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// PATCH /api/profile
app.patch('/api/profile', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '未授權' });
  const updates = { updated_at: new Date().toISOString() };
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.phone !== undefined) updates.phone = req.body.phone;
  const { error } = await supabase.from('profiles').update(updates).eq('id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Orders API ────────────────────────────────────────────────────────────────

// POST /api/orders — 會員建立訂單
app.post('/api/orders', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '未授權' });
  const o = req.body;
  const { error } = await supabase.from('orders').insert({
    id: o.id,
    user_id: user.id,
    user_email: user.email,
    status: o.status || '待付款',
    customer: o.customer,
    shipping: o.shipping,
    payment: o.payment,
    items: o.items,
    subtotal: o.subtotal,
    total: o.total,
    created_at: o.createdAt || new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/orders — 取得會員自己的訂單（分頁，每頁 20 筆）
// ?page=1&status=待付款
app.get('/api/orders', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '未授權' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const from = (page - 1) * limit;

  let q = supabase.from('orders').select('*', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(from, from + limit - 1);

  if (req.query.status) q = q.eq('status', req.query.status);

  const { data, count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data, total: count, page, limit });
});

// GET /api/admin/orders — 後台取得最近 100 筆訂單（支援狀態篩選）
// ?status=待付款
app.get('/api/admin/orders', async (req, res) => {
  if (req.headers['x-admin-key'] !== 'bunnybliss') return res.status(403).json({ error: '無權限' });

  const LIMIT = 100;
  let q = supabase.from('orders').select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(0, LIMIT - 1);

  if (req.query.status) q = q.eq('status', req.query.status);

  const { data, count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data, total: count, limit: LIMIT });
});

// PATCH /api/admin/orders/:id — 後台更新訂單狀態
app.patch('/api/admin/orders/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== 'bunnybliss') return res.status(403).json({ error: '無權限' });
  const { status } = req.body;
  const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/admin/ecpay/query/:orderId — 後台主動查詢 ECPay 付款狀態
// 用於 ReturnURL callback 漏失時人工補確認
app.get('/api/admin/ecpay/query/:orderId', async (req, res) => {
  if (req.headers['x-admin-key'] !== 'bunnybliss') return res.status(403).json({ error: '無權限' });

  const { data: order, error: fetchErr } = await supabase
    .from('orders').select('*').eq('id', req.params.orderId).single();
  if (fetchErr || !order) return res.status(404).json({ error: '訂單不存在' });

  const tradeNo = order.payment?.ecpay_trade_no;
  if (!tradeNo) return res.status(400).json({ error: '此訂單無 ECPay 交易編號（非信用卡付款）' });

  // 從 ECPAY_PAYMENT_URL 推導 QueryTradeInfo URL
  const base = (process.env.ECPAY_PAYMENT_URL || 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5')
    .replace('/Cashier/AioCheckOut/V5', '');
  const queryUrl = `${base}/Cashier/QueryTradeInfo/V5`;

  const params = {
    MerchantID:      process.env.ECPAY_PAYMENT_MERCHANT_ID,
    MerchantTradeNo: tradeNo,
    TimeStamp:       Math.floor(Date.now() / 1000), // ⚠️ Unix 秒，非毫秒
  };
  params.CheckMacValue = generatePaymentCMV(params);

  try {
    const body = new URLSearchParams(params).toString();
    const { data: rawResp } = await axios.post(queryUrl, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    // 回應為 URL-encoded 字串，驗證 CheckMacValue
    const result = Object.fromEntries(new URLSearchParams(rawResp));
    if (!verifyPaymentCMV(result)) {
      return res.status(500).json({ error: '綠界回應 CheckMacValue 驗證失敗' });
    }

    const isPaid = result.TradeStatus === '1';

    // 驗證金額一致性
    const amountMatch = parseInt(result.TradeAmt) === order.total;
    if (isPaid && !amountMatch) {
      console.error(`[ECPay query] 金額不符！ECPay=${result.TradeAmt} DB=${order.total} 訂單=${req.params.orderId}`);
      return res.status(400).json({ error: `金額不符：綠界 NT$${result.TradeAmt}，訂單 NT$${order.total}` });
    }

    // 若已付款且金額一致但訂單狀態尚未更新（callback 漏失），自動補更新
    const shouldUpdate = isPaid && amountMatch && order.status === '待付款';
    if (shouldUpdate) {
      await supabase.from('orders').update({ status: '已付款' }).eq('id', req.params.orderId);
    }

    res.json({
      isPaid,
      amountMatch,
      tradeAmt: result.TradeAmt,
      tradeStatus: result.TradeStatus,
      paymentType: result.PaymentType || '',
      paymentDate: result.PaymentDate || '',
      autoUpdated: shouldUpdate,
    });
  } catch (err) {
    console.error('[ECPay query]', err.message);
    res.status(502).json({ error: '無法聯繫綠界，請稍後再試' });
  }
});

// GET /api/cvs-stores?type=FAMI|UNIMART|HILIFE|OKMART|All
app.get('/api/cvs-stores', async (req, res) => {
  const cvsType = req.query.type || 'All';
  const allowed = ['All', 'FAMI', 'UNIMART', 'HILIFE', 'OKMART', 'UNIMARTFREEZE'];
  if (!allowed.includes(cvsType)) return res.status(400).json({ error: '不支援的 CvsType' });

  const now = Date.now();
  if (cache[cvsType] && now - cache[cvsType].fetchedAt < CACHE_TTL_MS) {
    return res.json(cache[cvsType].data);
  }

  try {
    const data = await fetchFromEcpay(cvsType);
    cache[cvsType] = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    console.error(`[ECPay] 取得門市清單失敗 (${cvsType}):`, err.message);
    res.status(502).json({ error: '無法取得門市資料，請稍後再試' });
  }
});

// POST /api/upload — 上傳圖片至 Cloudinary，回傳 { url }
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到圖片' });
  try {
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(dataUri, { folder: 'bunnybliss' });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('[Cloudinary] 上傳失敗:', err.message, err.http_code, JSON.stringify(err));
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status  — 全站健康檢查
app.get('/api/status', async (req, res) => {
  const result = {
    server: 'ok',
    timestamp: new Date().toISOString(),
    supabase: 'unknown',
    cloudinary: 'unknown',
  };

  // 測試 Supabase
  try {
    const { error } = await supabase.from('store_data').select('key').limit(1);
    result.supabase = error ? `error: ${error.message}` : 'ok';
  } catch (e) {
    result.supabase = `error: ${e.message}`;
  }

  // 確認 Cloudinary 設定有沒有缺漏
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  result.cloudinary = (cloud_name && api_key && api_secret) ? 'ok' : 'missing config';

  const allOk = result.supabase === 'ok' && result.cloudinary === 'ok';
  res.status(allOk ? 200 : 500).json(result);
});

// GET /api/store/:key  — 讀取商品/橫幅等資料
app.get('/api/store/:key', async (req, res) => {
  const allowed = ['products', 'banners', 'categories', 'addons', 'settings'];
  if (!allowed.includes(req.params.key)) return res.status(400).json({ error: 'invalid key' });
  try {
    const { data, error } = await supabase
      .from('store_data')
      .select('value')
      .eq('key', req.params.key)
      .single();
    if (error && error.code === 'PGRST116') return res.json(null); // 尚未建立
    if (error) return res.status(500).json({ error: error.message });
    res.json(data.value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store/:key  — 後台儲存商品/橫幅等資料
app.post('/api/store/:key', async (req, res) => {
  const allowed = ['products', 'banners', 'categories', 'addons', 'settings'];
  if (!allowed.includes(req.params.key)) return res.status(400).json({ error: 'invalid key' });
  try {
    const { error } = await supabase
      .from('store_data')
      .upsert({ key: req.params.key, value: req.body, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bliss server: http://localhost:${PORT}`);
  console.log(`ECPay 物流 URL: ${process.env.ECPAY_LOGISTICS_URL}`);
});
