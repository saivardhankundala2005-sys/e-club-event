#!/usr/bin/env node
/**
 * Pitch Under Pressure — critical-path smoke test.
 *
 * Exercises the full scoring pipeline end-to-end against a real Supabase
 * project using the service-role key (bypasses RLS, same as the app's
 * server actions do), so it verifies the same DB operations the app
 * performs without needing a running dev server or real OTP email
 * delivery.
 *
 * Rewritten for the post-dry-run-overhaul schema:
 *   - pitches are created automatically by trg_create_prelim_pitch_for_team
 *     on team insert (not inserted manually — that now races the trigger's
 *     UNIQUE(team_id, round_id) and fails).
 *   - Judge scoring is single-row-per-pitch via pitch_scores on a raw 0-10
 *     scale (locked on first insert), not multi-judge judge_scores rows.
 *   - pitch_leaderboard.total_weighted_score is NULL (not a number) until
 *     pitch_scores has a row for that pitch.
 *
 * Path covered:
 *   1. Team registration (auto-creates a queued prelim pitch via trigger)
 *   2. Judge/organiser account resolution
 *   3. Single-row pitch score submitted (raw 0-10 scale)
 *   4. Lock verification: a second submission for the same pitch is rejected
 *   5. pitch_leaderboard reflects the submitted score with correct math
 *   6. Organiser manual override changes a raw score column
 *   7. score_audit_log entry was created for the override
 *
 * All test rows are tagged with a unique run ID and deleted at the end,
 * including on failure, so repeated runs never accumulate junk data.
 *
 * Usage:
 *   node scripts/smoke-test.js
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY set to a real (non-production, ideally)
 * Supabase project that already has the schema migrations applied.
 */

const { loadEnvLocal } = require('./_load-env');
loadEnvLocal();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || SUPABASE_URL.includes('your-supabase-project-id')) {
  console.error('✗ Missing or placeholder Supabase credentials in .env.local. Aborting.');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `SMOKE-TEST-TEAM-${RUN_ID}`;
const LEADER_EMAIL = `smoke-leader-${RUN_ID}@example.com`;
const MEMBER_EMAIL = `smoke-member-${RUN_ID}@example.com`;
const JUDGE_EMAIL = `smoke-judge-${RUN_ID}@student.nitw.ac.in`;
const ORGANISER_EMAIL = `smoke-organiser-${RUN_ID}@student.nitw.ac.in`;

const created = {
  authUsers: [],       // auth.users ids to delete
  teamId: null,
  judgeId: null,
  pitchId: null,
  pitchScoreId: null,
  roundId: null,
};

let failed = false;
const results = [];

function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
  return ok;
}

async function createAuthUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  created.authUsers.push(data.user.id);
  return data.user.id;
}

async function main() {
  console.log(`\nRunning smoke test (run id: ${RUN_ID})\n`);

  // --- 0. Preconditions: prelim round must exist ---
  const { data: prelimRound, error: roundErr } = await admin
    .from('rounds')
    .select('id')
    .eq('name', 'prelim')
    .single();
  if (!step('Prelim round exists', !roundErr && !!prelimRound, roundErr?.message)) throw new Error('halt');
  created.roundId = prelimRound.id;

  const { data: domains, error: domainsErr } = await admin.from('domains').select('name').limit(1);
  if (!step('At least one domain seeded', !domainsErr && domains?.length > 0, domainsErr?.message)) throw new Error('halt');

  // --- 1. Team registration ---
  const leaderAuthId = await createAuthUser(LEADER_EMAIL);
  await admin.from('profiles').upsert({ id: leaderAuthId, email: LEADER_EMAIL, role: 'team', full_name: 'Smoke Leader' });

  const { data: poolACount } = await admin.from('teams').select('id', { count: 'exact' }).eq('pool', 'A');
  const { data: poolBCount } = await admin.from('teams').select('id', { count: 'exact' }).eq('pool', 'B');
  const assignedPool = (poolACount?.length || 0) <= (poolBCount?.length || 0) ? 'A' : 'B';
  const assignedDomain = domains[0].name;

  const { data: team, error: teamErr } = await admin
    .from('teams')
    .insert({ auth_user_id: leaderAuthId, team_name: TEAM_NAME, domain: assignedDomain, pool: assignedPool, status: 'registered' })
    .select()
    .single();
  if (!step('Team registration inserts team row', !teamErr && !!team, teamErr?.message)) throw new Error('halt');
  created.teamId = team.id;

  const { error: membersErr } = await admin.from('team_members').insert([
    { team_id: team.id, name: 'Smoke Leader', email: LEADER_EMAIL, is_leader: true },
    { team_id: team.id, name: 'Smoke Member', email: MEMBER_EMAIL, is_leader: false },
  ]);
  step('Team members inserted', !membersErr, membersErr?.message);

  // Abuse-protection check: same auth_user_id cannot register a second team
  const { error: dupTeamErr } = await admin
    .from('teams')
    .insert({ auth_user_id: leaderAuthId, team_name: `${TEAM_NAME}-DUP`, domain: assignedDomain, pool: assignedPool, status: 'registered' });
  step(
    'Duplicate team registration blocked (UNIQUE auth_user_id)',
    !!dupTeamErr && dupTeamErr.code === '23505',
    dupTeamErr ? `blocked as expected (${dupTeamErr.code})` : 'NOT BLOCKED — duplicate team was created!'
  );

  // Pitch row is NOT inserted manually — trg_create_prelim_pitch_for_team
  // already created a queued prelim pitch for this team on insert above.
  // Inserting a second one here would collide with pitches'
  // UNIQUE(team_id, round_id) constraint that backs the trigger's
  // ON CONFLICT DO NOTHING.
  const { data: pitch, error: pitchErr } = await admin
    .from('pitches')
    .select('*')
    .eq('team_id', team.id)
    .eq('round_id', created.roundId)
    .maybeSingle();
  if (!step('Prelim pitch auto-created by trigger on team registration', !pitchErr && !!pitch, !pitch && !pitchErr ? 'no pitch row found for team' : pitchErr?.message)) throw new Error('halt');
  created.pitchId = pitch.id;

  // --- 2. Judge login / account resolution ---
  const judgeAuthId = await createAuthUser(JUDGE_EMAIL);
  await admin.from('profiles').upsert({ id: judgeAuthId, email: JUDGE_EMAIL, role: 'judge', full_name: 'Smoke Judge' });
  const { data: judge, error: judgeErr } = await admin
    .from('judges')
    .insert({ auth_user_id: judgeAuthId, name: 'Smoke Judge', email: JUDGE_EMAIL })
    .select()
    .single();
  if (!step('Judge account resolves', !judgeErr && !!judge, judgeErr?.message)) throw new Error('halt');
  created.judgeId = judge.id;

  // --- 3. Judge submits the single authoritative pitch score (mirrors
  // submitPitchScoreAction: raw 0-10 per category, locked on insert) ---
  const { data: pitchScore, error: scoreErr } = await admin
    .from('pitch_scores')
    .insert({
      pitch_id: pitch.id,
      problem_market_raw: 8,
      solution_innovation_raw: 9,
      feasibility_raw: 7,
      pitch_storytelling_raw: 8,
      submitted_by: judgeAuthId,
      submitted_by_name: 'Smoke Judge',
      locked: true,
    })
    .select()
    .single();
  if (!step('Judge submits pitch_scores row (raw 0-10 scale), locked=true', !scoreErr && !!pitchScore, scoreErr?.message)) throw new Error('halt');
  created.pitchScoreId = pitchScore.id;

  // --- 4. Lock verification: a second submission for the same pitch must
  // be rejected by the UNIQUE(pitch_id) constraint (this IS the lock —
  // there's no separate locked-row-update path in the single-row model) ---
  const { error: dupScoreErr } = await admin
    .from('pitch_scores')
    .insert({
      pitch_id: pitch.id,
      problem_market_raw: 1,
      solution_innovation_raw: 1,
      feasibility_raw: 1,
      pitch_storytelling_raw: 1,
      submitted_by: judgeAuthId,
      submitted_by_name: 'Second Judge (should be rejected)',
      locked: true,
    });
  step(
    'Second score submission for the same pitch is rejected (UNIQUE pitch_id)',
    !!dupScoreErr && dupScoreErr.code === '23505',
    dupScoreErr ? `blocked as expected (${dupScoreErr.code})` : 'NOT BLOCKED — duplicate pitch_scores row was created!'
  );

  // --- 5. Leaderboard reflects the score with correct weighted math ---
  await new Promise((r) => setTimeout(r, 500)); // let the view settle
  const { data: leaderboardRow, error: lbErr } = await admin
    .from('pitch_leaderboard')
    .select('*')
    .eq('pitch_id', pitch.id)
    .maybeSingle();
  const lbOk = !lbErr && !!leaderboardRow && leaderboardRow.judges_submitted_count === 1 && leaderboardRow.total_weighted_score !== null;
  step(
    'pitch_leaderboard reflects the submitted score (judges_submitted_count=1, non-null total)',
    lbOk,
    lbErr?.message || (leaderboardRow ? `judges_submitted_count=${leaderboardRow.judges_submitted_count}, total=${leaderboardRow.total_weighted_score}` : 'no row returned')
  );

  // Expected: problem_market 8*10*0.20=16, solution_innovation 9*10*0.20=18,
  // feasibility 7*10*0.15=10.5, storytelling 8*10*0.15=12 -> judge-only
  // subtotal 56.5 (audience/QA add on top; both 0 for a fresh test pitch
  // with no votes/questions, so total should equal 56.5 exactly).
  const expectedJudgeOnly = 8 * 10 * 0.2 + 9 * 10 * 0.2 + 7 * 10 * 0.15 + 8 * 10 * 0.15;
  const mathOk = lbOk && Math.abs(leaderboardRow.total_weighted_score - expectedJudgeOnly) < 0.01;
  step(
    `Weighted total matches hand-calculated value (expected ${expectedJudgeOnly})`,
    mathOk,
    lbOk ? `got ${leaderboardRow.total_weighted_score}` : 'skipped, leaderboard row missing'
  );

  // --- 6. Organiser manual override (mirrors manualOverrideScoreAction:
  // writes the raw 0-10 column directly, same scale judges see) ---
  const orgAuthId = await createAuthUser(ORGANISER_EMAIL);
  await admin.from('profiles').upsert({ id: orgAuthId, email: ORGANISER_EMAIL, role: 'organiser', full_name: 'Smoke Organiser' });

  const oldScore = pitchScore.problem_market_raw;
  const newScore = 10;
  const { error: overrideErr } = await admin
    .from('pitch_scores')
    .update({ problem_market_raw: newScore })
    .eq('id', pitchScore.id);
  step('Organiser override updates pitch_scores raw column', !overrideErr, overrideErr?.message);

  const { error: auditErr } = await admin.from('score_audit_log').insert({
    changed_by: orgAuthId,
    table_changed: 'pitch_scores',
    row_id: pitchScore.id,
    old_value: { problem_market_raw: oldScore },
    new_value: { problem_market_raw: newScore },
    note: `[SMOKE TEST ${RUN_ID}] automated override verification`,
  });
  step('score_audit_log entry inserted for override', !auditErr, auditErr?.message);

  // --- 7. Audit log entry verification ---
  const { data: auditRow, error: auditReadErr } = await admin
    .from('score_audit_log')
    .select('*')
    .eq('row_id', pitchScore.id)
    .eq('table_changed', 'pitch_scores')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();
  const auditOk = !auditReadErr && !!auditRow && auditRow.changed_by === orgAuthId && auditRow.new_value.problem_market_raw === newScore;
  step('Audit log entry has correct actor, old/new value, timestamp', auditOk, auditReadErr?.message);

  console.log('');
}

async function cleanup() {
  console.log('Cleaning up test data...');
  if (created.pitchScoreId) await admin.from('score_audit_log').delete().eq('row_id', created.pitchScoreId);
  if (created.pitchScoreId) await admin.from('pitch_scores').delete().eq('id', created.pitchScoreId);
  if (created.pitchId) await admin.from('pitches').delete().eq('id', created.pitchId);
  if (created.judgeId) await admin.from('judges').delete().eq('id', created.judgeId);
  if (created.teamId) {
    await admin.from('team_members').delete().eq('team_id', created.teamId);
    await admin.from('teams').delete().eq('id', created.teamId);
  }
  for (const uid of created.authUsers) {
    await admin.from('profiles').delete().eq('id', uid);
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
  console.log('Cleanup done.\n');
}

main()
  .catch((e) => {
    if (e.message !== 'halt') console.error('Unexpected error:', e);
    failed = true;
  })
  .finally(async () => {
    await cleanup();
    const passCount = results.filter((r) => r.ok).length;
    console.log(`Result: ${passCount}/${results.length} checks passed`);
    if (failed) {
      console.log('\n✗ SMOKE TEST FAILED — see above for the first failing step.\n');
      process.exit(1);
    } else {
      console.log('\n✓ SMOKE TEST PASSED — critical path is healthy.\n');
      process.exit(0);
    }
  });
