-- =============================================================================
-- sql/05_migra_app_antigo.sql
--
-- COPIA (não move) os dados do app antigo para a conta da Imperial:
--   public.customers -> public.clientes        (contato + selos de fidelidade)
--   public.orders    -> public.pedidos_legado  (histórico de compras)
--
-- ANTES DE RODAR:
--   1) rode o 04_clientes_e_legado.sql;
--   2) faça o backup (CSV) das tabelas antigas.
--
-- Não altera nem apaga nada nas tabelas antigas. Pode ser rodado de novo sem
-- duplicar (registros já copiados são ignorados). Tudo em uma transação.
-- No fim, mostra uma tabela de conferência com números (sem dados pessoais).
-- =============================================================================

begin;

-- Pré-condições ---------------------------------------------------------------
do $$
declare
  duplicados integer;
begin
  if to_regclass('public.customers') is null or to_regclass('public.orders') is null then
    raise exception 'Tabelas antigas customers/orders não encontradas. Nada foi alterado.';
  end if;
  if to_regclass('public.clientes') is null or to_regclass('public.pedidos_legado') is null then
    raise exception 'Rode antes o 04_clientes_e_legado.sql. Nada foi alterado.';
  end if;
  if not exists (select 1 from public.restaurantes where slug = 'imperial') then
    raise exception 'Restaurante com slug imperial não encontrado. Nada foi alterado.';
  end if;

  -- Dois clientes antigos com o mesmo telefone: não decido sozinho qual vale.
  select count(*) into duplicados
  from (
    select public.telefone_normalizado(phone) as t
    from public.customers
    where public.telefone_normalizado(phone) is not null
    group by 1
    having count(*) > 1
  ) d;
  if duplicados > 0 then
    raise exception 'Há % telefone(s) repetido(s) entre os clientes antigos. Nada foi copiado; avise o Claude para decidir como juntar.', duplicados;
  end if;
end
$$;

-- 1) Clientes + selos de fidelidade ----------------------------------------------
insert into public.clientes
  (restaurante_id, nome, telefone, telefone_original, endereco,
   selos_fidelidade, ultimo_pedido_em, legacy_id, origem, created_at)
select
  r.id,
  coalesce(nullif(btrim(c.name), ''), 'Sem nome'),
  public.telefone_normalizado(c.phone),
  nullif(btrim(c.phone), ''),
  nullif(btrim(c.address), ''),
  greatest(coalesce(c.loyalty_stamps, 0), 0),
  c.last_order_at,
  c.id,
  'app_antigo',
  coalesce(c.created_at, now())
from public.customers c
cross join (select id from public.restaurantes where slug = 'imperial') r
on conflict do nothing;

-- 2) Histórico de pedidos (guarda também a linha original completa) -----------------
insert into public.pedidos_legado
  (id, restaurante_id, criado_em, cliente_nome, telefone, tipo_pedido, endereco,
   numero, referencia, itens, subtotal, taxa_entrega, desconto, total,
   valor_liquido, status, origem, forma_pagamento, tipo_entrega, original)
select
  o.id,
  r.id,
  o.created_at,
  coalesce(nullif(btrim(o.client_name), ''), nullif(btrim(o.customer_name), '')),
  public.telefone_normalizado(coalesce(nullif(btrim(o.phone), ''), o.customer_phone)),
  o.order_type,
  coalesce(nullif(btrim(o.address), ''), nullif(btrim(o.delivery_address), '')),
  o.number,
  o.reference,
  o.items,
  o.subtotal,
  o.delivery_fee,
  o.discount,
  o.total,
  o.net_amount,
  o.status,
  o.source,
  o.payment_method,
  o.delivery_type,
  to_jsonb(o)
from public.orders o
cross join (select id from public.restaurantes where slug = 'imperial') r
on conflict (id) do nothing;

-- 3) Liga cada pedido antigo ao cliente pelo telefone ---------------------------------
update public.pedidos_legado pl
   set cliente_id = c.id
  from public.clientes c
 where pl.cliente_id is null
   and pl.telefone is not null
   and c.restaurante_id = pl.restaurante_id
   and c.telefone = pl.telefone;

commit;

-- 4) Conferência (só números; compare as duas colunas) --------------------------------
select * from (
  select 1 as ordem, 'Clientes' as item,
         (select count(*) from public.customers)::numeric as antigo,
         (select count(*) from public.clientes where origem = 'app_antigo')::numeric as novo
  union all
  select 2, 'Selos de fidelidade (soma)',
         (select coalesce(sum(greatest(coalesce(loyalty_stamps,0),0)),0) from public.customers),
         (select coalesce(sum(selos_fidelidade),0) from public.clientes where origem = 'app_antigo')
  union all
  select 3, 'Pedidos',
         (select count(*) from public.orders),
         (select count(*) from public.pedidos_legado)
  union all
  select 4, 'Pedidos: soma do total (R$)',
         (select coalesce(sum(total),0) from public.orders),
         (select coalesce(sum(total),0) from public.pedidos_legado)
  union all
  select 5, 'Clientes sem telefone utilizável (só informativo)',
         (select count(*) from public.customers where public.telefone_normalizado(phone) is null),
         (select count(*) from public.clientes where origem = 'app_antigo' and telefone is null)
  union all
  select 6, 'Pedidos ligados a um cliente (só informativo)',
         (select count(*) from public.orders),
         (select count(*) from public.pedidos_legado where cliente_id is not null)
) t
order by ordem;
