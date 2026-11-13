ALTER TABLE public.stripe_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escrow_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- ROLLBACK:
-- drop function if exists public.refund_escrow(uuid, uuid, bigint, text);
-- drop function if exists public.release_escrow(uuid, uuid, integer, text);
-- drop table if exists public.invoices;
-- drop table if exists public.refunds;
-- drop table if exists public.payouts;
-- drop table if exists public.escrow_holds;
-- drop table if exists public.payment_intents;
-- drop table if exists public.stripe_accounts;

