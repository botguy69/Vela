with ranked as (
  select id,
         row_number() over (
           partition by user_id, weex_symbol, side
           order by created_at asc
         ) as rn
  from auto_signals
  where status in ('proposed', 'working', 'filled')
)
update auto_signals s
set status = 'skipped',
    pnl = 0,
    close_reason = 'Duplicate — merged into one ticket',
    updated_at = now()
from ranked r
where s.id = r.id and r.rn > 1;

create unique index if not exists auto_signals_one_open
  on auto_signals (user_id, weex_symbol, side)
  where status in ('proposed', 'working', 'filled');
