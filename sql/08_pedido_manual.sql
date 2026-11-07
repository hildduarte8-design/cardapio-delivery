-- ============================================================
-- sql/08_pedido_manual.sql
-- Adiciona as colunas necessárias para suportar pedidos manuais
-- (lançados pelo lojista no painel) sem quebrar pedidos existentes.
--
-- Colunas novas:
--   origem          → 'cardapio' (cliente) | 'manual' (lojista)
--   tipo_atendimento → 'entrega' | 'retirada'
--   desconto        → valor do desconto concedido (R$)
--   desconto_motivo → motivo do desconto (texto livre, até 60 chars)
--
-- Execute no SQL Editor do Supabase.
-- É seguro rodar mais de uma vez (IF NOT EXISTS / IF EXISTS).
-- ============================================================

-- 1. Coluna: origem do pedido
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS origem text
    DEFAULT 'cardapio'
    CHECK (origem IN ('cardapio', 'manual'));

-- Preenche os pedidos antigos que ficaram sem valor
UPDATE public.pedidos
   SET origem = 'cardapio'
 WHERE origem IS NULL;

-- 2. Coluna: tipo de atendimento
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS tipo_atendimento text
    DEFAULT 'entrega'
    CHECK (tipo_atendimento IN ('entrega', 'retirada'));

UPDATE public.pedidos
   SET tipo_atendimento = 'entrega'
 WHERE tipo_atendimento IS NULL;

-- 3. Coluna: desconto em reais (zero = sem desconto)
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS desconto numeric
    DEFAULT 0
    CHECK (desconto >= 0);

UPDATE public.pedidos
   SET desconto = 0
 WHERE desconto IS NULL;

-- 4. Coluna: motivo do desconto (opcional, até 60 caracteres)
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS desconto_motivo text
    CHECK (
      desconto_motivo IS NULL
      OR (
        char_length(desconto_motivo) BETWEEN 1 AND 60
        AND desconto_motivo = trim(desconto_motivo)
      )
    );

-- 5. Regra de coerência: motivo exige desconto > 0
--    (não permite motivo sem desconto e vice-versa quando > 0)
ALTER TABLE public.pedidos
  DROP CONSTRAINT IF EXISTS pedidos_desconto_motivo_coerencia_chk;

ALTER TABLE public.pedidos
  ADD CONSTRAINT pedidos_desconto_motivo_coerencia_chk
    CHECK (
      -- Sem desconto → sem motivo
      (desconto = 0 AND desconto_motivo IS NULL)
      OR
      -- Com desconto → motivo opcional (pode ter ou não)
      (desconto > 0)
    );

-- 6. Verificação rápida: lista as 4 novas colunas confirmando que existem
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'pedidos'
   AND column_name  IN ('origem', 'tipo_atendimento', 'desconto', 'desconto_motivo')
 ORDER BY column_name;
