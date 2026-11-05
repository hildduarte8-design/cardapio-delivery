-- =============================================================================
-- sql/03_ajustes_frete_pedidos.sql
--
-- Frete híbrido (Mapbox -> OSRM -> bairro -> estimado):
--   * restaurantes.raio_max_km  .... raio máximo de entrega por restaurante
--   * pedidos.frete_tipo ........... método usado no cálculo do frete
--   * pedidos.distancia_km ......... distância usada (NULL quando frete por bairro)
--   * trigger de proteção .......... anon/authenticated não conseguem gravar nem
--                                    alterar frete_tipo/distancia_km (só o backend)
--
-- SEGURO PARA RODAR MAIS DE UMA VEZ (idempotente). Só ADICIONA coisas:
-- não remove coluna, dado, política RLS, função nem trigger existentes.
-- Tudo roda em UMA transação: se algo falhar, nada é aplicado.
--
-- ANTES (opcional, só leitura) — confira o que existe hoje:
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_schema = 'public' and table_name in ('restaurantes','pedidos')
--   order by table_name, ordinal_position;
--
--   select tgname from pg_trigger
--   where tgrelid = 'public.pedidos'::regclass and not tgisinternal;
-- =============================================================================

begin;

-- 1) Pré-condições: aborta com mensagem clara se o schema não for o esperado ----
do $$
declare
  faltando text[] := '{}';
  c text;
begin
  if to_regclass('public.restaurantes') is null then
    raise exception 'Tabela public.restaurantes não encontrada. Rode antes o schema_multi_tenant.sql.';
  end if;
  if to_regclass('public.pedidos') is null then
    raise exception 'Tabela public.pedidos não encontrada. Rode antes o schema_multi_tenant.sql.';
  end if;

  foreach c in array array['slug','ativo','loja_lat','loja_lon','taxa_base','valor_km'] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'restaurantes' and column_name = c
    ) then
      faltando := faltando || c;
    end if;
  end loop;

  if array_length(faltando, 1) is not null then
    raise exception 'Colunas ausentes em public.restaurantes: %. Nada foi alterado.', array_to_string(faltando, ', ');
  end if;
end
$$;

-- 2) Colunas novas (todas NULL por padrão: pedidos antigos não são tocados) -----
alter table public.restaurantes add column if not exists raio_max_km  numeric(6,2);
alter table public.pedidos      add column if not exists frete_tipo   text;
alter table public.pedidos      add column if not exists distancia_km numeric(7,2);

-- 3) Constraints (criadas só se ainda não existirem) ----------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'restaurantes_raio_max_km_chk'
                   and conrelid = 'public.restaurantes'::regclass) then
    alter table public.restaurantes
      add constraint restaurantes_raio_max_km_chk
      check (raio_max_km is null or (raio_max_km > 0 and raio_max_km <= 200));
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'pedidos_frete_tipo_chk'
                   and conrelid = 'public.pedidos'::regclass) then
    alter table public.pedidos
      add constraint pedidos_frete_tipo_chk
      check (frete_tipo is null
             or frete_tipo in ('rota_mapbox','rota_osrm','bairro','estimado'));
  end if;

  if not exists (select 1 from pg_constraint
                 where conname = 'pedidos_distancia_km_chk'
                   and conrelid = 'public.pedidos'::regclass) then
    alter table public.pedidos
      add constraint pedidos_distancia_km_chk
      check (distancia_km is null or (distancia_km >= 0 and distancia_km <= 1000));
  end if;

  -- Frete por rota/estimativa exige distância registrada; por bairro não.
  if not exists (select 1 from pg_constraint
                 where conname = 'pedidos_frete_coerencia_chk'
                   and conrelid = 'public.pedidos'::regclass) then
    alter table public.pedidos
      add constraint pedidos_frete_coerencia_chk
      check (frete_tipo is null or frete_tipo = 'bairro' or distancia_km is not null);
  end if;
end
$$;

-- 4) Proteção: só o backend (service_role / postgres) define o método de frete ---
-- Sem isso, um cliente com a chave anon poderia inserir um pedido dizendo que o
-- frete foi "rota_mapbox" com distância inventada. (O valor cobrado continua
-- protegido pelo trigger de validação 02_valida_pedido.sql; isto protege os
-- metadados usados em relatórios e auditoria.)
-- O PostgREST executa cada requisição com o papel do JWT (anon/authenticated/
-- service_role), então current_user distingue o backend dos demais.
create or replace function public.pedidos_protege_frete_meta()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.frete_tipo   := null;
      new.distancia_km := null;
    else
      new.frete_tipo   := old.frete_tipo;
      new.distancia_km := old.distancia_km;
    end if;
  end if;
  return new;
end
$$;

-- Trigger próprio e novo; o drop abaixo só recria ESTE trigger (idempotência).
drop trigger if exists pedidos_protege_frete_meta_trg on public.pedidos;
create trigger pedidos_protege_frete_meta_trg
  before insert or update on public.pedidos
  for each row execute function public.pedidos_protege_frete_meta();

-- 5) Documentação no próprio banco ----------------------------------------------
comment on column public.restaurantes.raio_max_km is
  'Raio máximo de entrega em km (NULL = usa só o teto global do backend, FRETE_MAX_KM_HARD).';
comment on column public.pedidos.frete_tipo is
  'Como o frete foi calculado pelo backend: rota_mapbox | rota_osrm | bairro | estimado. NULL = pedido sem cálculo do backend.';
comment on column public.pedidos.distancia_km is
  'Distância em km usada no frete (rota real ou estimada). NULL quando frete_tipo = bairro.';

commit;

-- 6) Conferência (somente leitura) ----------------------------------------------
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'restaurantes' and column_name = 'raio_max_km')
    or (table_name = 'pedidos'      and column_name in ('frete_tipo','distancia_km')))
order by table_name, column_name;

-- =============================================================================
-- DEFINIR O RAIO (exemplo; ajuste o slug e o valor):
--   update public.restaurantes set raio_max_km = 10 where slug = 'imperial';
--
-- ROLLBACK (só se realmente precisar; APAGA os dados gravados nessas colunas).
-- Mantido comentado de propósito:
--   begin;
--   drop trigger  if exists pedidos_protege_frete_meta_trg on public.pedidos;
--   drop function if exists public.pedidos_protege_frete_meta();
--   alter table public.pedidos      drop column if exists frete_tipo,
--                                   drop column if exists distancia_km;
--   alter table public.restaurantes drop column if exists raio_max_km;
--   commit;
-- =============================================================================
