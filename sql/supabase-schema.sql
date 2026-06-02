-- ============================================================
-- Bliss 布妮絲菓子工房 — Supabase Schema
-- 在 Supabase 後台 → SQL Editor 執行此檔案
-- ============================================================

-- 1. profiles 表（會員資料）
CREATE TABLE IF NOT EXISTS public.profiles (
  id        UUID    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name      TEXT    NOT NULL DEFAULT '',
  phone     TEXT    NOT NULL DEFAULT '',
  email     TEXT    NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 會員只能存取自己的資料
CREATE POLICY "profiles_self" ON public.profiles
  FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- 2. orders 表（訂單）
CREATE TABLE IF NOT EXISTS public.orders (
  id          TEXT    PRIMARY KEY,
  user_id     UUID    REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email  TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT '待付款',
  customer    JSONB   NOT NULL DEFAULT '{}',
  shipping    JSONB   NOT NULL DEFAULT '{}',
  payment     JSONB   NOT NULL DEFAULT '{}',
  items       JSONB   NOT NULL DEFAULT '[]',
  subtotal    INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- 會員只能查看自己的訂單
CREATE POLICY "orders_select_own" ON public.orders
  FOR SELECT USING (auth.uid() = user_id);

-- 會員只能新增自己的訂單
CREATE POLICY "orders_insert_own" ON public.orders
  FOR INSERT WITH CHECK (auth.uid() = user_id);
