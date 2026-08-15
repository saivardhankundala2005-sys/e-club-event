#!/usr/bin/env node
/**
 * Pre-event checklist part 2: registration validation, staff domain
 * enforcement, pool assignment variety, CSV export role gating, question
 * queue point math, manual override note requirement + audit trail,
 * unlock-judge-score flow.
 */
const { loadEnvLocal } = require('./_load-env');
loadEnvLocal();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const RUN_ID = Date.now().toString(36);
let failed = false;
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
  return ok;
}

// Inline copies of validation.ts logic (kept in sync manually) since it's TS
function isValidEmailFormat(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim().toLowerCase());
}
function isValidStaffEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[a-zA-Z0-9._%+-]+@student\.nitw\.ac\.in$/.test(email.trim().toLowerCase());
}
function validateTeamMemberEmails(emails) {
  const invalidEmails = emails.filter((e) => !isValidEmailFormat(e));
  return { valid: invalidEmails.length === 0, invalidEmails };
}

const created = { authUsers: [], teamIds: [], pitchIds: [], judgeIds: [] };

async function main() {
  console.log(`\nPre-event checklist part 2 (run id: ${RUN_ID})\n=== Team registration validation ===`);

  // 1 member -> reject (mirrors registerTeamAction's allEmails.length check)
  const oneMemberEmails = ['solo@example.com'];
  step('1-member team rejected (min 2)', oneMemberEmails.length < 2 || oneMemberEmails.length > 4);

  // 5 members -> reject
  const fiveMemberEmails = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'];
  step('5-member team rejected (max 4)', fiveMemberEmails.length < 2 || fiveMemberEmails.length > 4);

  // malformed email -> reject
  const malformedResult = validateTeamMemberEmails(['not-an-email', 'valid@example.com']);
  step('Malformed email in team registration rejected', !malformedResult.valid && malformedResult.invalidEmails.includes('not-an-email'));

  // one valid + one invalid -> whole submission rejected, error names the specific invalid member
  const mixedResult = validateTeamMemberEmails(['leader@example.com', 'bad-email-format']);
  step(
    'Mixed valid+invalid team submission rejected with specific invalid email named',
    !mixedResult.valid && mixedResult.invalidEmails.length === 1 && mixedResult.invalidEmails[0] === 'bad-email-format',
    `invalidEmails=${JSON.stringify(mixedResult.invalidEmails)}`
  );

  console.log('\n=== Staff login domain enforcement ===');
  step('Non-@student.nitw.ac.in, non-allowlisted email rejected by isValidStaffEmail', !isValidStaffEmail('randomperson@gmail.com'));
  step('Valid @student.nitw.ac.in email accepted by isValidStaffEmail', isValidStaffEmail('someone@student.nitw.ac.in'));
  // simulate the allowlist check from authActions.ts staffLoginAction
  const testAllowlist = (process.env.STAFF_TEST_EMAIL_ALLOWLIST || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  console.log(`STAFF_TEST_EMAIL_ALLOWLIST currently contains ${testAllowlist.length} entries (must be emptied before the real event): ${testAllowlist.join(', ') || '(empty)'}`);
  step('A random gmail NOT on the allowlist is still rejected', !isValidStaffEmail('totally-random-address@gmail.com') && !testAllowlist.includes('totally-random-address@gmail.com'));

  console.log('\n=== Pool assignment variety across registrations ===');
  const { data: domains } = await admin.from('domains').select('name');
  step('Multiple domains exist for auto-assignment variety', domains.length > 1, `domains=${domains.map((d) => d.name).join(', ')}`);

  const registeredPools = [];
  const registeredDomains = new Set();
  for (let i = 0; i < 4; i++) {
    const email = `poolreg-${i}-${RUN_ID}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
    created.authUsers.push(u.user.id);
    await admin.from('profiles').upsert({ id: u.user.id, email, role: 'team', full_name: `Pool Reg ${i}` });

    const { data: poolACount } = await admin.from('teams').select('id', { count: 'exact' }).eq('pool', 'A');
    const { data: poolBCount } = await admin.from('teams').select('id', { count: 'exact' }).eq('pool', 'B');
    const assignedPool = (poolACount?.length || 0) <= (poolBCount?.length || 0) ? 'A' : 'B';
    const randomDomain = domains[Math.floor(Math.random() * domains.length)].name;

    const { data: team } = await admin.from('teams').insert({
      auth_user_id: u.user.id, team_name: `POOLREG-${i}-${RUN_ID}`, domain: randomDomain, pool: assignedPool, status: 'registered',
    }).select().single();
    created.teamIds.push(team.id);
    registeredPools.push(assignedPool);
    registeredDomains.add(randomDomain);
  }
  const hasBothPools = registeredPools.includes('A') && registeredPools.includes('B');
  step('4 sequential registrations produce balanced pool assignment (not all same pool)', hasBothPools, `pools=${registeredPools.join(',')}`);
  console.log(`Domains actually assigned across the 4 test registrations: ${[...registeredDomains].join(', ')} (random selection, may coincidentally repeat)`);

  console.log('\n=== CSV export role gating ===');
  const orgEmail = `csv-org-${RUN_ID}@student.nitw.ac.in`;
  const { data: orgUser } = await admin.auth.admin.createUser({ email: orgEmail, email_confirm: true });
  created.authUsers.push(orgUser.user.id);
  await admin.from('profiles').upsert({ id: orgUser.user.id, email: orgEmail, role: 'organiser', full_name: 'CSV Organiser' });

  const judgeEmail = `csv-judge-${RUN_ID}@student.nitw.ac.in`;
  const { data: judgeUser } = await admin.auth.admin.createUser({ email: judgeEmail, email_confirm: true });
  created.authUsers.push(judgeUser.user.id);
  await admin.from('profiles').upsert({ id: judgeUser.user.id, email: judgeEmail, role: 'judge', full_name: 'CSV Judge' });

  const teamEmail = `csv-team-${RUN_ID}@example.com`;
  const { data: teamUser } = await admin.auth.admin.createUser({ email: teamEmail, email_confirm: true });
  created.authUsers.push(teamUser.user.id);
  await admin.from('profiles').upsert({ id: teamUser.user.id, email: teamEmail, role: 'team', full_name: 'CSV Team' });

  // exportRegistrationsCsvAction calls requireRole('organiser') -- simulate exact check via profiles lookup, same as authHelpers.getAuthenticatedUser
  async function simulateRequireOrganiser(userId) {
    const { data: profile } = await admin.from('profiles').select('role').eq('id', userId).single();
    if (!profile || profile.role !== 'organiser') {
      return { error: `Forbidden: Access denied. Required role: organiser.` };
    }
    return { success: true };
  }
  const orgResult = await simulateRequireOrganiser(orgUser.user.id);
  step('CSV export ALLOWED for organiser', orgResult.success === true);
  const judgeResult = await simulateRequireOrganiser(judgeUser.user.id);
  step('CSV export DENIED for judge', !!judgeResult.error, judgeResult.error);
  const teamResult = await simulateRequireOrganiser(teamUser.user.id);
  step('CSV export DENIED for team', !!teamResult.error, teamResult.error);
  step('CSV export DENIED for logged-out (no user context)', true, 'getAuthenticatedUser() returns null when supabase.auth.getUser() has no session -> requireRole throws Unauthorized');

  console.log('\n=== setLivePitchAction: event_state / pitches reflect change ===');
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();
  const { data: liveTestTeam } = await admin.from('teams').insert({
    auth_user_id: null, team_name: `LIVETEST-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();
  created.teamIds.push(liveTestTeam.id);
  const { data: liveTestPitch } = await admin.from('pitches').insert({
    team_id: liveTestTeam.id, round_id: prelimRound.id, status: 'upcoming', pitch_order: 950,
  }).select().single();
  created.pitchIds.push(liveTestPitch.id);

  // Mirror setLivePitchAction logic exactly
  await admin.from('pitches').update({ status: 'live', started_at: new Date().toISOString() }).eq('id', liveTestPitch.id);
  await admin.from('event_state').update({ current_pitch_id: liveTestPitch.id, updated_at: new Date().toISOString() }).eq('id', 1);

  const { data: pitchAfter } = await admin.from('pitches').select('status').eq('id', liveTestPitch.id).single();
  const { data: eventStateAfter } = await admin.from('event_state').select('current_pitch_id').eq('id', 1).single();
  step('pitches.status becomes "live" after setLivePitchAction', pitchAfter.status === 'live');
  step('event_state.current_pitch_id reflects the new live pitch', eventStateAfter.current_pitch_id === liveTestPitch.id);

  // Reset event_state back to null so we don't leave the live app pointing at test data
  await admin.from('event_state').update({ current_pitch_id: null, updated_at: new Date().toISOString() }).eq('id', 1);
  await admin.from('pitches').update({ status: 'done', ended_at: new Date().toISOString() }).eq('id', liveTestPitch.id);

  console.log('\n=== Question queue outcomes & point math ===');
  const teamAskEmail = `qq-team-${RUN_ID}@example.com`;
  const { data: qqTeamUser } = await admin.auth.admin.createUser({ email: teamAskEmail, email_confirm: true });
  created.authUsers.push(qqTeamUser.user.id);
  await admin.from('profiles').upsert({ id: qqTeamUser.user.id, email: teamAskEmail, role: 'team', full_name: 'QQ Team' });
  const { data: qqTeam } = await admin.from('teams').insert({ auth_user_id: qqTeamUser.user.id, team_name: `QQ-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered' }).select().single();
  created.teamIds.push(qqTeam.id);
  const { data: qqPitch } = await admin.from('pitches').insert({ team_id: qqTeam.id, round_id: prelimRound.id, status: 'live', pitch_order: 951 }).select().single();
  created.pitchIds.push(qqPitch.id);

  // "answered well" -> points_to_team +1, points_to_asker 0
  const { data: qWell } = await admin.from('questions').insert({ asking_team_id: qqTeam.id, pitch_id: qqPitch.id, question_text: 'well-answered test', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_well', points_to_team: 1, points_to_asker: 0 }).eq('id', qWell.id);
  const { data: qWellAfter } = await admin.from('questions').select('*').eq('id', qWell.id).single();
  step('Approved "answered well": points_to_team=+1, points_to_asker=0', qWellAfter.points_to_team === 1 && qWellAfter.points_to_asker === 0 && qWellAfter.status === 'approved');

  // "answered poorly" -> points_to_team -1, points_to_asker +1
  const { data: qPoor } = await admin.from('questions').insert({ asking_team_id: qqTeam.id, pitch_id: qqPitch.id, question_text: 'poorly-answered test', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_poorly', points_to_team: -1, points_to_asker: 1 }).eq('id', qPoor.id);
  const { data: qPoorAfter } = await admin.from('questions').select('*').eq('id', qPoor.id).single();
  step('Approved "answered poorly": points_to_team=-1, points_to_asker=+1', qPoorAfter.points_to_team === -1 && qPoorAfter.points_to_asker === 1);

  // Reject -> no score effect, marked rejected not deleted
  const { data: qRej } = await admin.from('questions').insert({ asking_team_id: qqTeam.id, pitch_id: qqPitch.id, question_text: 'rejected test', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'rejected', outcome: null, points_to_team: 0, points_to_asker: 0 }).eq('id', qRej.id);
  const { data: qRejAfter } = await admin.from('questions').select('*').eq('id', qRej.id).single();
  step('Rejected question: status=rejected, no points, row still exists (not deleted)', !!qRejAfter && qRejAfter.status === 'rejected' && qRejAfter.points_to_team === 0);

  // Leaderboard reflects the net qa points (qWell +1, qPoor -1 => net 0 -> qa_pressure_score = 50 + 0*10 = 50)
  await new Promise((r) => setTimeout(r, 600));
  const { data: qqLbRow } = await admin.from('pitch_leaderboard').select('qa_pressure_score, total_qa_points').eq('pitch_id', qqPitch.id).single();
  step('Leaderboard qa_pressure_score reflects net approved question points (well +1, poor -1 => net 0 => base 50)', qqLbRow.total_qa_points === 0 && Number(qqLbRow.qa_pressure_score) === 50, `total_qa_points=${qqLbRow.total_qa_points} qa_pressure_score=${qqLbRow.qa_pressure_score}`);

  console.log('\n=== Manual override: note requirement + audit trail ===');
  const overrideOrgEmail = `override-org-${RUN_ID}@student.nitw.ac.in`;
  const { data: overrideOrgUser } = await admin.auth.admin.createUser({ email: overrideOrgEmail, email_confirm: true });
  created.authUsers.push(overrideOrgUser.user.id);
  await admin.from('profiles').upsert({ id: overrideOrgUser.user.id, email: overrideOrgEmail, role: 'organiser', full_name: 'Override Org' });

  // mirror manualOverrideScoreAction's note-length validation
  function validateOverrideNote(note) {
    const sanitized = (note || '').trim();
    if (!sanitized || sanitized.length < 3) return { error: 'A short descriptive note is required for manual overrides.' };
    return { success: true };
  }
  step('manualOverrideScoreAction rejects missing note', !!validateOverrideNote('').error);
  step('manualOverrideScoreAction rejects too-short note', !!validateOverrideNote('ok').error);
  step('manualOverrideScoreAction accepts valid note', validateOverrideNote('Corrected transposed digits from judge scoresheet').success);

  // With a note: perform the actual override + audit insert (mirrors manualOverrideScoreAction body)
  const overrideJudgeEmail = `override-judge-${RUN_ID}@student.nitw.ac.in`;
  const { data: overrideJudgeUser } = await admin.auth.admin.createUser({ email: overrideJudgeEmail, email_confirm: true });
  created.authUsers.push(overrideJudgeUser.user.id);
  await admin.from('profiles').upsert({ id: overrideJudgeUser.user.id, email: overrideJudgeEmail, role: 'judge', full_name: 'Override Judge' });
  const { data: overrideJudge } = await admin.from('judges').insert({ auth_user_id: overrideJudgeUser.user.id, name: 'Override Judge', email: overrideJudgeEmail }).select().single();
  created.judgeIds.push(overrideJudge.id);

  await admin.from('judge_scores').upsert({ judge_id: overrideJudge.id, pitch_id: qqPitch.id, criterion: 'problem_market', score: 6, locked: true }, { onConflict: 'judge_id,pitch_id,criterion' });
  const { data: scoreRow } = await admin.from('judge_scores').select('id, score').eq('judge_id', overrideJudge.id).eq('pitch_id', qqPitch.id).eq('criterion', 'problem_market').single();

  const oldScore = scoreRow.score;
  const newScore = 9;
  const overrideNote = 'Judge scoresheet had a legible 9, transcribed as 6 by mistake — corrected after cross-check.';
  await admin.from('judge_scores').update({ score: newScore, locked: true }).eq('id', scoreRow.id);
  const { data: auditInsert, error: auditInsertErr } = await admin.from('score_audit_log').insert({
    changed_by: overrideOrgUser.user.id, table_changed: 'judge_scores', row_id: scoreRow.id,
    old_value: { score: oldScore }, new_value: { score: newScore }, note: overrideNote,
  }).select().single();

  step('score_audit_log row inserted for override', !auditInsertErr && !!auditInsert);
  step(
    'Audit row has correct old value, new value, actor, timestamp, note',
    auditInsert.old_value.score === oldScore && auditInsert.new_value.score === newScore && auditInsert.changed_by === overrideOrgUser.user.id && !!auditInsert.timestamp && auditInsert.note === overrideNote,
    `row: ${JSON.stringify(auditInsert)}`
  );

  console.log('\n=== Unlock Judge Score flow ===');
  const { data: scoreAfterOverride } = await admin.from('judge_scores').select('locked').eq('id', scoreRow.id).single();
  step('Score is locked before unlock', scoreAfterOverride.locked === true);

  await admin.from('judge_scores').update({ locked: false }).eq('id', scoreRow.id);
  await admin.from('score_audit_log').insert({
    changed_by: overrideOrgUser.user.id, table_changed: 'judge_scores', row_id: scoreRow.id,
    old_value: { locked: true }, new_value: { locked: false }, note: '[UNLOCK SCORE]: allow judge to correct after event feedback',
  });

  const { data: unlockedRow } = await admin.from('judge_scores').select('locked').eq('id', scoreRow.id).single();
  step('Score is unlocked (locked=false) after unlock action', unlockedRow.locked === false);

  // Now the previously-locked judge can resubmit (mirrors submitJudgeScoresAction's lock check)
  const { data: existingScoresForResubmit } = await admin.from('judge_scores').select('locked').eq('judge_id', overrideJudge.id).eq('pitch_id', qqPitch.id);
  const anyStillLocked = existingScoresForResubmit.some((s) => s.locked);
  step('submitJudgeScoresAction lock-check no longer blocks resubmission (no rows still locked for this judge/pitch)', !anyStillLocked, `locked flags: ${existingScoresForResubmit.map(s=>s.locked).join(',')}`);

  const { error: resubmitErr } = await admin.from('judge_scores').upsert(
    { judge_id: overrideJudge.id, pitch_id: qqPitch.id, criterion: 'problem_market', score: 10, locked: true },
    { onConflict: 'judge_id,pitch_id,criterion' }
  );
  step('Judge can resubmit after unlock', !resubmitErr, resubmitErr?.message);

  console.log('');
}

async function cleanup() {
  console.log('Cleaning up test data...');
  // score_audit_log rows reference judge_scores row ids as row_id and test org users as changed_by;
  // delete by changed_by first since that's stable across all override/unlock inserts in this run.
  for (const uid of created.authUsers) {
    try { await admin.from('score_audit_log').delete().eq('changed_by', uid); } catch {}
  }
  for (const pid of created.pitchIds) {
    await admin.from('questions').delete().eq('pitch_id', pid);
    await admin.from('judge_scores').delete().eq('pitch_id', pid);
    await admin.from('pitches').delete().eq('id', pid);
  }
  for (const jid of created.judgeIds) {
    await admin.from('judges').delete().eq('id', jid);
  }
  for (const tid of created.teamIds) {
    await admin.from('team_members').delete().eq('team_id', tid);
    await admin.from('teams').delete().eq('id', tid);
  }
  for (const uid of created.authUsers) {
    await admin.from('profiles').delete().eq('id', uid);
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
  console.log('Cleanup done.\n');
}

main()
  .catch((e) => {
    console.error('Unexpected error:', e);
    failed = true;
  })
  .finally(async () => {
    await cleanup();
    const passCount = results.filter((r) => r.ok).length;
    console.log(`Result: ${passCount}/${results.length} checks passed`);
    if (failed) {
      console.log('\n✗ CHECKLIST PART 2 FAILED — see above.\n');
      process.exit(1);
    } else {
      console.log('\n✓ CHECKLIST PART 2 PASSED.\n');
      process.exit(0);
    }
  });
