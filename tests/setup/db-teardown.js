require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const TEST_USER = require('./db-config');

module.exports = async function globalTeardown() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // 清除測試訂單
  const { error: orderErr } = await supabase
    .from('orders')
    .delete()
    .eq('user_email', TEST_USER.email);
  if (orderErr) console.warn('[DB Teardown] 清除訂單失敗:', orderErr.message);

  // 清除測試 profile
  const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const user = users?.find(u => u.email === TEST_USER.email);
  if (user) {
    await supabase.from('profiles').delete().eq('id', user.id);
  }

  console.log('[DB Teardown] 測試資料已清除');
};
