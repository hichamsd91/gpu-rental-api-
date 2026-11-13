create or replace function public.release_escrow(
  p_rental_id uuid,
  p_provider_id uuid,
  p_commission_bps integer default 500,   -- 5% = 500 bps
  p_group text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.escrow_holds%rowtype;
  v_group text := coalesce(p_group, gen_random_uuid()::text);
  v_total bigint;
  v_commission bigint;
  v_provider bigint;
begin
  select * into v_hold from public.escrow_holds where rental_id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_hold');
  end if;
  if v_hold.status <> 'held' then
    return jsonb_build_object('ok', true, 'code', 'already_' || v_hold.status, 'group', v_hold.release_group);
  end if;

  v_total := v_hold.amount_minor;
  v_commission := (v_total * p_commission_bps) / 10000;
  v_provider := v_total - v_commission;

  -- provider wallet credit
  perform public.post_transfer(
    'escrow:' || p_rental_id::text,
    'wallet:' || p_provider_id::text,
    v_provider,
    v_hold.currency,
    'escrow_release',
    p_rental_id::text,
    v_group
  );
  -- platform commission
  if v_commission > 0 then
    perform public.post_transfer(
      'escrow:' || p_rental_id::text,
      'platform.commission',
      v_commission,
      v_hold.currency,
      'commission',
      p_rental_id::text,
      v_group || ':commission'
    );
  end if;

  update public.escrow_holds
    set status = 'released',
        released_at = now(),
        release_group = v_group
    where id = v_hold.id;

  return jsonb_build_object('ok', true, 'code', 'released', 'group', v_group,
    'provider_minor', v_provider, 'commission_minor', v_commission);
end;
$$;

-- ─── RPC: refund escrow back to renter wallet ────────────────────────────────
