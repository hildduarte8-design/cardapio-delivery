-- Cria/atualiza o cliente e soma selo quando chega pedido novo.
-- Chamada só pelo backend (service_role).
create or replace function public.registrar_pedido_cliente(
  p_restaurante_id uuid,
  p_nome text,
  p_telefone text,
  p_endereco text,
  p_total numeric,
  p_retirada boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id clientes.id%type;
  v_selo int := case when p_total >= 25 then 1 else 0 end;
begin
  select id into v_id
  from clientes
  where restaurante_id = p_restaurante_id
    and regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = p_telefone
  limit 1;

  if v_id is null then
    insert into clientes (
      restaurante_id, nome, telefone, telefone_original,
      endereco, selos_fidelidade, ultimo_pedido_em, origem
    ) values (
      p_restaurante_id, p_nome, p_telefone, p_telefone,
      case when p_retirada then null else p_endereco end,
      v_selo, now(), 'cardapio'
    );
  else
    update clientes
    set ultimo_pedido_em = now(),
        selos_fidelidade = coalesce(selos_fidelidade, 0) + v_selo,
        endereco = case when p_retirada then endereco else p_endereco end
    where id = v_id;
  end if;
end;
$$;

-- Segurança: ninguém de fora chama isso (senão qualquer um inflaria selos)
revoke all on function public.registrar_pedido_cliente(uuid, text, text, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.registrar_pedido_cliente(uuid, text, text, text, numeric, boolean) to service_role;
