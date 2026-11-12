-- 19: cliente avisa que pagou o Pix (não muda o status, só sinaliza ao lojista)
alter table public.pedidos
  add column if not exists pagamento_avisado_em timestamptz;
