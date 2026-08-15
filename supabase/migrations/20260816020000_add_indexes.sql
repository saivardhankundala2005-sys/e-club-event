-- Migration: Indexes on frequently-filtered/joined columns
--
-- Section 8 performance pass. At ~150 teams these joins are cheap
-- regardless, but foreign-key columns without an index force a sequential
-- scan on every pitch_leaderboard refresh (which fires on nearly every
-- Realtime event during the event) — indexing them is free insurance.

CREATE INDEX IF NOT EXISTS idx_pitches_team_id ON public.pitches(team_id);
CREATE INDEX IF NOT EXISTS idx_pitches_round_id ON public.pitches(round_id);
CREATE INDEX IF NOT EXISTS idx_pitches_queue_status ON public.pitches(queue_status);

CREATE INDEX IF NOT EXISTS idx_questions_pitch_id ON public.questions(pitch_id);
CREATE INDEX IF NOT EXISTS idx_questions_asking_team_id ON public.questions(asking_team_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON public.questions(status);

CREATE INDEX IF NOT EXISTS idx_audience_scores_pitch_id ON public.audience_scores(pitch_id);
CREATE INDEX IF NOT EXISTS idx_audience_scores_voting_team_id ON public.audience_scores(voting_team_id);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON public.team_members(team_id);

CREATE INDEX IF NOT EXISTS idx_teams_pool ON public.teams(pool);
CREATE INDEX IF NOT EXISTS idx_teams_auth_user_id ON public.teams(auth_user_id);
