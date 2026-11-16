-- 25_entregadores_localizacao.sql
-- 1) Guarda a localização (GPS) do cliente no pedido.
-- 2) Cria a tabela de entregadores de cada loja (nome + WhatsApp), privada do dono.
-- Rode no Supabase > SQL Editor. Pode rodar mais de uma vez sem estragar nada.

-- ============ 1) Coordenadas no pedido ============
alter table public.pedidos
  add column if not exists cliente_lat double precision check (cliente_lat between -90 and 90),
  add column if not exists cliente_lon double precision check (cliente_lon between -180 and 180);

-- ============ 2) Entregadores ============
create table if not exists public.entregadores (
  id uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes(id) on delete cascade,
  nome text not null check (char_length(btrim(nome)) between 2 and 60),
  whatsapp text not null check (whatsapp ~ '^[0-9]{10,13}$'),
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists entregadores_restaurante_idx
  on public.entregadores (restaurante_id);

-- Não deixa cadastrar o mesmo número duas vezes na mesma loja
create unique index if not exists entregadores_zap_unico
  on public.entregadores (restaurante_id, whatsapp);

alter table public.entregadores enable row level security;

-- Número de entregador não é público: só o dono da loja enxerga e mexe.
revoke all on public.entregadores from anon;

drop policy if exists entregadores_dono_le on public.entregadores;
create policy entregadores_dono_le on public.entregadores
  for select to authenticated
  using (restaurante_id in (select meus_restaurantes()));

drop policy if exists entregadores_dono_cria on public.entregadores;
create policy entregadores_dono_cria on public.entregadores
  for insert to authenticated
  with check (restaurante_id in (select meus_restaurantes()));

drop policy if exists entregadores_dono_edita on public.entregadores;
create policy entregadores_dono_edita on public.entregadores
  for update to authenticated
  using (restaurante_id in (select meus_restaurantes()))
  with check (restaurante_id in (select meus_restaurantes()));

drop policy if exists entregadores_dono_apaga on public.entregadores;
create policy entregadores_dono_apaga on public.entregadores
  for delete to authenticated
  using (restaurante_id in (select meus_restaurantes()));

-- ============ Conferência (resultado esperado: 2 linhas em colunas + 4 policies) ============
select 'coluna' as tipo, column_name as nome
  from information_schema.columns
 where table_schema = 'public' and table_name = 'pedidos'
   and column_name in ('cliente_lat', 'cliente_lon')
union all
select 'policy', policyname
  from pg_policies
 where schemaname = 'public' and tablename = 'entregadores'
 order by 1, 2;
