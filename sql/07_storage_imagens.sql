-- =============================================================================
-- sql/07_storage_imagens.sql
--
-- Cria o "armário" de imagens dos restaurantes no Supabase Storage:
--   bucket: imagens-restaurantes   (público para LEITURA, como um site)
--
-- Regra de pastas (o painel vai seguir isto ao enviar arquivos):
--   <id-do-restaurante>/logo-<algo>.webp
--   <id-do-restaurante>/banner-<algo>.webp
--   <id-do-restaurante>/produtos/<id-do-produto>-<algo>.webp
--
-- Quem pode o quê:
--   * Qualquer pessoa vê a imagem pelo endereço público (precisa, é o cardápio).
--   * Só o dono do restaurante envia, troca ou apaga arquivos, e SÓ dentro da
--     pasta do próprio restaurante (a primeira pasta tem de ser o id dele).
--   * O cliente anônimo não consegue listar nem enviar nada.
--   * O bucket recusa arquivo maior que 2 MB e tipo que não seja JPG, PNG ou
--     WEBP (SVG fica de fora de propósito: pode carregar código).
--
-- ADITIVO e idempotente: pode rodar de novo. Não mexe em tabelas do sistema.
-- Rode DEPOIS do 06_identidade_visual.sql.
-- =============================================================================

begin;

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Supabase Storage não encontrado neste projeto. Nada foi alterado.';
  end if;
  if to_regprocedure('public.meus_restaurantes()') is null then
    raise exception 'Função public.meus_restaurantes() não encontrada. Nada foi alterado.';
  end if;
end
$$;

-- 1) Bucket ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imagens-restaurantes',
  'imagens-restaurantes',
  true,
  2097152,                                           -- 2 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = true,
      file_size_limit    = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- 2) Políticas: só o dono mexe, só na pasta do próprio restaurante -----------------
-- (storage.foldername(name))[1] = primeira pasta do caminho = id do restaurante

drop policy if exists imagens_rest_dono_le on storage.objects;
create policy imagens_rest_dono_le on storage.objects
  for select to authenticated
  using (
    bucket_id = 'imagens-restaurantes'
    and (storage.foldername(name))[1] in (select public.meus_restaurantes()::text)
  );

drop policy if exists imagens_rest_dono_envia on storage.objects;
create policy imagens_rest_dono_envia on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'imagens-restaurantes'
    and (storage.foldername(name))[1] in (select public.meus_restaurantes()::text)
  );

drop policy if exists imagens_rest_dono_troca on storage.objects;
create policy imagens_rest_dono_troca on storage.objects
  for update to authenticated
  using (
    bucket_id = 'imagens-restaurantes'
    and (storage.foldername(name))[1] in (select public.meus_restaurantes()::text)
  )
  with check (
    bucket_id = 'imagens-restaurantes'
    and (storage.foldername(name))[1] in (select public.meus_restaurantes()::text)
  );

drop policy if exists imagens_rest_dono_apaga on storage.objects;
create policy imagens_rest_dono_apaga on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'imagens-restaurantes'
    and (storage.foldername(name))[1] in (select public.meus_restaurantes()::text)
  );

commit;

-- 3) Conferência -----------------------------------------------------------------
-- Deve mostrar: bucket público = true, limite 2097152 e os 3 tipos permitidos
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'imagens-restaurantes';

-- Deve listar 4 políticas (le, envia, troca, apaga)
select policyname, cmd, roles
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'imagens_rest_%'
order by policyname;
