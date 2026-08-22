alter table auto_settings add column if not exists goal_usd numeric not null default 1000000;
alter table auto_settings add column if not exists peak_usd numeric;
alter table auto_settings add column if not exists loss_streak integer not null default 0;
alter table auto_settings add column if not exists last_correction text;
