alter table public.restaurantes
  add column if not exists previsao_ativa boolean not null default false,
  add column if not exists previsao_base_entrega_min integer not null default 40
    check (previsao_base_entrega_min between 5 and 240),
  add column if not exists previsao_base_retirada_min integer not null default 20
    check (previsao_base_retirada_min between 5 and 240),
  add column if not exists previsao_min_por_pedido integer not null default 5
    check (previsao_min_por_pedido between 0 and 60);
