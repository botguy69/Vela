alter table auto_settings add column if not exists keep_alive boolean not null default false;
alter table auto_settings add column if not exists last_cron_at timestamptz;
alter table auto_settings add column if not exists public_origin text;
