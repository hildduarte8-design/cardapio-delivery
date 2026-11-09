-- ============================================================
-- sql/10_trava_pedido_manual.sql
-- Trava no banco os campos do pedido manual (sql/08).
--
-- O que faz:
--   1. Preenche os vazios e põe NOT NULL em origem, tipo_atendimento e desconto.
--   2. Cria a trava: desconto no máximo igual a itens + taxa de entrega.
--   3. Cria um gatilho que impede origem, tipo_atendimento, desconto e
--      desconto_motivo de serem gravados ou alterados por fora do backend:
--        - INSERT de anon/authenticated: os 4 campos voltam ao padrão
--          (cardapio, entrega, 0, sem motivo).
--        - UPDATE de anon/authenticated: os 4 campos ficam como estavam.
--
-- O backend usa service_role e o SQL Editor usa postgres: os dois passam direto.
-- O painel só altera "status", então nada do que ele faz é afetado.
--
-- Não apaga nem altera dados de pedidos existentes (só preenche vazios).
-- É seguro rodar mais de uma vez. Se qualquer passo falhar, nada é aplicado.
-- ============================================================

begin;

-- 1) Preenche vazios e exige valor -------------------------------------------

update public.pedidos set origem = 'cardapio'  where origem is null;
update public.pedidos set tipo_atendimento = 'entrega' where tipo_atendimento is null;
update public.pedidos set desconto = 0 where desconto is null;

alter table public.pedidos
  alter column origem set default 'cardapio',
  alter column origem set not null,
  alter column tipo_atendimento set default 'entrega',
  alter column tipo_atendimento set not null,
  alter column desconto set default 0,
  alter column desconto set not null;

-- 2) Desconto nunca maior que itens + taxa -----------------------------------
-- Se algum pedido antigo violar isso, este comando falha e o script inteiro
-- é desfeito (nada fica pela metade).

alter table public.pedidos
  drop constraint if exists pedidos_desconto_limite_chk;

alter table public.pedidos
  add constraint pedidos_desconto_limite_chk
  check (desconto <= coalesce(subtotal, 0) + coalesce(taxa_entrega, 0));

-- 3) Gatilho: só o backend define origem, tipo e desconto --------------------
-- Função SEM "security definer", para enxergar o papel de quem chamou.

create or replace function public.pedidos_protege_manual()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('role', true), '') in ('anon', 'authenticated')
     or current_user in ('anon', 'authenticated') then

    if tg_op = 'INSERT' then
      new.origem          := 'cardapio';
      new.tipo_atendimento := 'entrega';
      new.desconto        := 0;
      new.desconto_motivo := null;
    else
      new.origem          := old.origem;
      new.tipo_atendimento := old.tipo_atendimento;
      new.desconto        := old.desconto;
      new.desconto_motivo := old.desconto_motivo;
    end if;
  end if;

  return new;
end
$$;

revoke all on function public.pedidos_protege_manual() from public, anon, authenticated;

drop trigger if exists pedidos_protege_manual_trg on public.pedidos;

create trigger pedidos_protege_manual_trg
  before insert or update on public.pedidos
  for each row execute function public.pedidos_protege_manual();

commit;

-- ============================================================
-- 4) CONFERÊNCIA (somente leitura)
-- Esperado: as 3 colunas com is_nullable = NO, a trava e o gatilho listados.
-- ============================================================

select 'coluna' as tipo, column_name as nome, is_nullable as detalhe
  from information_schema.columns
 where table_schema = 'public' and table_name = 'pedidos'
   and column_name in ('origem', 'tipo_atendimento', 'desconto')
union all
select 'trava', conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'public.pedidos'::regclass
   and conname = 'pedidos_desconto_limite_chk'
union all
select 'gatilho', tgname, pg_get_triggerdef(oid)
  from pg_trigger
 where tgrelid = 'public.pedidos'::regclass
   and tgname = 'pedidos_protege_manual_trg'
order by 1, 2;

-- ============================================================
-- ROLLBACK (só se precisar; mantido comentado de propósito):
--   begin;
--   drop trigger  if exists pedidos_protege_manual_trg on public.pedidos;
--   drop function if exists public.pedidos_protege_manual();
--   alter table public.pedidos drop constraint if exists pedidos_desconto_limite_chk;
--   alter table public.pedidos
--     alter column origem drop not null,
--     alter column tipo_atendimento drop not null,
--     alter column desconto drop not null;
--   commit;
-- ============================================================
