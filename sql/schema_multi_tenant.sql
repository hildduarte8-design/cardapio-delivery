# Guarda o script SQL que rodamos no Supabase
-- =====================================================
-- MIGRAÇÃO MULTI-RESTAURANTE (SaaS)
-- =====================================================

-- 1. Restaurantes
create table if not exists restaurantes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  nome text not null,
  whatsapp text,
  loja_lat numeric(9,6),
  loja_lon numeric(9,6),
  taxa_base numeric(10,2) not null default 5.00,
  valor_km numeric(10,2) not null default 1.50,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. Vínculo Usuário x Restaurante
create table if not exists restaurante_usuarios (
  user_id uuid not null references auth.users(id) on delete cascade,
  restaurante_id uuid not null references restaurantes(id) on delete cascade,
  papel text not null default 'dono',
  primary key (user_id, restaurante_id)
);

-- 3. Função Auxiliar RLS
create or replace function public.meus_restaurantes()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select restaurante_id from restaurante_usuarios where user_id = auth.uid()
$$;
revoke all on function public.meus_restaurantes() from public, anon;
grant execute on function public.meus_restaurantes() to authenticated;

-- 4. Primeiro registro (Imperial)
insert into restaurantes (slug, nome)
values ('imperial', 'Pastel e Batata Imperial')
on conflict (slug) do nothing;

-- 5. Colunas de vínculo multi-tenant
alter table produtos          add column if not exists restaurante_id uuid references restaurantes(id) on delete cascade;
alter table bairros           add column if not exists restaurante_id uuid references restaurantes(id) on delete cascade;
alter table bairros_sinonimos add column if not exists restaurante_id uuid references restaurantes(id) on delete cascade;
alter table pedidos           add column if not exists restaurante_id uuid references restaurantes(id) on delete cascade;

update produtos          set restaurante_id = (select id from restaurantes where slug = 'imperial') where restaurante_id is null;
update bairros           set restaurante_id = (select id from restaurantes where slug = 'imperial') where restaurante_id is null;
update bairros_sinonimos set restaurante_id = (select id from restaurantes where slug = 'imperial') where restaurante_id is null;
update pedidos           set restaurante_id = (select id from restaurantes where slug = 'imperial') where restaurante_id is null;

alter table produtos          alter column restaurante_id set not null;
alter table bairros           alter column restaurante_id set not null;
alter table bairros_sinonimos alter column restaurante_id set not null;
alter table pedidos           alter column restaurante_id set not null;

do $$
begin
  execute format(
    'alter table pedidos alter column restaurante_id set default %L',
    (select id from restaurantes where slug = 'imperial')
  );
end $$;

alter table bairros drop constraint if exists bairros_nome_key;
alter table bairros drop constraint if exists bairros_restaurante_nome_key;
alter table bairros add constraint bairros_restaurante_nome_key unique (restaurante_id, nome);

alter table bairros_sinonimos drop constraint if exists bairros_sinonimos_nome_popular_key;
alter table bairros_sinonimos drop constraint if exists sinonimos_restaurante_nome_key;
alter table bairros_sinonimos add constraint sinonimos_restaurante_nome_key unique (restaurante_id, nome_popular);

create index if not exists produtos_restaurante_idx on produtos (restaurante_id);
create index if not exists bairros_restaurante_idx  on bairros (restaurante_id);
create index if not exists pedidos_restaurante_idx  on pedidos (restaurante_id, created_at desc);

-- 6. Vincular usuário gestor (substitua pelo seu e-mail no Supabase)
insert into restaurante_usuarios (user_id, restaurante_id)
select u.id, r.id
from auth.users u, restaurantes r
where u.email = 'seu-email@exemplo.com' and r.slug = 'imperial'
on conflict do nothing;

-- 7. Políticas RLS
alter table restaurantes enable row level security;
alter table restaurante_usuarios enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('restaurantes','restaurante_usuarios','produtos','bairros','bairros_sinonimos','pedidos')
  loop
    execute format('drop policy if exists %I on %I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "restaurantes_leitura_publica" on restaurantes for select to anon, authenticated using (ativo = true);
create policy "restaurantes_leitura_dono" on restaurantes for select to authenticated using (id in (select meus_restaurantes()));
create policy "restaurantes_edita_dono" on restaurantes for update to authenticated using (id in (select meus_restaurantes())) with check (id in (select meus_restaurantes()));

create policy "vinculos_proprios" on restaurante_usuarios for select to authenticated using (user_id = auth.uid());

create policy "produtos_leitura_publica" on produtos for select to anon, authenticated using (disponivel = true);
create policy "produtos_dono_le" on produtos for select to authenticated using (restaurante_id in (select meus_restaurantes()));
create policy "produtos_dono_cria" on produtos for insert to authenticated with check (restaurante_id in (select meus_restaurantes()) and preco > 0);
create policy "produtos_dono_edita" on produtos for update to authenticated using (restaurante_id in (select meus_restaurantes())) with check (restaurante_id in (select meus_restaurantes()) and preco > 0);
create policy "produtos_dono_exclui" on produtos for delete to authenticated using (restaurante_id in (select meus_restaurantes()));

create policy "bairros_leitura_publica" on bairros for select to anon, authenticated using (ativo = true);
create policy "bairros_dono_le" on bairros for select to authenticated using (restaurante_id in (select meus_restaurantes()));
create policy "bairros_dono_cria" on bairros for insert to authenticated with check (restaurante_id in (select meus_restaurantes()) and taxa >= 0);
create policy "bairros_dono_edita" on bairros for update to authenticated using (restaurante_id in (select meus_restaurantes())) with check (restaurante_id in (select meus_restaurantes()) and taxa >= 0);

create policy "sinonimos_dono_tudo" on bairros_sinonimos for all to authenticated using (restaurante_id in (select meus_restaurantes())) with check (restaurante_id in (select meus_restaurantes()));

create policy "pedidos_cliente_cria" on pedidos for insert to anon, authenticated
  with check (
    exists (select 1 from restaurantes r where r.id = restaurante_id and r.ativo)
    and status = 'pendente_pagamento'
    and subtotal > 0
    and taxa_entrega >= 0
    and abs(total - (subtotal + taxa_entrega)) < 0.01
    and char_length(cliente_nome) between 2 and 80
    and char_length(endereco_completo) between 5 and 200
  );
create policy "pedidos_dono_le" on pedidos for select to authenticated using (restaurante_id in (select meus_restaurantes()));
create policy "pedidos_dono_atualiza" on pedidos for update to authenticated using (restaurante_id in (select meus_restaurantes())) with check (restaurante_id in (select meus_restaurantes()));