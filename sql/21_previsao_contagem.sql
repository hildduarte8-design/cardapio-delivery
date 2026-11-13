alter table public.restaurantes
  add column if not exists previsao_contagem boolean not null default false;
