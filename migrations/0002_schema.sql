create table if not exists portfolios (
  user_id text primary key,
  cash numeric not null default 25000,
  starting_cash numeric not null default 25000,
  created_at timestamptz not null default now()
);

create table if not exists bots (
  id serial primary key,
  user_id text not null,
  name text not null,
  symbol text not null,
  strategy text not null,
  params jsonb not null default '{}',
  status text not null default 'paused',
  allocated numeric not null,
  cash numeric not null,
  position_qty numeric not null default 0,
  avg_entry numeric not null default 0,
  last_action_px numeric not null default 0,
  dca_count integer not null default 0,
  last_candle_time bigint,
  created_at timestamptz not null default now()
);
create index if not exists bots_user_id_idx on bots (user_id);

create table if not exists trades (
  id serial primary key,
  user_id text not null,
  bot_id integer references bots(id) on delete set null,
  symbol text not null,
  side text not null,
  qty numeric not null,
  price numeric not null,
  fee numeric not null default 0,
  pnl numeric,
  reason text,
  ts timestamptz not null default now()
);
create index if not exists trades_user_id_idx on trades (user_id, ts desc);
create index if not exists trades_bot_id_idx on trades (bot_id);

create table if not exists positions (
  user_id text not null,
  symbol text not null,
  qty numeric not null default 0,
  avg_entry numeric not null default 0,
  primary key (user_id, symbol)
);
