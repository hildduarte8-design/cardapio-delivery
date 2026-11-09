-- Adicionais (extras com preço e foto) e vínculo com produtos.
-- Aditivo: não altera pedidos nem nada que já existe em uso.

-- 1) Adicionais do restaurante
create table if not exists public.adicionais (
  id uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references public.restaurantes(id) on delete cascade,
  nome text not null,
  preco numeric(10,2) not null default 0,
  imagem_url text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint adicionais_nome_chk
    check (nome = btrim(nome) and char_length(nome) between 1 and 60),
  constraint adicionais_preco_chk
    check (preco >= 0 and preco <= 1000),
  constraint adicionais_id_rest_uk unique (id, restaurante_id)
);

create index if not exists adicionais_rest_idx
  on public.adicionais (restaurante_id);

-- 2) Chave auxiliar em produtos (garante que produto e adicional são do mesmo restaurante)
alter table public.produtos drop constraint if exists produtos_id_rest_uk;
alter table public.produtos add constraint produtos_id_rest_uk unique (id, restaurante_id);

-- 3) Quais adicionais valem para cada produto
create table if not exists public.produto_adicionais (
  produto_id uuid not null,
  adicional_id uuid not null,
  restaurante_id uuid not null,
  primary key (produto_id, adicional_id),
  constraint pa_produto_fk
    foreign key (produto_id, restaurante_id)
    references public.produtos (id, restaurante_id) on delete cascade,
  constraint pa_adicional_fk
    foreign key (adicional_id, restaurante_id)
    references public.adicionais (id, restaurante_id) on delete cascade
);

create index if not exists pa_adicional_idx
  on public.produto_adicionais (adicional_id);
create index if not exists pa_restaurante_idx
  on public.produto_adicionais (restaurante_id);

-- 4) Segurança (RLS), no mesmo padrão de produtos
alter table public.adicionais enable row level security;
alter table public.produto_adicionais enable row level security;

drop policy if exists adicionais_dono_le on public.adicionais;
drop policy if exists adicionais_dono_cria on public.adicionais;
drop policy if exists adicionais_dono_edita on public.adicionais;
drop policy if exists adicionais_dono_exclui on public.adicionais;
drop policy if exists adicionais_leitura_publica on public.adicionais;

create policy adicionais_dono_le on public.adicionais
  for select to authenticated
  using (restaurante_id in (select meus_restaurantes()));

create policy adicionais_dono_cria on public.adicionais
  for insert to authenticated
  with check (restaurante_id in (select meus_restaurantes()));

create policy adicionais_dono_edita on public.adicionais
  for update to authenticated
  using (restaurante_id in (select meus_restaurantes()))
  with check (restaurante_id in (select meus_restaurantes()));

create policy adicionais_dono_exclui on public.adicionais
  for delete to authenticated
  using (restaurante_id in (select meus_restaurantes()));

create policy adicionais_leitura_publica on public.adicionais
  for select to anon, authenticated
  using (ativo = true);

drop policy if exists pa_dono_le on public.produto_adicionais;
drop policy if exists pa_dono_cria on public.produto_adicionais;
drop policy if exists pa_dono_exclui on public.produto_adicionais;
drop policy if exists pa_leitura_publica on public.produto_adicionais;

create policy pa_dono_le on public.produto_adicionais
  for select to authenticated
  using (restaurante_id in (select meus_restaurantes()));

create policy pa_dono_cria on public.produto_adicionais
  for insert to authenticated
  with check (restaurante_id in (select meus_restaurantes()));

create policy pa_dono_exclui on public.produto_adicionais
  for delete to authenticated
  using (restaurante_id in (select meus_restaurantes()));

create policy pa_leitura_publica on public.produto_adicionais
  for select to anon, authenticated
  using (true);

-- 5) Permissões de acesso
grant select on public.adicionais, public.produto_adicionais to anon, authenticated;
grant insert, update, delete on public.adicionais to authenticated;
grant insert, delete on public.produto_adicionais to authenticated;
