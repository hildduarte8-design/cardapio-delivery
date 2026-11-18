-- 29_ruas_limpeza.sql
-- Limpa public.cidade_ruas (criada pelo 28): remove zona rural e tipos que não são endereço
-- de entrega, e liga RLS. Rodar SOMENTE depois do 28.
-- Trava: se qualquer conferência falhar, nada é aplicado (rollback automático).

begin;

-- TRAVA 1: a tabela deve ter exatamente as 2.734 linhas do arquivo 28
do $$
declare v_total int;
begin
  select count(*) into v_total from public.cidade_ruas;
  if v_total <> 2734 then
    raise exception 'TRAVA: esperava 2734 linhas em cidade_ruas, achei %. Nada foi alterado.', v_total;
  end if;
end $$;

-- RLS ligado, sem policy: só o backend (service_role) lê/escreve
alter table public.cidade_ruas enable row level security;
revoke all on public.cidade_ruas from anon, authenticated;

-- Limpeza
delete from public.cidade_ruas
where distrito_sede = false
   or split_part(logradouro_normalizado, ' ', 1) in (
     'CORREGO','FAZENDA','SITIO','RIO','COMUNIDADE','VILAREJO','DISTRITO',
     'CABECEIRA','RIBEIRAO','RANCHO','POVOADO','COLONIA','SERRA','GRANJA',
     'CACHOEIRA','ACAMPAMENTO','GROTA','MARGEM'
   );

-- TRAVA 2: ruas que precisam continuar existindo
do $$
begin
  if not exists (select 1 from public.cidade_ruas
                 where logradouro_normalizado = 'AVENIDA GETULIO VARGAS' and bairro_normalizado = 'CENTRO') then
    raise exception 'TRAVA: Avenida Getulio Vargas (Centro) sumiu. Rollback.';
  end if;
  if not exists (select 1 from public.cidade_ruas
                 where logradouro_normalizado = 'RUA MARTINS SCOFIELD' and bairro_normalizado = 'BARREIROS') then
    raise exception 'TRAVA: Rua Martins Scofield (Barreiros) sumiu. Rollback.';
  end if;
  if not exists (select 1 from public.cidade_ruas
                 where logradouro_normalizado = 'RUA MARTINS SCOFIELD' and bairro_normalizado = 'VILA BARREIROS') then
    raise exception 'TRAVA: Rua Martins Scofield (Vila Barreiros) sumiu. Rollback.';
  end if;
  if (select count(*) from public.cidade_ruas where bairro_normalizado = 'BELA VISTA') < 50 then
    raise exception 'TRAVA: Bela Vista ficou com menos de 50 ruas. Rollback.';
  end if;
  if exists (select 1 from public.cidade_ruas where distrito_sede = false) then
    raise exception 'TRAVA: sobrou linha de distrito rural. Rollback.';
  end if;
end $$;

commit;

-- CONFERÊNCIA (resultado aparece na tela)
select count(*) as ruas_restantes,
       count(distinct bairro_normalizado) as bairros,
       (select relrowsecurity from pg_class where oid = 'public.cidade_ruas'::regclass) as rls_ligado
from public.cidade_ruas;

select split_part(logradouro_normalizado, ' ', 1) as tipo, count(*) as qtd
from public.cidade_ruas
group by 1 order by 2 desc;
