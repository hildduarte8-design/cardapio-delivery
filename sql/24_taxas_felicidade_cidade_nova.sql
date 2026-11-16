-- 24_taxas_felicidade_cidade_nova.sql
-- Segunda leva das taxas por bairro da loja imperial (R$ 4,00 + R$ 1,00/km, de R$ 0,50 em R$ 0,50).
-- Já rodado e conferido no Supabase em 15/11/2026. Fica aqui só como registro.
--   Felicidade: 8 km pelo Google Maps -> R$ 12,00 (o pino automático tinha caído em Viriato)
--   Cidade Nova: 140 m da loja -> R$ 4,50

update public.bairros
   set taxa = 12.00
 where restaurante_id = 'b6175a0c-cdc3-42b8-a8e8-d4f304da8fd8'
   and nome = 'Felicidade'
returning nome, taxa;

update public.bairros
   set taxa = 4.50
 where restaurante_id = 'b6175a0c-cdc3-42b8-a8e8-d4f304da8fd8'
   and nome = 'Cidade Nova'
returning nome, taxa;
