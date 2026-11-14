-- Liga/desliga do frete por distância por restaurante (padrão: desligado).
-- Já aplicado manualmente em produção em 14/11/2026; o "if not exists" deixa o script seguro para rodar de novo.
alter table public.restaurantes
  add column if not exists frete_por_distancia boolean not null default false;

comment on column public.restaurantes.frete_por_distancia is
  'Quando true, o cardapio cota o frete por rota (Mapbox/OSRM) usando a localizacao do cliente; o bairro continua como fallback. Padrao false = so taxa por bairro.';
