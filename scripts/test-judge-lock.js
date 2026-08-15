/**
 * Verifies the judge-score lock bypass fix: after a judge's scores are
 * locked, a second call to the same upsert-based logic used by
 * submitJudgeScoresAction should be rejected by the explicit lock check
 * (not silently overwrite, which is what happened before the fix, since
 * the admin client bypasses RLS).
 */
const { loadEnvLocal } = require('./_load-env');
loadEnvLocal();
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = 'lockcheck-' + Date.now().toString(36);

// Mirrors the lock-check logic added to submitJudgeScoresAction
async function attemptSubmit(judgeId, pitchId, score) {
  const { data: existingScores } = await admin
    .from('judge_scores')
    .select('locked')
    .eq('judge_id', judgeId)
    .eq('pitch_id', pitchId);

  if (existingScores && existingScores.some((s) => s.locked)) {
    return { error: 'Scores for this pitch are already submitted and locked.' };
  }

  const { error } = await admin.from('judge_scores').upsert(
    { judge_id: judgeId, pitch_id: pitchId, criterion: 'problem_market', score, locked: true },
    { onConflict: 'judge_id,pitch_id,criterion' }
  );
  return error ? { error: error.message } : { success: true };
}

async function main() {
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();
  const { data: domains } = await admin.from('domains').select('name').limit(1);

  const { data: teamUser } = await admin.auth.admin.createUser({ email: `${RUN_ID}-team@example.com`, email_confirm: true });
  await admin.from('profiles').upsert({ id: teamUser.user.id, email: teamUser.user.email, role: 'team', full_name: 'Lock Check Team' });
  const { data: team } = await admin.from('teams').insert({
    auth_user_id: teamUser.user.id, team_name: `LOCKCHECK-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();

  const { data: pitch } = await admin.from('pitches').insert({ team_id: team.id, round_id: prelimRound.id, status: 'live', pitch_order: 996 }).select().single();

  const { data: judgeUser } = await admin.auth.admin.createUser({ email: `${RUN_ID}-judge@student.nitw.ac.in`, email_confirm: true });
  await admin.from('profiles').upsert({ id: judgeUser.user.id, email: judgeUser.user.email, role: 'judge', full_name: 'Lock Check Judge' });
  const { data: judge } = await admin.from('judges').insert({ auth_user_id: judgeUser.user.id, name: 'Lock Check Judge', email: judgeUser.user.email }).select().single();

  console.log('First submit (score=8)...');
  const r1 = await attemptSubmit(judge.id, pitch.id, 8);
  console.log(r1.success ? '✓ First submit succeeded' : `✗ First submit failed unexpectedly: ${r1.error}`);

  console.log('Second submit attempting to overwrite (score=1)...');
  const r2 = await attemptSubmit(judge.id, pitch.id, 1);
  const blocked = !!r2.error;
  console.log(blocked ? `✓ Second submit correctly BLOCKED: ${r2.error}` : '✗ Second submit SUCCEEDED — lock bypass still exists!');

  const { data: finalRow } = await admin.from('judge_scores').select('score, locked').eq('judge_id', judge.id).eq('pitch_id', pitch.id).eq('criterion', 'problem_market').single();
  const scoreUnchanged = finalRow.score === 8;
  console.log(scoreUnchanged ? `✓ Score remained 8 (not overwritten to 1)` : `✗ Score was overwritten to ${finalRow.score}!`);

  // Cleanup
  await admin.from('judge_scores').delete().eq('judge_id', judge.id);
  await admin.from('pitches').delete().eq('id', pitch.id);
  await admin.from('judges').delete().eq('id', judge.id);
  await admin.from('teams').delete().eq('id', team.id);
  await admin.auth.admin.deleteUser(teamUser.user.id).catch(() => {});
  await admin.auth.admin.deleteUser(judgeUser.user.id).catch(() => {});

  process.exit(blocked && scoreUnchanged ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
