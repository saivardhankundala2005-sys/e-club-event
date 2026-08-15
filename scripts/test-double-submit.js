/**
 * Verifies the audience-vote double-submit race fix: fires two concurrent
 * insert batches for the same (voting_team_id, pitch_id) — mirroring what
 * submitAudienceRatingAction does — and confirms the DB unique constraint
 * prevents duplicate rows regardless of which request "wins" the race.
 */
const { loadEnvLocal } = require('./_load-env');
loadEnvLocal();
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RUN_ID = Date.now().toString(36);

async function main() {
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();
  const { data: domains } = await admin.from('domains').select('name').limit(1);

  // Two teams in different pools so voting is allowed
  const { data: userA } = await admin.auth.admin.createUser({ email: `race-voter-${RUN_ID}@example.com`, email_confirm: true });
  const { data: userB } = await admin.auth.admin.createUser({ email: `race-pitcher-${RUN_ID}@example.com`, email_confirm: true });
  await admin.from('profiles').upsert({ id: userA.user.id, email: userA.user.email, role: 'team', full_name: 'Race Voter' });
  await admin.from('profiles').upsert({ id: userB.user.id, email: userB.user.email, role: 'team', full_name: 'Race Pitcher' });

  const { data: voterTeam } = await admin.from('teams').insert({
    auth_user_id: userA.user.id, team_name: `RACE-VOTER-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();

  const { data: pitchTeam } = await admin.from('teams').insert({
    auth_user_id: userB.user.id, team_name: `RACE-PITCHER-${RUN_ID}`, domain: domains[0].name, pool: 'B', status: 'registered',
  }).select().single();

  const { data: pitch } = await admin.from('pitches').insert({
    team_id: pitchTeam.id, round_id: prelimRound.id, status: 'live', pitch_order: 998,
  }).select().single();

  const entries = [
    { criterion: 'problem_relevance', score: 4 },
    { criterion: 'creativity', score: 5 },
    { criterion: 'solution_quality', score: 3 },
    { criterion: 'pitch_quality', score: 4 },
    { criterion: 'overall_potential', score: 5 },
  ];
  const rows = entries.map((e) => ({ voting_team_id: voterTeam.id, pitch_id: pitch.id, criterion: e.criterion, score: e.score }));

  console.log(`Firing two concurrent identical insert batches for team ${voterTeam.id} / pitch ${pitch.id}...`);
  const [res1, res2] = await Promise.all([
    admin.from('audience_scores').insert(rows),
    admin.from('audience_scores').insert(rows),
  ]);

  console.log('Request 1:', res1.error ? `REJECTED (${res1.error.code}: ${res1.error.message})` : 'SUCCEEDED');
  console.log('Request 2:', res2.error ? `REJECTED (${res2.error.code}: ${res2.error.message})` : 'SUCCEEDED');

  const { data: finalRows, count } = await admin
    .from('audience_scores')
    .select('*', { count: 'exact' })
    .eq('voting_team_id', voterTeam.id)
    .eq('pitch_id', pitch.id);

  const expectedCount = entries.length;
  const ok = finalRows.length === expectedCount;
  console.log(`\nFinal row count: ${finalRows.length} (expected ${expectedCount}) — ${ok ? 'PASS: no duplicates' : 'FAIL: duplicate/missing rows!'}`);

  // Cleanup
  await admin.from('audience_scores').delete().eq('voting_team_id', voterTeam.id);
  await admin.from('pitches').delete().eq('id', pitch.id);
  await admin.from('teams').delete().in('id', [voterTeam.id, pitchTeam.id]);
  await admin.auth.admin.deleteUser(userA.user.id).catch(() => {});
  await admin.auth.admin.deleteUser(userB.user.id).catch(() => {});

  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
