alter table auto_settings add column if not exists stats_from timestamptz not null default now();
