-- 22_frete_por_distancia.sql
-- Liga/desliga o cálculo de frete por distância (GPS + rota) por restaurante.
-- Seguro rodar mais de uma vez (if not exists). O raio_max_km já existe (migração 03).

alter table public.restaurantes
  add column if not exists frete_por_distancia boolean not null default false;

-- Conferência: deve devolver 2 linhas (frete_por_distancia e raio_max_km)
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'restaurantes'
  and column_name in ('frete_por_distancia', 'raio_max_km');
