create or replace function public.refund_escrow(
  p_rental_id uuid,
  p_renter_id uuid,
  p_amount_minor bigint default null,
  p_group text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.escrow_holds%rowtype;
  v_group text := coalesce(p_group, gen_random_uuid()::text);
  v_amount bigint;
begin
  select * into v_hold from public.escrow_holds where rental_id = p_rental_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_hold');
  end if;
  if v_hold.status not in ('held','partial_refund') then
    return jsonb_build_object('ok', true, 'code', 'already_' || v_hold.status);
  end if;

  v_amount := coalesce(p_amount_minor, v_hold.amount_minor);
  if v_amount <= 0 or v_amount > v_hold.amount_minor then
    return jsonb_build_object('ok', false, 'code', 'invalid_amount');
  end if;

  perform public.post_transfer(
    'escrow:' || p_rental_id::text,
    'wallet:' || p_renter_id::text,
    v_amount,
    v_hold.currency,
    'escrow_refund',
    p_rental_id::text,
    v_group
  );

  if v_amount = v_hold.amount_minor then
    update public.escrow_holds
      set status = 'refunded', refunded_at = now(), refund_group = v_group
      where id = v_hold.id;
  else
    update public.escrow_holds
      set status = 'partial_refund', refund_group = v_group,
          amount_minor = amount_minor - v_amount
      where id = v_hold.id;
  end if;

  return jsonb_build_object('ok', true, 'code', 'refunded', 'group', v_group, 'amount_minor', v_amount);
end;
$$;

grant execute on function public.release_escrow(uuid, uuid, integer, text) to service_role;
grant execute on function public.refund_escrow(uuid, uuid, bigint, text) to service_role;

-- Row Level Security: service_role only (API-only DB pattern).
