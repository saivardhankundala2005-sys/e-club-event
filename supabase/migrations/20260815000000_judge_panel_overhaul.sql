-- Migration: Judge Panel Functional Overhaul
--
-- Summary of changes:
-- 1. pitches: add queue status + manual reorder override column.
-- 2. event_state: replace the 3-phase timer (idle/prep/pitch/qa/paused)
--    with a simple start/stop model (idle/running/paused/ended), matching
--    the "Call to Stage -> Start Timer -> End Pitch" flow judges/organisers
--    actually use. Default duration becomes 180s (3-minute pitch).
-- 3. pitch_scores: NEW table, one authoritative row per pitch holding the
--    four judge-entered categories. Replaces the multi-judge judge_scores
--    table as the source of truth for the judge-entered 70% of the
--    formula. judge_scores is kept (not dropped) since other code/history
--    may reference it, but it is no longer read by pitch_leaderboard.
-- 4. pitch_leaderboard: rewritten to source the judge-entered categories
--    from pitch_scores (single row) instead of AVG() over judge_scores.
-- 5. Backfill: ensure a 'prelim' round exists and every existing team has
--    a queued prelim pitch row. A trigger keeps this true for future
--    team registrations without touching the registration/OTP code path.

-- ============================================================
-- 1. PITCHES: queue status + manual reorder
-- ============================================================
ALTER TABLE public.pitches
  ADD COLUMN IF NOT EXISTS queue_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (queue_status IN ('queued', 'called', 'pitching', 'awaiting_score', 'scored')),
  ADD COLUMN IF NOT EXISTS queue_position_override INT;

-- ============================================================
-- 2. EVENT STATE: simple start/stop timer model
-- ============================================================
ALTER TABLE public.event_state
  DROP CONSTRAINT IF EXISTS event_state_timer_phase_check;

ALTER TABLE public.event_state
  RENAME COLUMN timer_phase TO timer_status;

ALTER TABLE public.event_state
  ALTER COLUMN timer_status SET DEFAULT 'idle';

UPDATE public.event_state SET timer_status = 'idle' WHERE timer_status NOT IN ('idle', 'running', 'paused', 'ended');

ALTER TABLE public.event_state
  ADD CONSTRAINT event_state_timer_status_check
    CHECK (timer_status IN ('idle', 'running', 'paused', 'ended'));

ALTER TABLE public.event_state
  ALTER COLUMN timer_duration_seconds SET DEFAULT 180;

-- event_state must never boot into a running state.
UPDATE public.event_state SET timer_status = 'idle', timer_started_at = NULL WHERE id = 1;

-- ============================================================
-- 3. PITCH SCORES: single authoritative row per pitch
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pitch_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pitch_id UUID NOT NULL UNIQUE REFERENCES public.pitches(id) ON DELETE CASCADE,
  problem_market_score INT NOT NULL CHECK (problem_market_score >= 0 AND problem_market_score <= 20),
  solution_innovation_score INT NOT NULL CHECK (solution_innovation_score >= 0 AND solution_innovation_score <= 20),
  feasibility_score INT NOT NULL CHECK (feasibility_score >= 0 AND feasibility_score <= 15),
  pitch_storytelling_score INT NOT NULL CHECK (pitch_storytelling_score >= 0 AND pitch_storytelling_score <= 15),
  submitted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  submitted_by_name TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE public.pitch_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read pitch scores" ON public.pitch_scores FOR SELECT USING (true);

-- INSERT permitted for judge/organiser. The UNIQUE(pitch_id) constraint is
-- what actually enforces "first submission wins" at the DB level (a second
-- concurrent insert for the same pitch fails with a unique-violation, which
-- the server action turns into a friendly "Already scored by X" message).
CREATE POLICY "Judge or organiser insert pitch score" ON public.pitch_scores FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('judge', 'organiser'))
);

-- Once locked, only the organiser may UPDATE (the Manual Override path).
-- Judges/organisers cannot directly edit a locked row via normal UPDATE.
CREATE POLICY "Organiser updates locked pitch scores" ON public.pitch_scores FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'organiser')
);

ALTER PUBLICATION supabase_realtime ADD TABLE public.pitch_scores;

-- ============================================================
-- 4. RLS: pitches queue can be updated by judge OR organiser
--    (previously pitches was organiser-only for ALL).
-- ============================================================
DROP POLICY IF EXISTS "Organiser manage pitches" ON public.pitches;

CREATE POLICY "Organiser manage pitches" ON public.pitches FOR ALL USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'organiser')
);

CREATE POLICY "Judge manage pitch queue" ON public.pitches FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'judge')
);

-- event_state: judge can also update (call-to-stage, timer controls),
-- not just organiser.
CREATE POLICY "Judge manage event_state" ON public.event_state FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'judge')
);

-- ============================================================
-- 5. BACKFILL: ensure prelim round + queued pitch row per team
-- ============================================================
INSERT INTO public.rounds (name, order_num)
SELECT 'prelim', 1
WHERE NOT EXISTS (SELECT 1 FROM public.rounds WHERE name = 'prelim');

INSERT INTO public.pitches (team_id, round_id, status, queue_status, pitch_order)
SELECT
  t.id,
  (SELECT id FROM public.rounds WHERE name = 'prelim' LIMIT 1),
  'upcoming',
  'queued',
  ROW_NUMBER() OVER (ORDER BY t.created_at ASC)
FROM public.teams t
WHERE NOT EXISTS (
  SELECT 1 FROM public.pitches p
  WHERE p.team_id = t.id
    AND p.round_id = (SELECT id FROM public.rounds WHERE name = 'prelim' LIMIT 1)
);

-- Trigger: auto-create a queued prelim pitch row whenever a new team
-- registers, without touching the registration/OTP server action code.
CREATE OR REPLACE FUNCTION public.create_prelim_pitch_for_team()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  prelim_round_id UUID;
  next_order INT;
BEGIN
  SELECT id INTO prelim_round_id FROM public.rounds WHERE name = 'prelim' LIMIT 1;
  IF prelim_round_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(pitch_order), 0) + 1 INTO next_order
  FROM public.pitches WHERE round_id = prelim_round_id;

  INSERT INTO public.pitches (team_id, round_id, status, queue_status, pitch_order)
  VALUES (NEW.id, prelim_round_id, 'upcoming', 'queued', next_order)
  ON CONFLICT (team_id, round_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_prelim_pitch_for_team ON public.teams;
CREATE TRIGGER trg_create_prelim_pitch_for_team
  AFTER INSERT ON public.teams
  FOR EACH ROW
  EXECUTE FUNCTION public.create_prelim_pitch_for_team();

-- ============================================================
-- 6. REWRITE pitch_leaderboard: judge-entered categories now come
--    from the single-row pitch_scores table instead of AVG(judge_scores).
--    Audience Rating and Q&A components are UNCHANGED (still computed
--    from audience_scores / questions exactly as before).
-- ============================================================
-- CREATE OR REPLACE VIEW can only append columns at the end, not insert
-- new ones in the middle (Postgres reads that as an implicit rename of
-- existing positional columns and errors with 42P16). Drop and recreate
-- instead since the column set/order is changing.
DROP VIEW IF EXISTS public.pitch_leaderboard;

CREATE VIEW public.pitch_leaderboard AS
WITH
-- 1. Judge-entered component: single official row per pitch, scaled to
--    a common 0-100 basis per category (matches the previous view's
--    0-100 scale so the weighted formula below is unchanged).
judge_component AS (
  SELECT
    p.id AS pitch_id,
    COALESCE(ps.problem_market_score * 5.0, 0) AS problem_market_score,
    COALESCE(ps.solution_innovation_score * 5.0, 0) AS solution_innovation_score,
    COALESCE(ps.feasibility_score * (100.0 / 15.0), 0) AS feasibility_score,
    COALESCE(ps.pitch_storytelling_score * (100.0 / 15.0), 0) AS pitch_storytelling_score,
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

-- 3. Overall Audience score per pitch (average across voters)
audience_component AS (
  SELECT
    p.id AS pitch_id,
    COALESCE(AVG(vpa.voter_normalized_score), 0) AS audience_rating_score,
    COUNT(DISTINCT vpa.voting_team_id) AS total_voters
  FROM public.pitches p
  LEFT JOIN voter_pitch_averages vpa ON vpa.pitch_id = p.id
  GROUP BY p.id
),

-- 4. Q&A / Pressure Test points (sum of approved question points scaled)
qa_component AS (
  SELECT
    p.id AS pitch_id,
    LEAST(GREATEST(50 + COALESCE(SUM(q.points_to_team), 0) * 10, 0), 100) AS qa_pressure_score,
    COALESCE(SUM(q.points_to_team), 0) AS total_qa_points
  FROM public.pitches p
  LEFT JOIN public.questions q ON q.pitch_id = p.id AND q.status = 'approved'
  GROUP BY p.id
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
  qc.qa_pressure_score,

  jc.judges_submitted_count,
  jc.submitted_by_name,
  ac.total_voters,
  qc.total_qa_points,

  -- Final Weighted Formula (UNCHANGED):
  -- Problem & Market (20%) + Solution & Innovation (20%) + Feasibility (15%)
  -- + Storytelling (15%) + Audience (20%) + QA (10%)
  ROUND(
    (jc.problem_market_score * 0.20) +
    (jc.solution_innovation_score * 0.20) +
    (jc.feasibility_score * 0.15) +
    (jc.pitch_storytelling_score * 0.15) +
    (ac.audience_rating_score * 0.20) +
    (qc.qa_pressure_score * 0.10),
    2
  ) AS total_weighted_score
FROM public.pitches p
JOIN public.teams t ON t.id = p.team_id
JOIN public.rounds r ON r.id = p.round_id
JOIN judge_component jc ON jc.pitch_id = p.id
JOIN audience_component ac ON ac.pitch_id = p.id
JOIN qa_component qc ON qc.pitch_id = p.id
ORDER BY total_weighted_score DESC;
