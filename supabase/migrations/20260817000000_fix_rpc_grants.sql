-- Migration: Fix service_role EXECUTE grant on registration RPCs
--
-- CRITICAL FIX: registerTeamAction runs entirely through the service-role
-- admin client (createAdminClient()), but next_pool_assignment() and
-- assign_least_used_domain() were only granted EXECUTE to `authenticated`.
-- The service role does not automatically inherit that grant for calling
-- functions via PostgREST RPC — every real team registration since the
-- post-dry-run-overhaul migration was applied has been failing with
-- "permission denied for function ..." (42501). Confirmed live via a
-- direct RPC call returning HTTP 403 before this fix.
--
-- Grant EXECUTE to service_role explicitly. authenticated keeps its grant
-- too in case these are ever called from a user-session context directly.

GRANT EXECUTE ON FUNCTION public.next_pool_assignment() TO service_role;
GRANT EXECUTE ON FUNCTION public.assign_least_used_domain() TO service_role;
