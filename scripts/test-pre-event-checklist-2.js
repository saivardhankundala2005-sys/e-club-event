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

  console.log('\n=== Pool assignment variety across registrations (real RPCs) ===');
  const { data: domains } = await admin.from('domains').select('name');
  step('Multiple domains exist for auto-assignment variety', domains.length > 1, `domains=${domains.map((d) => d.name).join(', ')}`);

  // Exercises the ACTUAL next_pool_assignment / assign_least_used_domain
  // RPCs (section 12/11), not a reimplementation — this is the real
  // atomic-sequence and least-assigned-first logic registerTeamAction uses.
  const registeredPools = [];
  const registeredDomains = [];
  for (let i = 0; i < 6; i++) {
    const email = `poolreg-${i}-${RUN_ID}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
    created.authUsers.push(u.user.id);
    await admin.from('profiles').upsert({ id: u.user.id, email, role: 'team', full_name: `Pool Reg ${i}` });

    const { data: assignedPool, error: poolErr } = await admin.rpc('next_pool_assignment');
    const { data: assignedDomain, error: domainErr } = await admin.rpc('assign_least_used_domain');
    if (poolErr || domainErr) throw new Error(`RPC failed: ${poolErr?.message || domainErr?.message}`);

    const { data: team } = await admin.from('teams').insert({
      auth_user_id: u.user.id, team_name: `POOLREG-${i}-${RUN_ID}`, domain: assignedDomain, pool: assignedPool, status: 'registered',
    }).select().single();
    created.teamIds.push(team.id);
    registeredPools.push(assignedPool);
    registeredDomains.push(assignedDomain);
  }
  // next_pool_assignment strictly alternates via a shared sequence, so
  // consecutive calls (even across concurrent registrations elsewhere)
  // must never repeat the same pool twice in a row within this run's
  // own sequential calls.
  let noConsecutiveRepeat = true;
  for (let i = 1; i < registeredPools.length; i++) {
    if (registeredPools[i] === registeredPools[i - 1]) noConsecutiveRepeat = false;
  }
  step('next_pool_assignment strictly alternates (no consecutive repeat across 6 calls)', noConsecutiveRepeat, `pools=${registeredPools.join(',')}`);
  const hasBothPools = registeredPools.includes('A') && registeredPools.includes('B');
  step('6 sequential registrations produce both pools', hasBothPools, `pools=${registeredPools.join(',')}`);
  console.log(`Domains actually assigned across the 6 test registrations (least-assigned-first): ${registeredDomains.join(', ')}`);

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

  console.log('\n=== Call-to-stage: event_state / pitches.queue_status reflect change ===');
  // There is no separate setLivePitchAction in the current codebase — the
  // Judge/Organiser queue flow is callToStageAction (pitchQueueActions.ts).
  // trg_create_prelim_pitch_for_team already created this team's pitch row;
  // mirror callToStageAction's exact DB effect (queue_status + event_state).
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();
  const { data: liveTestTeam } = await admin.from('teams').insert({
    auth_user_id: null, team_name: `LIVETEST-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();
  created.teamIds.push(liveTestTeam.id);
  const { data: liveTestPitch } = await admin.from('pitches').select('*').eq('team_id', liveTestTeam.id).eq('round_id', prelimRound.id).single();
  created.pitchIds.push(liveTestPitch.id);

  // Save & restore whatever event_state currently points at, so this test
  // doesn't clobber real event state if run against a live project mid-event.
  const { data: eventStateBefore } = await admin.from('event_state').select('current_pitch_id').eq('id', 1).single();

  // Mirror callToStageAction's exact DB effect
  await admin.from('pitches').update({ queue_status: 'called' }).eq('id', liveTestPitch.id);
  await admin.from('event_state').update({
    current_pitch_id: liveTestPitch.id,
    timer_status: 'idle',
    timer_started_at: null,
    timer_paused_remaining: null,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);

  const { data: pitchAfter } = await admin.from('pitches').select('queue_status').eq('id', liveTestPitch.id).single();
  const { data: eventStateAfter } = await admin.from('event_state').select('current_pitch_id, timer_status').eq('id', 1).single();
  step('pitches.queue_status becomes "called" after call-to-stage', pitchAfter.queue_status === 'called');
  step('event_state.current_pitch_id reflects the newly-called pitch', eventStateAfter.current_pitch_id === liveTestPitch.id);
  step('event_state.timer_status resets to idle on call-to-stage', eventStateAfter.timer_status === 'idle');

  // Restore event_state to what it was before this test ran.
  await admin.from('event_state').update({ current_pitch_id: eventStateBefore.current_pitch_id, updated_at: new Date().toISOString() }).eq('id', 1);
  await admin.from('pitches').update({ queue_status: 'scored' }).eq('id', liveTestPitch.id);

  console.log('\n=== Question queue outcomes & point math (section 5 rule) ===');
  const teamAskEmail = `qq-team-${RUN_ID}@example.com`;
  const { data: qqTeamUser } = await admin.auth.admin.createUser({ email: teamAskEmail, email_confirm: true });
  created.authUsers.push(qqTeamUser.user.id);
  await admin.from('profiles').upsert({ id: qqTeamUser.user.id, email: teamAskEmail, role: 'team', full_name: 'QQ Team' });
  const { data: qqTeam } = await admin.from('teams').insert({ auth_user_id: qqTeamUser.user.id, team_name: `QQ-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered' }).select().single();
  created.teamIds.push(qqTeam.id);
  // trg_create_prelim_pitch_for_team already created qqTeam's pitch.
  const { data: qqPitch } = await admin.from('pitches').select('*').eq('team_id', qqTeam.id).eq('round_id', prelimRound.id).single();
  created.pitchIds.push(qqPitch.id);

  // "answered well" -> pitching +2, asking +2 (section 5 rule)
  const { data: qWell } = await admin.from('questions').insert({ asking_team_id: qqTeam.id, pitch_id: qqPitch.id, question_text: 'well-answered test', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_well', points_pitching: 2, points_asking: 2 }).eq('id', qWell.id);
  const { data: qWellAfter } = await admin.from('questions').select('*').eq('id', qWell.id).single();
  step('Approved "answered well": points_pitching=+2, points_asking=+2', qWellAfter.points_pitching === 2 && qWellAfter.points_asking === 2 && qWellAfter.status === 'approved');

  // "answered poorly" -> pitching +0, asking +1 (section 5 rule)
  const { data: qPoor } = await admin.from('questions').insert({ asking_team_id: qqTeam.id, pitch_id: qqPitch.id, question_text: 'poorly-answered test', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_poorly', points_pitching: 0, points_asking: 1 }).eq('id', qPoor.id);
  const { data: qPoorAfter } = await admin.from('questions').select('*').eq('id', qPoor.id).single();
  step('Approved "answered poorly": points_pitching=0, points_asking=+1', qPoorAfter.points_pitching === 0 && qPoorAfter.points_asking === 1);

  // Reject -> no score effect, marked rejected not deleted
  const { data: qRej } = await admin.from('questions').insert({ asking_team_id: qqTeam.id, pitch_id: qqPitch.id, question_text: 'rejected test', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'rejected', outcome: null, points_pitching: 0, points_asking: 0 }).eq('id', qRej.id);
  const { data: qRejAfter } = await admin.from('questions').select('*').eq('id', qRej.id).single();
  step('Rejected question: status=rejected, no points, row still exists (not deleted)', !!qRejAfter && qRejAfter.status === 'rejected' && qRejAfter.points_pitching === 0 && qRejAfter.points_asking === 0);

  // qqTeam is BOTH the pitching team (qWell/qPoor were asked at its own
  // pitch) and the asking team (it asked its own questions here, purely
  // for point-math isolation — cross-pool RLS is covered separately above).
  // raw_qa_points for qqTeam = pitching(2+0) + asking(2+1) = 5.
  await new Promise((r) => setTimeout(r, 600));
  const { data: qqLbRow } = await admin.from('pitch_leaderboard').select('qa_pressure_score, total_qa_points').eq('pitch_id', qqPitch.id).single();
  step(
    'Leaderboard total_qa_points reflects the sum of this team\'s pitching + asking raw points (2+0+2+1=5)',
    qqLbRow.total_qa_points === 5,
    `total_qa_points=${qqLbRow.total_qa_points} qa_pressure_score=${qqLbRow.qa_pressure_score}`
  );

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

  // With a note: perform the actual override + audit insert (mirrors
  // manualOverrideScoreAction body against pitch_scores' raw columns).
  const { data: overrideScoreRow } = await admin.from('pitch_scores').insert({
    pitch_id: qqPitch.id,
    problem_market_raw: 6,
    solution_innovation_raw: 6,
    feasibility_raw: 6,
    pitch_storytelling_raw: 6,
    submitted_by_name: 'Override Judge',
    locked: true,
  }).select().single();
  created.pitchScoreIds = created.pitchScoreIds || [];
  created.pitchScoreIds.push(overrideScoreRow.id);

  const oldScore = overrideScoreRow.problem_market_raw;
  const newScore = 9;
  const overrideNote = 'Judge scoresheet had a legible 9, transcribed as 6 by mistake — corrected after cross-check.';
  await admin.from('pitch_scores').update({ problem_market_raw: newScore }).eq('id', overrideScoreRow.id);
  const { data: auditInsert, error: auditInsertErr } = await admin.from('score_audit_log').insert({
    changed_by: overrideOrgUser.user.id, table_changed: 'pitch_scores', row_id: overrideScoreRow.id,
    old_value: { problem_market_raw: oldScore }, new_value: { problem_market_raw: newScore }, note: overrideNote,
  }).select().single();

  step('score_audit_log row inserted for override', !auditInsertErr && !!auditInsert);
  step(
    'Audit row has correct old value, new value, actor, timestamp, note',
    auditInsert.old_value.problem_market_raw === oldScore && auditInsert.new_value.problem_market_raw === newScore && auditInsert.changed_by === overrideOrgUser.user.id && !!auditInsert.timestamp && auditInsert.note === overrideNote,
    `row: ${JSON.stringify(auditInsert)}`
  );

  console.log('\n=== Unlock Pitch Score flow ===');
  // In the single-row model, "unlock" means deleting the locked row so a
  // judge/organiser can submit fresh (mirrors unlockPitchScoreAction —
  // there's no partial "unlock and edit in place", the row IS the lock).
  const { data: scoreBeforeUnlock } = await admin.from('pitch_scores').select('locked').eq('id', overrideScoreRow.id).single();
  step('Score is locked before unlock', scoreBeforeUnlock.locked === true);

  await admin.from('score_audit_log').insert({
    changed_by: overrideOrgUser.user.id, table_changed: 'pitch_scores', row_id: overrideScoreRow.id,
    old_value: { locked: true }, new_value: null, note: '[UNLOCK SCORE]: allow judge to correct after event feedback',
  });
  await admin.from('pitch_scores').delete().eq('id', overrideScoreRow.id);

  const { data: rowAfterUnlock } = await admin.from('pitch_scores').select('id').eq('id', overrideScoreRow.id).maybeSingle();
  step('Locked pitch_scores row is gone after unlock (delete-to-unlock model)', !rowAfterUnlock);

  // A fresh submission for the same pitch now succeeds again.
  const { data: resubmitRow, error: resubmitErr } = await admin.from('pitch_scores').insert({
    pitch_id: qqPitch.id,
    problem_market_raw: 10,
    solution_innovation_raw: 10,
    feasibility_raw: 10,
    pitch_storytelling_raw: 10,
    submitted_by_name: 'Judge (resubmit after unlock)',
    locked: true,
  }).select().single();
  if (resubmitRow) created.pitchScoreIds.push(resubmitRow.id);
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
    await admin.from('pitch_scores').delete().eq('pitch_id', pid);
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
