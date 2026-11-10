alter table pedidos add column if not exists aceito_em timestamptz;

-- Pedidos que já estão esperando não devem disparar o alarme depois da mudança
update pedidos
set aceito_em = created_at
where aceito_em is null
  and status in ('pendente_pagamento', 'pago');
