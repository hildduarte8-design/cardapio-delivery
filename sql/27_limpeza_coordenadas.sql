-- 27_limpeza_coordenadas.sql
-- LGPD: apaga cliente_lat/cliente_lon de pedidos com mais de 30 dias.
-- O pedido, o valor e o bairro continuam intactos.

begin;

create or replace function public.limpar_coordenadas_antigas(p_dias integer default 30)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  if p_dias is null or p_dias < 1 then
    raise exception 'p_dias deve ser 1 ou mais';
  end if;

  update public.pedidos
     set cliente_lat = null,
         cliente_lon = null
   where created_at < now() - make_interval(days => p_dias)
     and (cliente_lat is not null or cliente_lon is not null);

  get diagnostics n = row_count;
  return n;
end
$$;

-- Só o banco/backend pode chamar; visitante e usuário logado não.
revoke all on function public.limpar_coordenadas_antigas(integer) from public, anon, authenticated;

-- Limpeza inicial + trava: se sobrar coordenada antiga, desfaz tudo.
do $$
declare restantes integer;
begin
  perform public.limpar_coordenadas_antigas(30);

  select count(*) into restantes
  from public.pedidos
  where created_at < now() - interval '30 days'
    and (cliente_lat is not null or cliente_lon is not null);

  if restantes <> 0 then
    raise exception 'Ainda restam % pedidos antigos com coordenadas. Desfeito.', restantes;
  end if;
end $$;

commit;

-- Conferência: antigas_restantes deve ser 0.
select
  count(*) filter (where cliente_lat is not null) as com_coordenadas,
  count(*) filter (where cliente_lat is not null
                   and created_at < now() - interval '30 days') as antigas_restantes
from public.pedidos;
