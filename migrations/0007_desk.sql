alter table auto_signals add column if not exists plan text;
alter table auto_signals add column if not exists filled_at timestamptz;
