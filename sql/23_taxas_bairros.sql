-- 23_taxas_bairros.sql
-- Taxas por bairro da loja imperial, calculadas por distância (R$ 4,00 + R$ 1,00/km, de R$ 0,50 em R$ 0,50).
-- Origem: bairros-frete.csv (pinos conferidos). Felicidade e Cidade Nova ficam de fora (pino a refazer).
-- Se algum nome não bater, o bloco inteiro é desfeito (nada é alterado).
-- Rode no Supabase > SQL Editor.

do $$
declare
  qtd integer;
begin
  with novos(nome, taxa) as (
    values
      ('Altino Barbosa', 9.50),
      ('Bela Vista', 11.00),
      ('Castro Pires', 9.00),
      ('Centro', 8.50),
      ('Cidade Alta', 9.00),
      ('Concórdia', 10.50),
      ('Dr Laerte Laender', 7.00),
      ('Fátima', 9.50),
      ('Fazenda Arnô', 12.50),
      ('Filadélfia', 6.50),
      ('Frei Dimas', 10.00),
      ('Frimusa', 10.50),
      ('Gangorrinha', 10.50),
      ('Grão Pará', 9.50),
      ('Ipiranga', 8.50),
      ('Jardim Iracema', 10.00),
      ('Jardim São Paulo', 5.50),
      ('Joaquim Pedrosa', 11.00),
      ('Lourival Soares da Costa', 7.50),
      ('Manoel Pimenta', 7.50),
      ('Marajoara', 7.50),
      ('Matinha', 12.00),
      ('Novo Horizonte', 10.00),
      ('Palmeiras', 10.00),
      ('Pampulhinha', 12.00),
      ('São Cristóvão', 12.00),
      ('São Diogo', 9.00),
      ('São Francisco', 9.50),
      ('São Jacinto', 10.50),
      ('Solidariedade', 6.50),
      ('Sta Clara', 9.00),
      ('Tabajaras', 10.00),
      ('Taquara', 7.00),
      ('Teófilo Rocha', 7.00),
      ('Viriato', 12.00)
  ),
  atualizados as (
    update public.bairros b
       set taxa = nv.taxa
      from novos nv
     where b.restaurante_id = 'b6175a0c-cdc3-42b8-a8e8-d4f304da8fd8'
       and b.nome = nv.nome
    returning b.nome
  )
  select count(*) into qtd from atualizados;

  if qtd <> 35 then
    raise exception 'Esperava atualizar 35 bairros, mas atualizou %. Nada foi alterado.', qtd;
  end if;
end $$;

-- Conferência (rode depois). Esperado: Jardim São Paulo 5.50, Centro 8.50, Matinha 12.00,
-- Felicidade 8.00 (não mexida), Vila Barreiros 4.00 (não mexida).
select nome, taxa
  from public.bairros
 where restaurante_id = 'b6175a0c-cdc3-42b8-a8e8-d4f304da8fd8'
   and nome in ('Jardim São Paulo', 'Centro', 'Matinha', 'Felicidade', 'Vila Barreiros')
 order by nome;
