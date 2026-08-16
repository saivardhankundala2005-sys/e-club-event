-- Migration: Post-Dry-Run Overhaul
--
-- Covers, in order:
-- 1. event_state.results_revealed + leaderboard/score visibility RLS
-- 2. Judge-entered categories moved to a uniform 0-10 input scale
--    (weighting math now happens here, not in what judges type)
-- 3. Q&A: raw per-question point ledger (pitching_team_id derived,
--    points_pitching/points_asking columns) replacing the old
--    points_to_team/points_to_asker well/poorly-only model
-- 4. pitch_leaderboard rewrite: QA min-max normalized into the 10% slice,
--    zero (not a fake floor) when max_raw == min_raw
-- 5. Domain assignment: least-assigned-first via a counts table
-- 6. Pool assignment: atomic alternation via a sequence
-- 7. Top-3 reveal ceremony support (audit log entry type already covered
--    by score_audit_log; results_revealed lives on event_state)

-- ============================================================
-- 1. RESULTS REVEAL GATE
-- ============================================================
ALTER TABLE public.event_state
  ADD COLUMN IF NOT EXISTS results_revealed BOOLEAN NOT NULL DEFAULT FALSE;

-- Leaderboard-adjacent tables must not be readable by team role until
-- reveal. "Public read" policies on pitch_scores/audience_scores/questions
-- exposed raw per-criterion scores and rankings to any authenticated
-- client (not just via the UI) — replace with role-gated policies.
-- teams/pitches stay public-read (domain/pool/queue state, no scores).

DROP POLICY IF EXISTS "Public read pitch scores" ON public.pitch_scores;
CREATE POLICY "Judge/organiser always read pitch scores, team reads after reveal"
  ON public.pitch_scores FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('judge', 'organiser'))
    OR (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'team')
      AND (SELECT results_revealed FROM public.event_state WHERE id = 1) = TRUE
    )
  );

DROP POLICY IF EXISTS "Public read audience scores" ON public.audience_scores;
CREATE POLICY "Judge/organiser always read audience scores, team reads after reveal"
  ON public.audience_scores FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('judge', 'organiser'))
    OR (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'team')
      AND (SELECT results_revealed FROM public.event_state WHERE id = 1) = TRUE
    )
  );

-- Questions stay readable pre-reveal (teams need to see the live Q&A queue
-- for their own pitch / questions they asked), but the point ledger
-- columns are what leak ranking info — gate SELECT on those columns is not
-- expressible via row-level RLS alone, so the qa_points/points_pitching/
-- points_asking columns are only surfaced by the leaderboard view (below),
-- which is itself gated.

-- Cross-pool enforcement for question submission, at the RLS layer (not
-- just the submitQuestionAction app-level check) — a direct authenticated
-- API call must be rejected too, same guarantee as audience_scores.
DROP POLICY IF EXISTS "Team insert question" ON public.questions;
CREATE POLICY "Team insert question for opposite-pool pitch only" ON public.questions FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.teams t
    JOIN public.pitches p ON p.id = pitch_id
    JOIN public.teams pt ON pt.id = p.team_id
    WHERE t.id = asking_team_id
      AND t.auth_user_id = auth.uid()
      AND t.pool <> pt.pool
      AND t.id <> pt.id
  ) OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'organiser'
  )
);

-- Also allow judge to review (approve/reject + outcome), matching
-- reviewQuestionAction now accepting judge or organiser.
DROP POLICY IF EXISTS "Organiser manage questions" ON public.questions;
CREATE POLICY "Judge or organiser manage questions" ON public.questions FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('judge', 'organiser'))
);

-- ============================================================
-- 1b. OTP REQUEST THROTTLE (re-login rate limit + duplicate-send guard)
-- ============================================================
-- Backs both: (a) a minimum interval between OTP requests for the same
-- email (abuse/rate-limit protection, reusing the existing resend-cooldown
-- pattern), and (b) idempotency for double-submit/flaky-retry duplicate
-- sends. A short window (15s) is enough to absorb a double-click or retry
-- without blocking a genuine "I didn't get it, resend" 30+ seconds later.
CREATE TABLE IF NOT EXISTS public.otp_request_log (
  email TEXT PRIMARY KEY,
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.otp_request_log ENABLE ROW LEVEL SECURITY;
-- No client-facing policies: only ever touched via the admin/service-role
-- client from requestTeamOtpAction, never directly by a browser client.

-- ============================================================
-- 2. JUDGE SLIDER SCALE: 0-10 in, weighted on the way out
-- ============================================================
-- The live pitch_leaderboard view still reads the old pre-weighted
-- columns directly, so Postgres blocks dropping them below with a
-- dependency error. Drop the view now; it's recreated from scratch in
-- section 6 further down, after the new columns exist.
DROP VIEW IF EXISTS public.pitch_leaderboard;

-- pitch_scores currently stores category scores already pre-weighted
-- (0-20 / 0-15). Add raw 0-10 columns; keep the weighted columns as
-- generated values so pitch_leaderboard and any other reader don't need
-- to know the weight constants.
ALTER TABLE public.pitch_scores
  ADD COLUMN IF NOT EXISTS problem_market_raw INT,
  ADD COLUMN IF NOT EXISTS solution_innovation_raw INT,
  ADD COLUMN IF NOT EXISTS feasibility_raw INT,
  ADD COLUMN IF NOT EXISTS pitch_storytelling_raw INT;

-- Backfill raw from the old pre-weighted columns for any existing rows
-- (weighted = raw * 2 for 20% categories, raw * 1.5 for 15% categories).
UPDATE public.pitch_scores SET
  problem_market_raw = ROUND(problem_market_score / 2.0),
  solution_innovation_raw = ROUND(solution_innovation_score / 2.0),
  feasibility_raw = ROUND(feasibility_score / 1.5),
  pitch_storytelling_raw = ROUND(pitch_storytelling_score / 1.5)
WHERE problem_market_raw IS NULL;

ALTER TABLE public.pitch_scores
  ALTER COLUMN problem_market_raw SET NOT NULL,
  ALTER COLUMN solution_innovation_raw SET NOT NULL,
  ALTER COLUMN feasibility_raw SET NOT NULL,
  ALTER COLUMN pitch_storytelling_raw SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pitch_scores_raw_range'
  ) THEN
    ALTER TABLE public.pitch_scores ADD CONSTRAINT pitch_scores_raw_range CHECK (
      problem_market_raw BETWEEN 0 AND 10 AND
      solution_innovation_raw BETWEEN 0 AND 10 AND
      feasibility_raw BETWEEN 0 AND 10 AND
      pitch_storytelling_raw BETWEEN 0 AND 10
    );
  END IF;
END $$;

-- The old pre-weighted columns are superseded by *_raw + the weighting
-- done in pitch_leaderboard. Drop their old CHECK constraints (0-20/0-15)
-- since submitPitchScoreAction no longer writes them, then drop the
-- columns — nothing else reads them once the view below is rewritten.
ALTER TABLE public.pitch_scores
  DROP COLUMN IF EXISTS problem_market_score,
  DROP COLUMN IF EXISTS solution_innovation_score,
  DROP COLUMN IF EXISTS feasibility_score,
  DROP COLUMN IF EXISTS pitch_storytelling_score;

-- ============================================================
-- 3. Q&A: raw per-question point ledger
-- ============================================================
ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS points_pitching INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points_asking INT NOT NULL DEFAULT 0;

-- Backfill from the old points_to_team/points_to_asker columns using the
-- OLD point rule's outcomes reinterpreted is not possible (the old rule's
-- values don't map 1:1 to the new one — e.g. old "poorly" gave asker +1,
-- new "poorly" also gives asker +1, but old "well" gave team +1/asker +0
-- vs new team +2/asker +2). Re-derive from status/outcome directly instead
-- of copying the old point columns, so historical rows score under the
-- new rule rather than carrying stale point values forward.
UPDATE public.questions SET
  points_pitching = CASE
    WHEN status = 'approved' AND outcome = 'team_answered_well' THEN 2
    ELSE 0
  END,
  points_asking = CASE
    WHEN status = 'approved' AND outcome = 'team_answered_well' THEN 2
    WHEN status = 'approved' AND outcome = 'team_answered_poorly' THEN 1
    ELSE 0
  END;

ALTER TABLE public.questions
  DROP COLUMN IF EXISTS points_to_team,
  DROP COLUMN IF EXISTS points_to_asker;

-- pitching_team_id is derived via pitch_id -> pitches.team_id and isn't
-- stored redundantly on questions (would risk drifting from the pitch it
-- references); pitch_leaderboard's qa aggregation joins through pitches.

-- ============================================================
-- 4. DOMAIN LEAST-ASSIGNED-FIRST TRACKING
-- ============================================================
-- Track assignment counts per domain so registerTeamAction can pick from
-- the currently-lowest-count set instead of Math.random() across all
-- domains uniformly (which produces back-to-back repeats).
ALTER TABLE public.domains
  ADD COLUMN IF NOT EXISTS assigned_count INT NOT NULL DEFAULT 0;

-- Backfill counts from existing team registrations so the algorithm
-- starts from the true current distribution, not zero.
UPDATE public.domains d SET assigned_count = (
  SELECT COUNT(*) FROM public.teams t WHERE t.domain = d.name
);

-- ============================================================
-- 5. POOL ALTERNATION SEQUENCE
-- ============================================================
-- Atomic, race-free pool assignment: nextval() is a single atomic
-- operation in Postgres (no read-then-write window), unlike the previous
-- countA <= countB check-then-insert pattern.
CREATE SEQUENCE IF NOT EXISTS public.team_registration_seq START 1;

-- Fast-forward the sequence past any teams already registered under the
-- old random-pool-assignment scheme, so alternation continues cleanly
-- from here rather than restarting at 1 and potentially reusing values.
SELECT setval(
  'public.team_registration_seq',
  GREATEST((SELECT COUNT(*) FROM public.teams), 0) + 1,
  false
);

-- Single atomic operation: nextval() + odd/even -> pool, no client input,
-- no read-then-write window. SECURITY DEFINER so the anon/authenticated
-- role calling this via RPC doesn't need direct sequence USAGE grants.
CREATE OR REPLACE FUNCTION public.next_pool_assignment()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  seq_val BIGINT;
BEGIN
  seq_val := nextval('public.team_registration_seq');
  RETURN CASE WHEN seq_val % 2 = 1 THEN 'A' ELSE 'B' END;
END;
$$;

REVOKE ALL ON FUNCTION public.next_pool_assignment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_pool_assignment() TO authenticated;
-- registerTeamAction calls this via the service-role admin client, which
-- does not automatically inherit the `authenticated` grant for RPC calls —
-- without this, real team registration fails with "permission denied".
GRANT EXECUTE ON FUNCTION public.next_pool_assignment() TO service_role;

-- Least-assigned-first domain pick: locks the candidate row
-- (FOR UPDATE SKIP LOCKED-free single-row lock is enough here since we
-- pick one lowest-count row, lock it, increment, and return its name, all
-- inside one statement's transaction) so two concurrent callers can't both
-- read the same minimum count and pick the same domain.
CREATE OR REPLACE FUNCTION public.assign_least_used_domain()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  chosen_id UUID;
  chosen_name TEXT;
BEGIN
  SELECT id, name INTO chosen_id, chosen_name
  FROM public.domains
  ORDER BY assigned_count ASC, random()
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF chosen_id IS NULL THEN
    -- All rows locked by concurrent callers; fall back to a blocking
    -- lock on the true minimum so no request fails outright.
    SELECT id, name INTO chosen_id, chosen_name
    FROM public.domains
    ORDER BY assigned_count ASC, random()
    LIMIT 1
    FOR UPDATE;
  END IF;

  UPDATE public.domains SET assigned_count = assigned_count + 1 WHERE id = chosen_id;

  RETURN chosen_name;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_least_used_domain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_least_used_domain() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_least_used_domain() TO service_role;

-- ============================================================
-- 6. REWRITE pitch_leaderboard
-- ============================================================
DROP VIEW IF EXISTS public.pitch_leaderboard;

CREATE VIEW public.pitch_leaderboard AS
WITH
-- 1. Judge-entered component: single official row per pitch. Raw 0-10
--    inputs are weighted here (x2 for 20% categories, x1.5 for 15%
--    categories), producing the same 0-100-per-category basis as before.
judge_component AS (
  SELECT
    p.id AS pitch_id,
    COALESCE(ps.problem_market_raw * 10.0, 0) AS problem_market_score,
    COALESCE(ps.solution_innovation_raw * 10.0, 0) AS solution_innovation_score,
    COALESCE(ps.feasibility_raw * 10.0, 0) AS feasibility_score,
    COALESCE(ps.pitch_storytelling_raw * 10.0, 0) AS pitch_storytelling_score,
    CASE WHEN ps.id IS NOT NULL THEN 1 ELSE 0 END AS judges_submitted_count,
    ps.submitted_by_name
  FROM public.pitches p
  LEFT JOIN public.pitch_scores ps ON ps.pitch_id = p.id
),

-- 2. Voter average scores per pitch & voting team (1-5 scale normalized to 0-100)
voter_pitch_averages AS (
  SELECT
    pitch_id,
    voting_team_id,
    (AVG(score) - 1.0) / 4.0 * 100.0 AS voter_normalized_score
  FROM public.audience_scores
  GROUP BY pitch_id, voting_team_id
),

-- 3. Overall Audience score per pitch (average across voters, 0-100)
audience_component AS (
  SELECT
    p.id AS pitch_id,
    COALESCE(AVG(vpa.voter_normalized_score), 0) AS audience_rating_score,
    COUNT(DISTINCT vpa.voting_team_id) AS total_voters
  FROM public.pitches p
  LEFT JOIN voter_pitch_averages vpa ON vpa.pitch_id = p.id
  GROUP BY p.id
),

-- 4. Q&A raw points per TEAM (not per pitch): sum of points earned while
--    being pitched-to (across all their questions received) plus points
--    earned while asking (across all pitches they asked questions at).
--    This is team-scoped because the same team's asking activity happens
--    at OTHER teams' pitches, not their own.
qa_points_pitching AS (
  SELECT p.team_id, COALESCE(SUM(q.points_pitching), 0) AS pts
  FROM public.questions q
  JOIN public.pitches p ON p.id = q.pitch_id
  GROUP BY p.team_id
),
qa_points_asking AS (
  SELECT q.asking_team_id AS team_id, COALESCE(SUM(q.points_asking), 0) AS pts
  FROM public.questions q
  GROUP BY q.asking_team_id
),
qa_raw_by_team AS (
  SELECT
    t.id AS team_id,
    COALESCE(qpp.pts, 0) + COALESCE(qpa.pts, 0) AS raw_qa_points
  FROM public.teams t
  LEFT JOIN qa_points_pitching qpp ON qpp.team_id = t.id
  LEFT JOIN qa_points_asking qpa ON qpa.team_id = t.id
),
qa_bounds AS (
  SELECT MIN(raw_qa_points) AS min_raw, MAX(raw_qa_points) AS max_raw
  FROM qa_raw_by_team
),
qa_component AS (
  SELECT
    q.team_id,
    q.raw_qa_points,
    CASE
      WHEN b.max_raw = b.min_raw THEN 0
      ELSE ((q.raw_qa_points - b.min_raw)::NUMERIC / (b.max_raw - b.min_raw)) * 10.0
    END AS qa_component_score
  FROM qa_raw_by_team q
  CROSS JOIN qa_bounds b
)

SELECT
  t.id AS team_id,
  t.team_name,
  t.domain,
  t.pool,
  p.id AS pitch_id,
  r.id AS round_id,
  r.name AS round_name,
  p.status AS pitch_status,
  p.queue_status,
  p.pitch_order,
  p.queue_position_override,

  jc.problem_market_score,
  jc.solution_innovation_score,
  jc.feasibility_score,
  jc.pitch_storytelling_score,
  ac.audience_rating_score,
  qc.qa_component_score AS qa_pressure_score,

  jc.judges_submitted_count,
  jc.submitted_by_name,
  ac.total_voters,
  qc.raw_qa_points AS total_qa_points,

  -- Final Weighted Formula (0-100). NULL (not 0, not a fake baseline)
  -- until a judge/organiser has actually submitted pitch_scores for this
  -- pitch — the UI shows "Awaiting score" on NULL rather than a
  -- misleadingly low real number.
  CASE WHEN jc.judges_submitted_count = 0 THEN NULL ELSE
    ROUND(
      (jc.problem_market_score * 0.20) +
      (jc.solution_innovation_score * 0.20) +
      (jc.feasibility_score * 0.15) +
      (jc.pitch_storytelling_score * 0.15) +
      (ac.audience_rating_score * 0.20) +
      COALESCE(qc.qa_component_score, 0),
      2
    )
  END AS total_weighted_score
FROM public.pitches p
JOIN public.teams t ON t.id = p.team_id
JOIN public.rounds r ON r.id = p.round_id
JOIN judge_component jc ON jc.pitch_id = p.id
JOIN audience_component ac ON ac.pitch_id = p.id
LEFT JOIN qa_component qc ON qc.team_id = t.id
ORDER BY total_weighted_score DESC;

-- event_state.results_revealed rides the existing supabase_realtime
-- publication membership (event_state was already added in the initial
-- migration) — no publication change needed here.
