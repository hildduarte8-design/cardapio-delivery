-- Motivo opcional do cancelamento (aditivo, não mexe em nada existente)
alter table public.pedidos
  add column if not exists cancelamento_motivo text;

alter table public.pedidos
  drop constraint if exists pedidos_cancelamento_motivo_chk;

alter table public.pedidos
  add constraint pedidos_cancelamento_motivo_chk
  check (
    cancelamento_motivo is null
    or (
      char_length(cancelamento_motivo) between 1 and 100
      and cancelamento_motivo = btrim(cancelamento_motivo)
    )
  );
