require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.'));

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

app.listen(PORT, () => {
  console.log(`Bunny Bliss server: http://localhost:${PORT}`);
  console.log(`ECPay 物流 URL: ${process.env.ECPAY_LOGISTICS_URL}`);
});
