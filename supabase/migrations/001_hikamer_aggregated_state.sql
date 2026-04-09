-- Supabase SQL Editor で実行してください。
-- Yahoo から消えたツイートも、クライアントで蓄積した件数・貢献者・seen_tweet_ids を保持するための 1 行テーブル。

create table if not exists public.hikamer_aggregated_state (
  id text primary key default 'default',
  counts jsonb not null default '{}'::jsonb,
  contributors_by_pref jsonb not null default '{}'::jsonb,
  seen_tweet_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.hikamer_aggregated_state enable row level security;

-- 匿名キーで読み書き（公開アプリ向け。本番では認証＋RLSを厳格化してください）
create policy "hikamer_select_anon"
  on public.hikamer_aggregated_state for select
  to anon
  using (true);

create policy "hikamer_insert_anon"
  on public.hikamer_aggregated_state for insert
  to anon
  with check (true);

create policy "hikamer_update_anon"
  on public.hikamer_aggregated_state for update
  to anon
  using (true)
  with check (true);
