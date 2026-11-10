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
  v_local text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_completo text;
begin
  -- tira o 55 se vier junto, para comparar sempre o número com DDD
  if length(v_local) >= 12 and left(v_local, 2) = '55' then
    v_local := substr(v_local, 3);
  end if;
  v_completo := '55' || v_local;

  select id into v_id
  from clientes
  where restaurante_id = p_restaurante_id
    and (
      regexp_replace(coalesce(telefone_original, ''), '\D', '', 'g') = v_local
      or regexp_replace(coalesce(telefone, ''), '\D', '', 'g') in (v_local, v_completo)
    )
  limit 1;

  if v_id is null then
    insert into clientes (
      restaurante_id, nome, telefone, telefone_original,
      endereco, selos_fidelidade, ultimo_pedido_em, origem
    ) values (
      p_restaurante_id, p_nome, v_completo, v_local,
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

revoke all on function public.registrar_pedido_cliente(uuid, text, text, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.registrar_pedido_cliente(uuid, text, text, text, numeric, boolean) to service_role;
