-- =============================================================================
-- sql/02_valida_pedido.sql  (versão corrigida)
--
-- Valida pedidos feitos pelo cardápio (anon) ou pelo painel (authenticated) e
-- RECUSA o pedido se preço, subtotal, taxa ou total não baterem com o cadastro.
-- Não corrige em silêncio: o cliente vê o erro e o cardápio recarrega os preços.
--
-- Códigos de erro (aparecem em error.message no frontend):
--   ITENS_INVALIDOS        lista de itens vazia, malformada ou grande demais
--   PRODUTO_INVALIDO       produto não existe neste restaurante
--   PRODUTO_INDISPONIVEL   produto existe mas está indisponível
--   PRECO_DESATUALIZADO    preço do item diferente do preço cadastrado
--   SUBTOTAL_INVALIDO      subtotal diferente da soma (preço cadastrado x qtd)
--   BAIRRO_INVALIDO        bairro (ou apelido) não cadastrado neste restaurante
--   TAXA_BAIRRO_NAO_CONFIGURADA   bairro sem taxa cadastrada
--   TAXA_DESATUALIZADA     taxa de entrega diferente da taxa do bairro
--   TOTAL_INVALIDO         total diferente de subtotal + taxa
--   RESTAURANTE_OBRIGATORIO  pedido sem restaurante_id
--
-- Quem passa direto, sem validação: o backend (service_role) e o SQL Editor do
-- Supabase (postgres). O backend calcula o frete por GPS por conta própria.
--
-- Este script:
--   * remove o trigger antigo duplicado pedidos_recalcular_trg (se existir);
--   * remove o DEFAULT de pedidos.restaurante_id (pedido sem restaurante passa
--     a ser recusado em vez de cair num restaurante "padrão");
--   * cria a função e o trigger oficial pedidos_valida_trg.
-- Pode ser rodado mais de uma vez. Não apaga dados. Tudo em uma transação.
-- =============================================================================

begin;

-- Pré-condição: as tabelas precisam existir
do $$
begin
  if to_regclass('public.pedidos') is null
     or to_regclass('public.produtos') is null
     or to_regclass('public.bairros') is null
     or to_regclass('public.bairros_sinonimos') is null then
    raise exception 'Faltam tabelas (pedidos, produtos, bairros ou bairros_sinonimos). Nada foi alterado.';
  end if;
end
$$;

-- 1) Limpeza: trigger duplicado antigo e versão anterior deste trigger ---------
drop trigger if exists pedidos_recalcular_trg on public.pedidos;
drop trigger if exists pedidos_valida_trg     on public.pedidos;

-- 2) Pedido sem restaurante deve falhar, não cair num restaurante padrão --------
alter table public.pedidos alter column restaurante_id drop default;

-- 3) Função de validação --------------------------------------------------------
-- SECURITY DEFINER: lê produtos/bairros/apelidos mesmo que o RLS não deixe o
-- cliente anônimo ler alguma dessas tabelas. O papel de quem chamou é lido de
-- current_setting('role'), que o PostgREST define como anon/authenticated/service_role.
create or replace function public.pedidos_valida()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item      jsonb;
  v_id_txt    text;
  v_qtd       numeric;
  v_prod      record;
  v_sub       numeric := 0;
  v_busca     text;
  v_taxa      numeric;
  v_achou     boolean := false;
begin
  -- Backend (service_role) e SQL Editor (postgres) passam direto
  if coalesce(current_setting('role', true), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  if new.restaurante_id is null then
    raise exception 'RESTAURANTE_OBRIGATORIO';
  end if;

  -- Itens: lista não vazia de objetos {id, qtd, preco, ...}
  if new.itens is null
     or jsonb_typeof(new.itens) <> 'array'
     or jsonb_array_length(new.itens) = 0
     or jsonb_array_length(new.itens) > 50 then
    raise exception 'ITENS_INVALIDOS' using detail = 'itens deve ser uma lista de 1 a 50 linhas';
  end if;

  for v_item in select value from jsonb_array_elements(new.itens) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or jsonb_typeof(v_item -> 'qtd') <> 'number'
       or jsonb_typeof(v_item -> 'preco') <> 'number' then
      raise exception 'ITENS_INVALIDOS' using detail = 'cada item precisa de id, qtd e preco';
    end if;

    v_id_txt := v_item ->> 'id';
    if v_id_txt !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'ITENS_INVALIDOS' using detail = 'id de produto inválido';
    end if;

    v_qtd := (v_item ->> 'qtd')::numeric;
    if v_qtd <> trunc(v_qtd) or v_qtd < 1 or v_qtd > 200 then
      raise exception 'ITENS_INVALIDOS' using detail = 'qtd deve ser inteiro de 1 a 200';
    end if;

    select p.preco, p.disponivel
      into v_prod
      from public.produtos p
     where p.id = v_id_txt::uuid
       and p.restaurante_id = new.restaurante_id;

    if not found then
      raise exception 'PRODUTO_INVALIDO' using detail = v_id_txt;
    end if;
    if v_prod.disponivel is distinct from true then
      raise exception 'PRODUTO_INDISPONIVEL' using detail = v_id_txt;
    end if;
    if abs((v_item ->> 'preco')::numeric - v_prod.preco) > 0.005 then
      raise exception 'PRECO_DESATUALIZADO' using detail = v_id_txt;
    end if;

    v_sub := v_sub + v_prod.preco * v_qtd;
  end loop;

  if new.subtotal is null or abs(new.subtotal - v_sub) > 0.005 then
    raise exception 'SUBTOTAL_INVALIDO' using detail = format('esperado %s', v_sub);
  end if;

  -- Taxa: bairro oficial (nome exato) e, se não achar, apelido (sinônimo) exato
  v_busca := lower(btrim(coalesce(new.bairro, '')));

  select b.taxa into v_taxa
    from public.bairros b
   where b.restaurante_id = new.restaurante_id
     and b.ativo is not false
     and lower(btrim(b.nome)) = v_busca
   limit 1;
  v_achou := found;

  if not v_achou then
    select b.taxa into v_taxa
      from public.bairros_sinonimos s
      join public.bairros b on b.id = s.bairro_id
     where s.restaurante_id = new.restaurante_id
       and b.restaurante_id = new.restaurante_id
       and b.ativo is not false
       and lower(btrim(s.nome_popular)) = v_busca
     limit 1;
    v_achou := found;
  end if;

  if not v_achou or v_busca = '' then
    raise exception 'BAIRRO_INVALIDO';
  end if;
  if v_taxa is null then
    raise exception 'TAXA_BAIRRO_NAO_CONFIGURADA';
  end if;
  if new.taxa_entrega is null or abs(new.taxa_entrega - v_taxa) > 0.005 then
    raise exception 'TAXA_DESATUALIZADA' using detail = format('esperado %s', v_taxa);
  end if;

  if new.total is null or abs(new.total - (new.subtotal + new.taxa_entrega)) > 0.005 then
    raise exception 'TOTAL_INVALIDO';
  end if;

  return new;
end
$$;

-- Função de trigger não deve ser chamável por clientes
revoke all on function public.pedidos_valida() from public, anon, authenticated;

-- 4) Trigger oficial (só na criação; o painel do dono continua atualizando status)
create trigger pedidos_valida_trg
  before insert on public.pedidos
  for each row execute function public.pedidos_valida();

commit;

-- 5) Conferência: deve listar exatamente estes dois triggers em pedidos --------
select t.tgname as trigger_ativo
from pg_trigger t
where t.tgrelid = 'public.pedidos'::regclass
  and not t.tgisinternal
order by t.tgname;
-- Esperado: pedidos_protege_frete_meta_trg  e  pedidos_valida_trg
