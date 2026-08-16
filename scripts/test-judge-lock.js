/**
 * Verifies the pitch-score lock: once a pitch_scores row exists for a
 * pitch, a second submission for the same pitch must be rejected. In the
 * post-dry-run-overhaul single-row model, the lock IS the DB-level
 * UNIQUE(pitch_id) constraint on pitch_scores (first insert wins) — there
 * is no separate app-level "locked" boolean check to race, unlike the old
 * multi-judge judge_scores model this script used to test.
 */
const { loadEnvLocal } = require('./_load-env');
loadEnvLocal();
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = 'lockcheck-' + Date.now().toString(36);

// Mirrors submitPitchScoreAction: insert wins or fails on UNIQUE(pitch_id).
async function attemptSubmit(pitchId, submittedByName, score) {
  const { error } = await admin.from('pitch_scores').insert({
    pitch_id: pitchId,
    problem_market_raw: score,
    solution_innovation_raw: score,
    feasibility_raw: score,
    pitch_storytelling_raw: score,
    submitted_by_name: submittedByName,
    locked: true,
  });
  return error ? { error: error.message, code: error.code } : { success: true };
}

async function main() {
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();
  const { data: domains } = await admin.from('domains').select('name').limit(1);

  const { data: teamUser } = await admin.auth.admin.createUser({ email: `${RUN_ID}-team@example.com`, email_confirm: true });
  await admin.from('profiles').upsert({ id: teamUser.user.id, email: teamUser.user.email, role: 'team', full_name: 'Lock Check Team' });
  const { data: team } = await admin.from('teams').insert({
    auth_user_id: teamUser.user.id, team_name: `LOCKCHECK-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();

  // trg_create_prelim_pitch_for_team already created the pitch row.
  const { data: pitch } = await admin.from('pitches')
    .select('*')
    .eq('team_id', team.id)
    .eq('round_id', prelimRound.id)
    .single();

  console.log('First submit (score=8, "Judge A")...');
  const r1 = await attemptSubmit(pitch.id, 'Judge A', 8);
  console.log(r1.success ? '✓ First submit succeeded' : `✗ First submit failed unexpectedly: ${r1.error}`);

  console.log('Second submit attempting to overwrite (score=1, "Judge B")...');
  const r2 = await attemptSubmit(pitch.id, 'Judge B', 1);
  const blocked = !!r2.error && r2.code === '23505';
  console.log(blocked ? `✓ Second submit correctly BLOCKED: ${r2.error}` : `✗ Second submit was NOT blocked as expected — lock bypass exists! (${r2.error || 'no error, row inserted'})`);

  const { data: finalRow } = await admin.from('pitch_scores').select('problem_market_raw, submitted_by_name').eq('pitch_id', pitch.id).single();
  const scoreUnchanged = finalRow.problem_market_raw === 8 && finalRow.submitted_by_name === 'Judge A';
  console.log(scoreUnchanged ? '✓ Score remained Judge A\'s submission (not overwritten)' : `✗ Score was overwritten! problem_market_raw=${finalRow.problem_market_raw}, submitted_by_name=${finalRow.submitted_by_name}`);

  // Cleanup
  await admin.from('pitch_scores').delete().eq('pitch_id', pitch.id);
  await admin.from('pitches').delete().eq('id', pitch.id);
  await admin.from('teams').delete().eq('id', team.id);
  await admin.auth.admin.deleteUser(teamUser.user.id).catch(() => {});

  process.exit(blocked && scoreUnchanged ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
