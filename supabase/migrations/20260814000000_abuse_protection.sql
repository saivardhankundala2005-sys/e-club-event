-- Migration: Abuse Protection for Open Team Registration
--
-- Removing the team email domain restriction means any email can now
-- register, so there's no natural cap on the same person spamming
-- multiple fake team registrations to skew Pool A/B balance or flood the
-- leaderboard. teams.auth_user_id had no uniqueness constraint, so one
-- authenticated identity (one OTP-verified email) could call
-- registerTeamAction repeatedly and create many teams.
--
-- This adds a DB-level guarantee: one authenticated identity can own at
-- most one team. registerTeamAction also gets an app-level pre-check so
-- the user sees a friendly error instead of a raw constraint violation.

ALTER TABLE public.teams
ADD CONSTRAINT teams_auth_user_id_unique UNIQUE (auth_user_id);
