-- 26_remove_policy_pedidos_cliente_cria.sql
-- Remove a policy de INSERT para visitantes (anon/authenticated) em pedidos.
-- Motivo: todos os pedidos (cardápio e manual) são criados pelo backend com a
-- service role, que ignora RLS. A policy (criada em schema_multi_tenant.sql)
-- só deixava uma porta aberta para quem tivesse a chave pública.
-- Executado e testado em 17/11/2026 (pedido com GPS, só bairro, retirada e manual).
-- Os triggers de pedidos (pedidos_valida etc.) continuam como segunda camada.

begin;

drop policy if exists "pedidos_cliente_cria" on public.pedidos;

do $$
declare n int;
begin
  select count(*) into n
  from pg_policies
  where schemaname = 'public' and tablename = 'pedidos' and cmd = 'INSERT';

  if n <> 0 then
    raise exception 'Ainda existe policy de INSERT em pedidos (%). Desfeito.', n;
  end if;
end $$;

commit;

-- Conferência: devem restar só pedidos_dono_atualiza e pedidos_dono_le.
select policyname, cmd, roles
from pg_policies
where tablename = 'pedidos'
order by policyname;
