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

// GET /api/config — 回傳前端需要的公開設定
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// POST /api/check-email — 檢查 email 是否已被註冊
app.post('/api/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (error) return res.status(500).json({ error: error.message });
    const exists = data.users.some(u => u.email?.toLowerCase() === email.toLowerCase());
    res.json({ exists });
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

// GET /api/orders — 取得會員自己的訂單
app.get('/api/orders', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '未授權' });
  const { data, error } = await supabase.from('orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/admin/orders — 後台取得全部訂單（用 service key，不驗證 JWT）
app.get('/api/admin/orders', async (req, res) => {
  if (req.headers['x-admin-key'] !== 'bunnybliss') return res.status(403).json({ error: '無權限' });
  const { data, error } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/admin/orders/:id — 後台更新訂單狀態
app.patch('/api/admin/orders/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== 'bunnybliss') return res.status(403).json({ error: '無權限' });
  const { status } = req.body;
  const { error } = await supabase.from('orders').update({ status }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
