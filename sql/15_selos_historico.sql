-- Histórico de selos: todo ajuste fica registrado
create table if not exists public.selos_historico (
  id bigint generated always as identity primary key,
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  delta int not null,
  saldo_depois int not null,
  tipo text not null,            -- automatico | manual | resgate | direto
  motivo text,
  usuario_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists selos_historico_cliente_idx on public.selos_historico (cliente_id, created_at desc);

alter table public.selos_historico enable row level security;

-- Dono só LÊ (e só dos próprios clientes). Ninguém grava pelo navegador.
drop policy if exists selos_historico_leitura on public.selos_historico;
create policy selos_historico_leitura on public.selos_historico
  for select to authenticated
  using (exists (select 1 from public.clientes c where c.id = selos_historico.cliente_id));

-- Trigger: registra qualquer mudança de selos e bloqueia alteração direta pelo painel
create or replace function public.selos_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delta int;
  v_tipo text := current_setting('app.selo_tipo', true);
  v_motivo text := current_setting('app.selo_motivo', true);
begin
  v_delta := coalesce(new.selos_fidelidade, 0)
           - case when tg_op = 'UPDATE' then coalesce(old.selos_fidelidade, 0) else 0 end;
  if v_delta = 0 then return new; end if;

  if coalesce(v_tipo, '') = '' then
    if auth.role() = 'authenticated' then
      raise exception 'Selos só podem ser alterados pelo ajuste com motivo.';
    end if;
    v_tipo := 'direto';
  end if;

  insert into selos_historico (cliente_id, delta, saldo_depois, tipo, motivo, usuario_id)
  values (new.id, v_delta, coalesce(new.selos_fidelidade, 0), v_tipo, nullif(v_motivo, ''), auth.uid());
  return new;
end;
$$;

drop trigger if exists selos_log_trg on public.clientes;
create trigger selos_log_trg
  after insert or update of selos_fidelidade on public.clientes
  for each row execute function public.selos_log();

-- Ajuste manual / resgate: motivo obrigatório. Roda com as permissões de quem chama,
-- então só o dono do restaurante consegue mexer nos próprios clientes.
create or replace function public.ajustar_selos(
  p_cliente_id uuid,
  p_delta int,
  p_motivo text,
  p_tipo text default 'manual'
)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_novo int;
begin
  if p_tipo not in ('manual', 'resgate') then
    raise exception 'Tipo inválido.';
  end if;
  if p_delta = 0 or abs(p_delta) > 10 then
    raise exception 'Ajuste inválido.';
  end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Informe o motivo do ajuste.';
  end if;

  if p_tipo = 'resgate' then
    if p_delta <> -10 or not exists (
      select 1 from clientes where id = p_cliente_id and coalesce(selos_fidelidade, 0) >= 10
    ) then
      raise exception 'Cliente ainda não tem 10 selos para resgatar.';
    end if;
  end if;

  perform set_config('app.selo_tipo', p_tipo, true);
  perform set_config('app.selo_motivo', trim(p_motivo), true);

  update clientes
  set selos_fidelidade = greatest(0, least(99, coalesce(selos_fidelidade, 0) + p_delta))
  where id = p_cliente_id
  returning selos_fidelidade into v_novo;

  if v_novo is null then
    raise exception 'Cliente não encontrado.';
  end if;
  return v_novo;
end;
$$;

revoke all on function public.ajustar_selos(uuid, int, text, text) from public, anon;
grant execute on function public.ajustar_selos(uuid, int, text, text) to authenticated;

-- Selo automático do pedido passa a ser registrado como "automatico"
create or replace function public.registrar_pedido_cliente(
  p_restaurante_id uuid,
  p_nome text,
  p_telefone text,
  p_endereco text,
  p_total numeric,
  p_retirada boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id clientes.id%type;
  v_selo int := case when p_total >= 25 then 1 else 0 end;
  v_local text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_completo text;
begin
  perform set_config('app.selo_tipo', 'automatico', true);
  perform set_config('app.selo_motivo', 'Pedido pelo cardápio', true);

  if length(v_local) >= 12 and left(v_local, 2) = '55' then
    v_local := substr(v_local, 3);
  end if;
  v_completo := '55' || v_local;

  select id into v_id
  from clientes
  where restaurante_id = p_restaurante_id
    and (
      regexp_replace(coalesce(telefone_original, ''), '\D', '', 'g') = v_local
      or regexp_replace(coalesce(telefone, ''), '\D', '', 'g') in (v_local, v_completo)
    )
  limit 1;

  if v_id is null then
    insert into clientes (
      restaurante_id, nome, telefone, telefone_original,
      endereco, selos_fidelidade, ultimo_pedido_em, origem
    ) values (
      p_restaurante_id, p_nome, v_completo, v_local,
      case when p_retirada then null else p_endereco end,
      v_selo, now(), 'cardapio'
    );
  else
    update clientes
    set ultimo_pedido_em = now(),
        selos_fidelidade = coalesce(selos_fidelidade, 0) + v_selo,
        endereco = case when p_retirada then endereco else p_endereco end
    where id = v_id;
  end if;
end;
$$;

revoke all on function public.registrar_pedido_cliente(uuid, text, text, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.registrar_pedido_cliente(uuid, text, text, text, numeric, boolean) to service_role;
