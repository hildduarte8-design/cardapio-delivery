-- sql/11_ordem_destaque_promocao.sql
begin;

-- Ordem dos produtos, destaque e preço promocional
alter table public.produtos add column if not exists ordem integer not null default 0;
alter table public.produtos add column if not exists destaque boolean not null default false;
alter table public.produtos add column if not exists preco_promocional numeric;

-- Ordem das categorias (lista de nomes, na ordem escolhida pelo gestor)
alter table public.restaurantes add column if not exists ordem_categorias jsonb not null default '[]'::jsonb;

alter table public.restaurantes drop constraint if exists restaurantes_ordem_categorias_chk;
alter table public.restaurantes add constraint restaurantes_ordem_categorias_chk
  check (jsonb_typeof(ordem_categorias) = 'array');

-- Promoção: precisa ser maior que zero e menor que o preço normal
alter table public.produtos drop constraint if exists produtos_promo_chk;
alter table public.produtos add constraint produtos_promo_chk
  check (preco_promocional is null or (preco_promocional > 0 and preco_promocional < preco));

-- Máximo de 6 destaques por restaurante
create or replace function public.produtos_limite_destaques()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.destaque is true and (tg_op = 'INSERT' or old.destaque is distinct from true) then
    if (select count(*) from public.produtos p
         where p.restaurante_id = new.restaurante_id
           and p.destaque is true
           and p.id <> new.id) >= 6 then
      raise exception 'LIMITE_DESTAQUES';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists produtos_limite_destaques_trg on public.produtos;
create trigger produtos_limite_destaques_trg
  before insert or update on public.produtos
  for each row execute function public.produtos_limite_destaques();

-- Ordem inicial dos produtos = a ordem atual (categoria e nome), de 10 em 10
update public.produtos p
   set ordem = s.rn * 10
  from (
    select id, row_number() over (partition by restaurante_id order by categoria, nome) as rn
      from public.produtos
  ) s
 where p.id = s.id and p.ordem = 0;

commit;

-- Conferência: devem aparecer 4 linhas
select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'produtos' and column_name in ('ordem','destaque','preco_promocional'))
     or (table_name = 'restaurantes' and column_name = 'ordem_categorias'))
 order by table_name, column_name;
