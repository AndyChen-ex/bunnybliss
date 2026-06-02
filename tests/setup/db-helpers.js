require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const TEST_USER = require('./db-config');

// 從 Supabase URL 取得 project ref（用於 localStorage key）
const PROJECT_REF = (process.env.SUPABASE_URL || '').match(/\/\/(.+?)\.supabase/)?.[1] || '';

// 用 anon key 登入取得真實 session（Node.js 端）
async function getTestSession() {
  const client = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data: { session }, error } = await client.auth.signInWithPassword({
    email: TEST_USER.email,
    password: TEST_USER.password,
  });
  if (error) throw new Error(`[DB Helpers] 測試登入失敗: ${error.message}`);
  return session;
}

// 將真實 session 注入瀏覽器 localStorage（不 mock 任何東西）
async function injectRealSession(page, session) {
  await page.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: `sb-${PROJECT_REF}-auth-token`, session });
}

// 等 auth.js 確認已登入（匹配測試帳號 email）
async function waitForLogin(page) {
  await page.waitForFunction(
    (email) => window._bbUser?.email === email,
    TEST_USER.email,
    { timeout: 10000 }
  );
}

// 用 service key 清理測試訂單（每個 test 結束後呼叫）
async function cleanupOrders() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  await supabase.from('orders').delete().eq('user_email', TEST_USER.email);
}

// 用 service key 清理測試 profile
async function cleanupProfile() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const user = users?.find(u => u.email === TEST_USER.email);
  if (user) await supabase.from('profiles').delete().eq('id', user.id);
}

// 直接用 service key 讀取訂單（用於驗證 DB 狀態）
async function getOrdersFromDB() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_email', TEST_USER.email)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// 直接用 service key 讀取 profile
async function getProfileFromDB() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const user = users?.find(u => u.email === TEST_USER.email);
  if (!user) return null;
  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  return data;
}

module.exports = {
  TEST_USER,
  PROJECT_REF,
  getTestSession,
  injectRealSession,
  waitForLogin,
  cleanupOrders,
  cleanupProfile,
  getOrdersFromDB,
  getProfileFromDB,
};
