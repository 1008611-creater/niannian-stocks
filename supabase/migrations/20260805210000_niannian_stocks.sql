-- 念念智股：仅供 Railway 服务端使用的用户数据模型。
-- 客户端不持有 service role 凭据；每一次读写均须由 Railway 验证 Clerk JWT 后按 user_id 约束。

create extension if not exists pgcrypto;

create or replace function public.niannian_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.niannian_portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  is_default boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists niannian_portfolios_one_default_per_user
  on public.niannian_portfolios (user_id)
  where is_default;
create index if not exists niannian_portfolios_by_user
  on public.niannian_portfolios (user_id, updated_at desc);

create table if not exists public.niannian_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  portfolio_id uuid not null references public.niannian_portfolios(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z.]{1,10}$'),
  quantity numeric(20, 6) not null check (quantity > 0),
  average_cost numeric(20, 6) not null check (average_cost > 0),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, portfolio_id, symbol)
);
create index if not exists niannian_holdings_by_user_portfolio
  on public.niannian_holdings (user_id, portfolio_id, updated_at desc);

create table if not exists public.niannian_watchlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  symbol text not null check (symbol ~ '^[A-Z.]{1,10}$'),
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, symbol)
);
create index if not exists niannian_watchlist_by_user
  on public.niannian_watchlist_items (user_id, created_at desc);

-- PostgreSQL does not support CREATE TYPE IF NOT EXISTS on all supported
-- Supabase versions. Keep this migration safely repeatable instead.
do $$
begin
  create type public.niannian_alert_kind as enum ('price_change', 'rsi_cross', 'trend_shift');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.niannian_delivery_status as enum ('triggered', 'sent', 'failed', 'read');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.niannian_plan_key as enum ('free', 'pro');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.niannian_device_platform as enum ('android', 'web');
exception when duplicate_object then null;
end $$;

create table if not exists public.niannian_alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  symbol text not null check (symbol ~ '^[A-Z.]{1,10}$'),
  kind public.niannian_alert_kind not null,
  threshold numeric(20, 6) not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists niannian_alert_rules_by_user_symbol
  on public.niannian_alert_rules (user_id, symbol, enabled);
create index if not exists niannian_alert_rules_enabled
  on public.niannian_alert_rules (enabled, updated_at desc)
  where enabled;

create table if not exists public.niannian_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  alert_rule_id uuid not null references public.niannian_alert_rules(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z.]{1,10}$'),
  period_key text not null check (char_length(period_key) between 1 and 64),
  status public.niannian_delivery_status not null default 'triggered',
  value numeric(20, 6) not null,
  triggered_at timestamptz not null default timezone('utc', now()),
  delivered_at timestamptz,
  read_at timestamptz,
  unique (alert_rule_id, period_key)
);
create index if not exists niannian_alert_deliveries_by_user_period
  on public.niannian_alert_deliveries (user_id, period_key desc);

create table if not exists public.niannian_research_reports (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  symbol text not null check (symbol ~ '^[A-Z.]{1,10}$'),
  snapshot_id text not null check (char_length(snapshot_id) between 1 and 128),
  summary text not null check (char_length(summary) between 1 and 12000),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists niannian_research_reports_by_user_symbol
  on public.niannian_research_reports (user_id, symbol, created_at desc);

create table if not exists public.niannian_entitlements (
  user_id text primary key check (char_length(user_id) between 1 and 191),
  plan_key public.niannian_plan_key not null default 'free',
  valid_until timestamptz,
  features jsonb not null default '{"cloudSync": false, "backgroundAlerts": false, "earningsEvents": false, "aiResearch": false, "advancedScreener": false}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.niannian_device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 191),
  token text not null check (char_length(token) between 1 and 4096),
  platform public.niannian_device_platform not null,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  unique (token)
);
create index if not exists niannian_device_tokens_by_user
  on public.niannian_device_tokens (user_id, enabled, last_seen_at desc);

drop trigger if exists niannian_portfolios_set_updated_at on public.niannian_portfolios;
create trigger niannian_portfolios_set_updated_at
  before update on public.niannian_portfolios
  for each row execute function public.niannian_set_updated_at();

drop trigger if exists niannian_holdings_set_updated_at on public.niannian_holdings;
create trigger niannian_holdings_set_updated_at
  before update on public.niannian_holdings
  for each row execute function public.niannian_set_updated_at();

drop trigger if exists niannian_alert_rules_set_updated_at on public.niannian_alert_rules;
create trigger niannian_alert_rules_set_updated_at
  before update on public.niannian_alert_rules
  for each row execute function public.niannian_set_updated_at();

drop trigger if exists niannian_entitlements_set_updated_at on public.niannian_entitlements;
create trigger niannian_entitlements_set_updated_at
  before update on public.niannian_entitlements
  for each row execute function public.niannian_set_updated_at();

-- 所有数据表均启用 RLS，且不创建匿名/浏览器直连策略。
-- 仅 Railway 的 service role 在验证 Clerk 身份、按 user_id 加条件后才能访问。
alter table public.niannian_portfolios enable row level security;
alter table public.niannian_holdings enable row level security;
alter table public.niannian_watchlist_items enable row level security;
alter table public.niannian_alert_rules enable row level security;
alter table public.niannian_alert_deliveries enable row level security;
alter table public.niannian_research_reports enable row level security;
alter table public.niannian_entitlements enable row level security;
alter table public.niannian_device_tokens enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
