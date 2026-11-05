-- =============================================================================
-- sql/02b_testa_validacao.sql
--
-- Testa o 02_valida_pedido.sql fingindo ser um cliente do cardápio (papel anon).
-- NÃO GRAVA NADA: no final o script termina de propósito com um "erro" que traz
-- o relatório, e esse erro desfaz tudo o que o teste fez.
--
-- Como usar: cole tudo no SQL Editor do Supabase e clique em Run.
-- O relatório aparece na mensagem de erro, com uma linha por teste:
--   OK   = o resultado foi o esperado
--   FALHA = o resultado foi diferente do esperado (me mande o relatório)
--
-- Usa o restaurante 'imperial', o primeiro produto disponível e o primeiro
-- bairro ativo com taxa cadastrada.
-- =============================================================================

do $$
declare
  r_id uuid;
  p_id uuid;
  p_preco numeric;
  b_nome text;
  b_taxa numeric;
  c record;
  resultado text;
  relatorio text := '';
begin
  select id into r_id from public.restaurantes where slug = 'imperial';
  select id, preco into p_id, p_preco
    from public.produtos where restaurante_id = r_id and disponivel limit 1;
  select nome, taxa into b_nome, b_taxa
    from public.bairros
   where restaurante_id = r_id and ativo is not false and taxa is not null limit 1;

  if r_id is null or p_id is null or b_nome is null then
    raise exception 'Teste impossível: faltam restaurante imperial, produto disponível ou bairro com taxa.';
  end if;

  -- passa a agir como cliente anônimo (vale só até o fim desta transação)
  set local role anon;

  for c in
    select * from (values
      ('1 pedido correto',
        jsonb_build_array(jsonb_build_object('id', p_id, 'qtd', 2, 'nome', 'x', 'preco', p_preco)),
        p_preco * 2, b_nome, b_taxa, 'ACEITO'),
      ('2 preco do item adulterado',
        jsonb_build_array(jsonb_build_object('id', p_id, 'qtd', 2, 'nome', 'x', 'preco', 0.01)),
        0.02, b_nome, b_taxa, 'PRECO_DESATUALIZADO'),
      ('3 subtotal adulterado',
        jsonb_build_array(jsonb_build_object('id', p_id, 'qtd', 2, 'nome', 'x', 'preco', p_preco)),
        0.50, b_nome, b_taxa, 'SUBTOTAL_INVALIDO'),
      ('4 taxa de entrega adulterada',
        jsonb_build_array(jsonb_build_object('id', p_id, 'qtd', 1, 'nome', 'x', 'preco', p_preco)),
        p_preco, b_nome, 0::numeric, 'TAXA_DESATUALIZADA'),
      ('5 produto inexistente',
        jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'qtd', 1, 'nome', 'x', 'preco', 5)),
        5, b_nome, b_taxa, 'PRODUTO_INVALIDO'),
      ('6 bairro inventado',
        jsonb_build_array(jsonb_build_object('id', p_id, 'qtd', 1, 'nome', 'x', 'preco', p_preco)),
        p_preco, 'Bairro Que Nao Existe', b_taxa, 'BAIRRO_INVALIDO'),
      ('7 quantidade negativa',
        jsonb_build_array(jsonb_build_object('id', p_id, 'qtd', -3, 'nome', 'x', 'preco', p_preco)),
        p_preco, b_nome, b_taxa, 'ITENS_INVALIDOS'),
      ('8 lista de itens vazia',
        '[]'::jsonb,
        1, b_nome, b_taxa, 'ITENS_INVALIDOS')
    ) as t(nome, itens, subtotal, bairro, taxa, esperado)
  loop
    begin
      insert into public.pedidos
        (restaurante_id, cliente_nome, cliente_phone, endereco_completo, bairro,
         itens, subtotal, taxa_entrega, total, forma_pagamento, status)
      values
        (r_id, 'Teste Validacao', '00000000000', 'Rua de teste, 123', c.bairro,
         c.itens, c.subtotal, c.taxa, c.subtotal + c.taxa, 'Pix', 'pendente_pagamento');
      resultado := 'ACEITO';
    exception when others then
      resultado := sqlerrm;
    end;

    relatorio := relatorio || format(E'\n%s | esperado=%s | obtido=%s | %s',
      c.nome, c.esperado, resultado,
      case when resultado = c.esperado then 'OK' else 'FALHA' end);
  end loop;

  reset role;
  raise exception E'RELATORIO DO TESTE (nada foi gravado):%', relatorio;
end
$$;
