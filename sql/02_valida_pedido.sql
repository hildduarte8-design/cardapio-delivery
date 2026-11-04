-- =====================================================
-- VALIDAÇÃO DE PEDIDO NO BANCO (preço e taxa de entrega)
-- Pode rodar mais de uma vez. Só mexe em uma função e um trigger de "pedidos".
-- O cliente continua enviando o pedido pelo cardápio; o banco confere se
-- preços, quantidades e taxa batem com produtos e bairros do restaurante.
-- Se não baterem, o pedido é recusado e nada é gravado.
-- =====================================================

create or replace function public.validar_pedido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_itens    jsonb;
  v_item     jsonb;
  v_qtd      int;
  v_preco    numeric;
  v_subtotal numeric := 0;
  v_taxa     numeric;
begin
  -- pedidos do backend (service_role: bot de WhatsApp, frete por GPS) calculam os próprios valores
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return NEW;
  end if;

  -- itens precisa ser uma lista de 1 a 50 linhas
  begin
    v_itens := NEW.itens::text::jsonb;
  exception when others then
    raise exception 'PEDIDO_INVALIDO: itens ilegíveis';
  end;

  if jsonb_typeof(v_itens) <> 'array'
     or jsonb_array_length(v_itens) not between 1 and 50 then
    raise exception 'PEDIDO_INVALIDO: lista de itens inválida';
  end if;

  for v_item in select * from jsonb_array_elements(v_itens) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item->>'qtd', '')   !~ '^[0-9]{1,2}$'
       or coalesce(v_item->>'preco', '') !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception 'PEDIDO_INVALIDO: item malformado';
    end if;

    v_qtd := (v_item->>'qtd')::int;
    if v_qtd < 1 then
      raise exception 'PEDIDO_INVALIDO: quantidade inválida';
    end if;

    -- preço real vem do banco, só de produto ativo do MESMO restaurante
    select p.preco into v_preco
    from produtos p
    where p.id::text = v_item->>'id'
      and p.restaurante_id = NEW.restaurante_id
      and p.disponivel;

    if not found then
      raise exception 'PRODUTO_INDISPONIVEL';
    end if;

    if abs(v_preco - (v_item->>'preco')::numeric) >= 0.005 then
      raise exception 'PRECO_DESATUALIZADO';
    end if;

    v_subtotal := v_subtotal + v_preco * v_qtd;
  end loop;

  -- taxa real vem do bairro ativo do mesmo restaurante
  select b.taxa into v_taxa
  from bairros b
  where b.restaurante_id = NEW.restaurante_id
    and b.nome = NEW.bairro
    and b.ativo;

  if not found then
    raise exception 'BAIRRO_INVALIDO';
  end if;

  if abs(NEW.subtotal - v_subtotal) >= 0.01
     or abs(NEW.taxa_entrega - v_taxa) >= 0.01
     or abs(NEW.total - (v_subtotal + v_taxa)) >= 0.01 then
    raise exception 'PRECO_DESATUALIZADO';
  end if;

  return NEW;
end;
$$;

revoke all on function public.validar_pedido() from public, anon, authenticated;

drop trigger if exists trg_validar_pedido on pedidos;
create trigger trg_validar_pedido
  before insert on pedidos
  for each row execute function public.validar_pedido();


-- Remove o trigger de recálculo silencioso (trigger-pedidos.sql), que mascara o PRECO_DESATUALIZADO:
drop trigger if exists pedidos_recalcular_trg on pedidos;
drop function if exists public.pedidos_recalcular();

-- O cardápio já envia restaurante_id; remove o padrão de transição (pedido sem restaurante deixa de cair no Imperial):
alter table pedidos alter column restaurante_id drop default;
