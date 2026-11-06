-- =============================================================================
-- sql/06_identidade_visual.sql
--
-- Prepara o banco para a identidade visual de cada restaurante:
--   restaurantes: logo_url, banner_url, cor_primaria, cor_secundaria
--   produtos:     imagem_url
--
-- ADITIVO: só adiciona colunas e travas. Não altera nem apaga nada existente.
-- Pode ser rodado mais de uma vez (idempotente). Tudo em uma transação.
--
-- Segurança: cor e endereço de imagem acabam dentro do CSS/HTML dos clientes.
-- Por isso o banco só aceita:
--   * cor no formato #RRGGBB
--   * endereço de imagem começando com https://, sem espaço, aspas,
--     parênteses, < > ou barra invertida (impede injeção no CSS e no HTML)
--
-- As permissões continuam as de hoje: o cliente anônimo só lê (restaurante
-- ativo / produto disponível); só o dono do restaurante altera.
-- =============================================================================

begin;

-- Pré-condições -----------------------------------------------------------------
do $$
begin
  if to_regclass('public.restaurantes') is null or to_regclass('public.produtos') is null then
    raise exception 'Tabelas public.restaurantes/public.produtos não encontradas. Nada foi alterado.';
  end if;
end
$$;

-- 1) Colunas novas ----------------------------------------------------------------
alter table public.restaurantes add column if not exists logo_url       text;
alter table public.restaurantes add column if not exists banner_url     text;
alter table public.restaurantes add column if not exists cor_primaria   varchar(7) default '#C2410C';
alter table public.restaurantes add column if not exists cor_secundaria varchar(7) default '#FBF7F0';

alter table public.produtos     add column if not exists imagem_url     text;

-- 2) Travas de formato (criadas só se ainda não existirem) ------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'restaurantes_cor_primaria_ck') then
    alter table public.restaurantes add constraint restaurantes_cor_primaria_ck
      check (cor_primaria is null or cor_primaria ~ '^#[0-9A-Fa-f]{6}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'restaurantes_cor_secundaria_ck') then
    alter table public.restaurantes add constraint restaurantes_cor_secundaria_ck
      check (cor_secundaria is null or cor_secundaria ~ '^#[0-9A-Fa-f]{6}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'restaurantes_logo_url_ck') then
    alter table public.restaurantes add constraint restaurantes_logo_url_ck
      check (logo_url is null or (length(logo_url) <= 500 and logo_url ~ '^https://[^[:space:]"''()<>\\]+$'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'restaurantes_banner_url_ck') then
    alter table public.restaurantes add constraint restaurantes_banner_url_ck
      check (banner_url is null or (length(banner_url) <= 500 and banner_url ~ '^https://[^[:space:]"''()<>\\]+$'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'produtos_imagem_url_ck') then
    alter table public.produtos add constraint produtos_imagem_url_ck
      check (imagem_url is null or (length(imagem_url) <= 500 and imagem_url ~ '^https://[^[:space:]"''()<>\\]+$'));
  end if;
end
$$;

comment on column public.restaurantes.cor_primaria   is 'Cor de destaque do cardápio (#RRGGBB). Padrão: #C2410C.';
comment on column public.restaurantes.cor_secundaria is 'Cor complementar do cardápio (#RRGGBB).';
comment on column public.restaurantes.logo_url       is 'Endereço https da logo (Supabase Storage).';
comment on column public.restaurantes.banner_url     is 'Endereço https do banner (Supabase Storage).';
comment on column public.produtos.imagem_url         is 'Endereço https da foto do produto (Supabase Storage).';

commit;

-- Faz a API do Supabase enxergar as colunas novas sem esperar
notify pgrst, 'reload schema';

-- 3) Conferência: deve listar 5 colunas e 5 travas ----------------------------------
select table_name as tabela, column_name as coluna, data_type as tipo, column_default as padrao
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'restaurantes' and column_name in ('logo_url','banner_url','cor_primaria','cor_secundaria'))
    or (table_name = 'produtos'     and column_name = 'imagem_url'))
order by table_name, column_name;

select conname as trava
from pg_constraint
where conname in ('restaurantes_cor_primaria_ck','restaurantes_cor_secundaria_ck',
                  'restaurantes_logo_url_ck','restaurantes_banner_url_ck','produtos_imagem_url_ck')
order by conname;
