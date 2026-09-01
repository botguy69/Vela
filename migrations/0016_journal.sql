alter table auto_signals add column if not exists setup_tag text;
alter table auto_signals add column if not exists mae_r numeric;
alter table auto_signals add column if not exists mfe_r numeric;
alter table auto_signals add column if not exists fees_usd numeric;
