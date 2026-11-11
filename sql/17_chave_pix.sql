alter table restaurantes add column if not exists chave_pix text;

alter table restaurantes drop constraint if exists restaurantes_chave_pix_tamanho;
alter table restaurantes add constraint restaurantes_chave_pix_tamanho
  check (chave_pix is null or char_length(chave_pix) <= 100);
