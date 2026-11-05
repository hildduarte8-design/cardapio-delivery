-- =============================================================================
-- sql/04_clientes_e_legado.sql
--
-- Cria, no sistema novo, o lugar onde ficam os dados vindos do app antigo:
--   * public.clientes ........ cadastro de clientes por restaurante
--                              (contato + selos de fidelidade)
--   * public.pedidos_legado .. histórico de compras do app antigo (arquivo,
--                              somente consulta; não mistura com pedidos novos)
--   * public.telefone_normalizado(text) .. padroniza telefone (só dígitos, com 55)
--
-- Este script NÃO copia dados e NÃO mexe em nenhuma tabela existente.
-- Só o dono do restaurante enxerga estas tabelas (RLS); o cliente anônimo não
-- enxerga nada. Pode ser rodado mais de uma vez. Tudo em uma transação.
-- =============================================================================

begin;

do $$
begin
  if to_regclass('public.restaurantes') is null then
    raise exception 'Tabela public.restaurantes não encontrada. Nada foi alterado.';
  end if;
  if to_regprocedure('public.meus_restaurantes()') is null then
    raise exception 'Função public.meus_restaurantes() não encontrada. Nada foi alterado.';
  end if;
end
$$;

-- 1) Padronização de telefone ---------------------------------------------------
-- 10/11 dígitos (DDD + número)  -> 55 + número
-- 12/13 dígitos começando com 55 -> mantém
-- 8/9 dígitos (sem DDD)          -> assume DDD 33 (Teófilo Otoni) e coloca 55
-- qualquer outra coisa           -> NULL (o texto original fica guardado)
create or replace function public.telefone_normalizado(t text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when d = ''                                  then null
    when length(d) in (10, 11)                   then '55' || d
    when length(d) in (12, 13) and d like '55%'  then d
    when length(d) in (8, 9)                     then '5533' || d
    else null
  end
  from (select regexp_replace(coalesce(t, ''), '\D', '', 'g') as d) x
$$;

-- 2) Clientes ---------------------------------------------------------------------
create table if not exists public.clientes (
  id               uuid primary key default gen_random_uuid(),
  restaurante_id   uuid not null references public.restaurantes(id),
  nome             text not null,
  telefone         text,                 -- normalizado (ex.: 5533999999999)
  telefone_original text,                -- exatamente como estava no app antigo
  endereco         text,
  selos_fidelidade integer not null default 0 check (selos_fidelidade >= 0),
  ultimo_pedido_em timestamptz,
  legacy_id        uuid unique,          -- id do cliente no app antigo
  origem           text not null default 'manual',
  created_at       timestamptz not null default now()
);

create unique index if not exists clientes_restaurante_telefone_uq
  on public.clientes (restaurante_id, telefone) where telefone is not null;
create index if not exists clientes_restaurante_idx
  on public.clientes (restaurante_id);

-- 3) Histórico do app antigo -------------------------------------------------------
create table if not exists public.pedidos_legado (
  id              text primary key,      -- id do pedido no app antigo
  restaurante_id  uuid not null references public.restaurantes(id),
  cliente_id      uuid references public.clientes(id) on delete set null,
  criado_em       timestamptz,
  cliente_nome    text,
  telefone        text,
  tipo_pedido     text,
  endereco        text,
  numero          text,
  referencia      text,
  itens           jsonb,
  subtotal        numeric,
  taxa_entrega    numeric,
  desconto        numeric,
  total           numeric,
  valor_liquido   numeric,
  status          text,
  origem          text,
  forma_pagamento text,
  tipo_entrega    text,
  original        jsonb not null,        -- linha completa como era no app antigo
  importado_em    timestamptz not null default now()
);

create index if not exists pedidos_legado_restaurante_idx
  on public.pedidos_legado (restaurante_id, criado_em desc);
create index if not exists pedidos_legado_cliente_idx
  on public.pedidos_legado (cliente_id);

-- 4) Segurança: só o dono do restaurante enxerga ------------------------------------
alter table public.clientes       enable row level security;
alter table public.pedidos_legado enable row level security;

revoke all on public.clientes, public.pedidos_legado from anon;
revoke all on public.clientes, public.pedidos_legado from authenticated;
grant select, insert, update, delete on public.clientes       to authenticated;
grant select                         on public.pedidos_legado to authenticated;

drop policy if exists clientes_dono_tudo on public.clientes;
create policy clientes_dono_tudo on public.clientes
  for all to authenticated
  using      (restaurante_id in (select public.meus_restaurantes()))
  with check (restaurante_id in (select public.meus_restaurantes()));

drop policy if exists pedidos_legado_dono_le on public.pedidos_legado;
create policy pedidos_legado_dono_le on public.pedidos_legado
  for select to authenticated
  using (restaurante_id in (select public.meus_restaurantes()));

comment on table public.clientes is
  'Clientes por restaurante (contato e selos de fidelidade). Dados pessoais: acesso só do dono.';
comment on table public.pedidos_legado is
  'Arquivo do histórico de pedidos do app antigo (delivery-control). Somente leitura.';

commit;

-- Conferência: deve listar as duas tabelas com rls_ligado = true
select c.relname as tabela, c.relrowsecurity as rls_ligado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('clientes', 'pedidos_legado')
order by c.relname;
