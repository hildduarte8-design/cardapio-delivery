
-- =====================================================
-- 30_idempotencia_pedidos.sql
-- Proteção contra pedidos duplicados
-- =====================================================

BEGIN;

-- 1. Criar as colunas da idempotência.
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS chave_idempotencia uuid;

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS idempotencia_hash text;

-- 2. Conferir os tipos das colunas.
DO $$
DECLARE
  tipo_chave text;
  tipo_hash text;
BEGIN
  SELECT data_type INTO tipo_chave
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pedidos'
    AND column_name = 'chave_idempotencia';

  SELECT data_type INTO tipo_hash
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pedidos'
    AND column_name = 'idempotencia_hash';

  IF tipo_chave IS DISTINCT FROM 'uuid'
     OR tipo_hash IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION
      'Tipos inesperados nas colunas de idempotência.';
  END IF;
END $$;

-- 3. Exigir chave e hash juntos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.pedidos'::regclass
      AND conname = 'pedidos_idempotencia_coerencia_chk'
  ) THEN
    ALTER TABLE public.pedidos
      ADD CONSTRAINT pedidos_idempotencia_coerencia_chk
      CHECK (
        (
          chave_idempotencia IS NULL
          AND idempotencia_hash IS NULL
        )
        OR
        (
          chave_idempotencia IS NOT NULL
          AND idempotencia_hash IS NOT NULL
          AND idempotencia_hash ~ '^[0-9a-f]{64}$'
        )
      );
  END IF;
END $$;

-- 4. Impedir duplicidade dentro do restaurante.
CREATE UNIQUE INDEX IF NOT EXISTS
  pedidos_restaurante_idempotencia_uidx
ON public.pedidos (restaurante_id, chave_idempotencia)
WHERE chave_idempotencia IS NOT NULL;

COMMIT;
