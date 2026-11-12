-- Aparelhos do lojista que recebem notificação push
create table if not exists push_aparelhos (
  id uuid primary key default gen_random_uuid(),
  restaurante_id uuid not null references restaurantes(id) on delete cascade,
  usuario_id uuid default auth.uid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  criado_em timestamptz not null default now(),
  constraint push_aparelhos_endpoint_chk check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  constraint push_aparelhos_chaves_chk check (char_length(p256dh) <= 200 and char_length(auth) <= 100)
);

create index if not exists push_aparelhos_restaurante_idx on push_aparelhos (restaurante_id);

alter table push_aparelhos enable row level security;

drop policy if exists push_aparelhos_select on push_aparelhos;
create policy push_aparelhos_select on push_aparelhos
  for select to authenticated
  using (restaurante_id in (select meus_restaurantes()));

drop policy if exists push_aparelhos_insert on push_aparelhos;
create policy push_aparelhos_insert on push_aparelhos
  for insert to authenticated
  with check (restaurante_id in (select meus_restaurantes()));

drop policy if exists push_aparelhos_update on push_aparelhos;
create policy push_aparelhos_update on push_aparelhos
  for update to authenticated
  using (restaurante_id in (select meus_restaurantes()))
  with check (restaurante_id in (select meus_restaurantes()));

drop policy if exists push_aparelhos_delete on push_aparelhos;
create policy push_aparelhos_delete on push_aparelhos
  for delete to authenticated
  using (restaurante_id in (select meus_restaurantes()));

-- Controle da repetição de avisos a cada 30 segundos (o backend usa estes dois campos)
alter table pedidos add column if not exists alerta_push_qtd integer not null default 0;
alter table pedidos add column if not exists alerta_push_em timestamptz;
