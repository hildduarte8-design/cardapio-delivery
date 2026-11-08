
-- ============================================================
-- sql/09_custos_despesas.sql
-- Módulo Custos e Resultado
--
-- Permite:
-- 1. Lançar compras individuais por categoria e mês.
-- 2. Registrar um total consolidado por categoria e mês.
-- 3. Impedir mistura dos dois formatos na mesma competência.
-- 4. Isolar os dados por restaurante usando RLS.
--
-- Não altera pedidos, produtos ou dados antigos.
-- ============================================================

begin;

-- 1. Períodos de custos
-- Um registro por restaurante, categoria e mês.
-- Define se a categoria será controlada por compras
-- individuais ou por um total mensal consolidado.

create table if not exists public.custos_periodos (
  id uuid primary key default gen_random_uuid(),

  restaurante_id uuid not null
    references public.restaurantes(id) on delete restrict,

  categoria text not null
    check (categoria in (
      'insumos',
      'embalagens',
      'energia',
      'gas',
      'agua',
      'funcionarios',
      'aluguel',
      'taxas',
      'marketing',
      'outros'
    )),

  competencia date not null
    check (competencia = date_trunc('month', competencia)::date),

  modo text not null
    check (modo in ('individual', 'consolidado')),

  -- Utilizado somente no modo consolidado
  valor_consolidado numeric(12,2),
  descricao_consolidada text,
  observacao_consolidada text,

  created_at timestamptz not null default now(),

  constraint custos_periodos_restaurante_categoria_mes_key
    unique (restaurante_id, categoria, competencia),

  constraint custos_periodos_id_restaurante_key
    unique (id, restaurante_id),

  constraint custos_periodos_modo_valor_chk
    check (
      (
        modo = 'individual'
        and valor_consolidado is null
        and descricao_consolidada is null
        and observacao_consolidada is null
      )
      or
      (
        modo = 'consolidado'
        and valor_consolidado is not null
        and valor_consolidado > 0
        and descricao_consolidada is not null
        and char_length(trim(descricao_consolidada)) between 1 and 100
      )
    ),

  constraint custos_periodos_descricao_chk
    check (
      descricao_consolidada is null
      or descricao_consolidada = trim(descricao_consolidada)
    )
);

-- 2. Lançamentos individuais
-- Só podem existir quando o período estiver no modo individual.

create table if not exists public.custos_lancamentos (
  id uuid primary key default gen_random_uuid(),

  periodo_id uuid not null,
  restaurante_id uuid not null,

  descricao text not null
    check (
      char_length(trim(descricao)) between 1 and 100
      and descricao = trim(descricao)
    ),

  valor numeric(12,2) not null
    check (valor > 0),

  data_despesa date not null,

  observacao text,

  created_at timestamptz not null default now(),

  constraint custos_lancamentos_periodo_restaurante_fkey
    foreign key (periodo_id, restaurante_id)
    references public.custos_periodos(id, restaurante_id)
    on delete cascade
);

-- 3. Índices para consultas por restaurante e competência

create index if not exists custos_periodos_restaurante_mes_idx
  on public.custos_periodos (restaurante_id, competencia desc);

create index if not exists custos_lancamentos_periodo_data_idx
  on public.custos_lancamentos (periodo_id, data_despesa desc);

create index if not exists custos_lancamentos_restaurante_idx
  on public.custos_lancamentos (restaurante_id);

-- 4. Proteção: lançamento individual exige período individual
-- e a data da despesa precisa pertencer à competência escolhida.

create or replace function public.validar_custo_lancamento()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_modo text;
  v_competencia date;
begin
  select modo, competencia
    into v_modo, v_competencia
    from public.custos_periodos
   where id = new.periodo_id
     and restaurante_id = new.restaurante_id;

  if not found then
    raise exception 'Período de custos não encontrado.';
  end if;

  if v_modo <> 'individual' then
    raise exception 'Este período utiliza total consolidado. Não é permitido inserir compras individuais.';
  end if;

  if date_trunc('month', new.data_despesa)::date <> v_competencia then
    raise exception 'A data da despesa precisa pertencer ao mês selecionado.';
  end if;

  return new;
end;
$$;

drop trigger if exists custos_lancamento_valida_trg
  on public.custos_lancamentos;

create trigger custos_lancamento_valida_trg
before insert or update on public.custos_lancamentos
for each row
execute function public.validar_custo_lancamento();

-- 5. Proteção: não permitir mudar para consolidado
-- enquanto existirem lançamentos individuais.

create or replace function public.proteger_modo_custos()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.modo = 'consolidado'
     and old.modo <> 'consolidado'
     and exists (
       select 1
         from public.custos_lancamentos
        where periodo_id = old.id
     )
  then
    raise exception 'Exclua os lançamentos individuais antes de mudar para o modo consolidado.';
  end if;

  return new;
end;
$$;

drop trigger if exists custos_periodo_protege_modo_trg
  on public.custos_periodos;

create trigger custos_periodo_protege_modo_trg
before update of modo on public.custos_periodos
for each row
execute function public.proteger_modo_custos();

-- 6. Segurança por restaurante (RLS)

alter table public.custos_periodos enable row level security;
alter table public.custos_lancamentos enable row level security;

drop policy if exists custos_periodos_dono_tudo
  on public.custos_periodos;

create policy custos_periodos_dono_tudo
on public.custos_periodos
for all
to authenticated
using (
  restaurante_id in (select public.meus_restaurantes())
)
with check (
  restaurante_id in (select public.meus_restaurantes())
);

drop policy if exists custos_lancamentos_dono_tudo
  on public.custos_lancamentos;

create policy custos_lancamentos_dono_tudo
on public.custos_lancamentos
for all
to authenticated
using (
  restaurante_id in (select public.meus_restaurantes())
)
with check (
  restaurante_id in (select public.meus_restaurantes())
);

-- 7. Permissões: somente usuários autenticados.
-- Nenhum acesso anônimo ao módulo financeiro.

revoke all on public.custos_periodos from anon;
revoke all on public.custos_lancamentos from anon;

grant select, insert, update, delete
  on public.custos_periodos to authenticated;

grant select, insert, update, delete
  on public.custos_lancamentos to authenticated;

commit;

-- ============================================================
-- 8. CONFERÊNCIA
-- Depois de executar, esta consulta deve mostrar as duas tabelas.
-- ============================================================

select
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'custos_periodos',
    'custos_lancamentos'
  )
order by table_name, ordinal_position;
