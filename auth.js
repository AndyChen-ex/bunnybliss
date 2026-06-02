// Shared Supabase Auth — included in all pages after supabase CDN script
(async function () {
  const cfg = await fetch('/api/config').then(r => r.json());
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error('[auth] 缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY，請檢查 .env');
    return;
  }
  window._sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  window._bbUser = null;

  function _apply(user) {
    window._bbUser = user;
    updateAuthNav(user);
    if (typeof window._onAuthChange === 'function') window._onAuthChange(user);
  }

  window._sb.auth.onAuthStateChange((_e, session) => _apply(session?.user ?? null));
  const { data: { session } } = await window._sb.auth.getSession();
  _apply(session?.user ?? null);
})();

function updateAuthNav(user) {
  const name = user?.user_metadata?.name || user?.email?.split('@')[0] || '';
  const s = (id, v) => { const e = document.getElementById(id); if (e) e.style.display = v ? '' : 'none'; };
  s('nav-auth-guest', !user); s('nav-auth-user', !!user);
  s('mob-auth-guest', !user); s('mob-auth-user', !!user);
  ['nav-username', 'mob-username'].forEach(id => { const e = document.getElementById(id); if (e) e.textContent = name; });
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  if (!email || !pass) { showToast('請填寫電子信箱與密碼'); return; }
  const { error } = await window._sb.auth.signInWithPassword({ email, password: pass });
  if (error) { showToast('電子信箱或密碼錯誤，或 Email 尚未驗證'); return; }
  if (typeof window._closeAuthModal === 'function') window._closeAuthModal();
  showToast('登入成功！歡迎回來');
  if (window._pendingCheckout) { window._pendingCheckout = false; location.href = '/checkout'; }
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass = document.getElementById('reg-pass').value;
  if (!name || !email || !pass) { showToast('請填寫所有欄位'); return; }
  const pass2El = document.getElementById('reg-pass2');
  if (pass2El && pass !== pass2El.value) { showToast('兩次密碼不一致'); return; }
  if (pass.length < 6) { showToast('密碼至少需要 6 個字元'); return; }
  const { exists } = await fetch('/api/check-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }).then(r => r.json());
  if (exists) { showToast('此 Email 已註冊，請直接登入'); return; }
  const { data, error } = await window._sb.auth.signUp({ email, password: pass, options: { data: { name } } });
  if (error) { showToast('註冊失敗：' + error.message); return; }
  if (typeof window._closeAuthModal === 'function') window._closeAuthModal();
  if (data.session) {
    showToast('註冊成功！歡迎加入 Bunny Bliss');
    if (window._pendingCheckout) { window._pendingCheckout = false; location.href = '/checkout'; }
  } else {
    showToast('驗證信已送出，請查收 Email 完成驗證！');
  }
}

async function doLogout() {
  await window._sb.auth.signOut();
  showToast('已登出');
}
