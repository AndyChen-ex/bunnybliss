require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const TEST_USER = require('./db-config');

module.exports = async function globalSetup() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // 確認 test user 存在，不存在則建立（已 email_confirm）
  const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const exists = users?.some(u => u.email === TEST_USER.email);

  if (!exists) {
    const { error } = await supabase.auth.admin.createUser({
      email: TEST_USER.email,
      password: TEST_USER.password,
      user_metadata: { name: TEST_USER.name },
      email_confirm: true,
    });
    if (error) throw new Error(`[DB Setup] 建立測試帳號失敗: ${error.message}`);
    console.log('[DB Setup] 建立測試帳號:', TEST_USER.email);
  } else {
    console.log('[DB Setup] 測試帳號已存在:', TEST_USER.email);
  }
};
