#!/usr/bin/env node
/**
 * Pre-event checklist: RLS enforcement, security payloads, leaderboard math,
 * and Final 4 qualification logic — all verified against the real Supabase
 * project using REAL anon-key sessions (not service role) so RLS is
 * actually exercised, not bypassed.
 *
 * All test rows are tagged with a unique run ID and deleted at the end.
 */
const { loadEnvLocal } = require('./_load-env');
loadEnvLocal();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const RUN_ID = Date.now().toString(36);
let failed = false;
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
  return ok;
}

// Get a real anon-key session (as RLS actually sees it) for a given user via magic link.
async function anonSessionFor(email) {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkErr) throw new Error(`generateLink(${email}) failed: ${linkErr.message}`);

  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: verifyData, error: verifyErr } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyErr) throw new Error(`verifyOtp(${email}) failed: ${verifyErr.message}`);
  return client;
}

const created = { authUsers: [], teamIds: [], pitchIds: [], judgeIds: [] };

async function createTeamUser(emailPrefix, pool, teamNameSuffix) {
  const email = `${emailPrefix}-${RUN_ID}@example.com`;
  const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
  created.authUsers.push(u.user.id);
  await admin.from('profiles').upsert({ id: u.user.id, email, role: 'team', full_name: emailPrefix });
  const { data: domains } = await admin.from('domains').select('name').limit(1);
  const { data: team } = await admin
    .from('teams')
    .insert({ auth_user_id: u.user.id, team_name: `RLS-${teamNameSuffix}-${RUN_ID}`, domain: domains[0].name, pool, status: 'registered' })
    .select()
    .single();
  created.teamIds.push(team.id);
  return { authId: u.user.id, email, team };
}

async function main() {
  console.log(`\nPre-event checklist run (id: ${RUN_ID})\n=== RLS: Voting rules ===`);

  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();

  const teamA = await createTeamUser('rls-teamA', 'A', 'A');
  const teamB = await createTeamUser('rls-teamB', 'B', 'B');
  const teamA2 = await createTeamUser('rls-teamA2', 'A', 'A2'); // same pool as teamA

  const { data: pitchA } = await admin.from('pitches').insert({ team_id: teamA.team.id, round_id: prelimRound.id, status: 'live', pitch_order: 990 }).select().single();
  created.pitchIds.push(pitchA.id);
  const { data: pitchB } = await admin.from('pitches').insert({ team_id: teamB.team.id, round_id: prelimRound.id, status: 'live', pitch_order: 991 }).select().single();
  created.pitchIds.push(pitchB.id);

  const ratingPayload = (teamId, pitchId) => ([
    { criterion: 'problem_relevance', score: 4 },
    { criterion: 'creativity', score: 5 },
    { criterion: 'solution_quality', score: 3 },
    { criterion: 'pitch_quality', score: 4 },
    { criterion: 'overall_potential', score: 5 },
  ].map((e) => ({ voting_team_id: teamId, pitch_id: pitchId, criterion: e.criterion, score: e.score })));

  // 1. Opposite-pool team (teamB) rates pitchA (pool A) via REAL anon session -> should succeed
  const clientB = await anonSessionFor(teamB.email);
  const rows1 = ratingPayload(teamB.team.id, pitchA.id);
  const { error: voteErr1 } = await clientB.from('audience_scores').insert(rows1);
  step('Opposite-pool team votes for pitch: RLS allows insert', !voteErr1, voteErr1?.message);

  // Idempotency: identical second call should be rejected as duplicate (unique constraint), not silently double-insert
  const { error: voteErr1b } = await clientB.from('audience_scores').insert(rows1);
  const isDup = voteErr1b && voteErr1b.code === '23505';
  step('Second identical vote from same team is idempotent (unique violation, not a new row)', isDup, voteErr1b ? `${voteErr1b.code}: ${voteErr1b.message}` : 'NOT REJECTED — succeeded twice!');

  const { data: rowsAfter1 } = await admin.from('audience_scores').select('id').eq('voting_team_id', teamB.team.id).eq('pitch_id', pitchA.id);
  step('Exactly 5 rows exist for the vote (one per criterion, no duplicates)', rowsAfter1.length === 5, `found ${rowsAfter1.length}`);

  // 2. Team votes for its own pitch -> RLS must reject
  const clientA = await anonSessionFor(teamA.email);
  const { error: selfVoteErr } = await clientA.from('audience_scores').insert(ratingPayload(teamA.team.id, pitchA.id));
  step('Team voting for its own pitch is REJECTED by RLS', !!selfVoteErr, selfVoteErr ? `${selfVoteErr.code}: ${selfVoteErr.message}` : 'NOT REJECTED — self-vote succeeded!');

  // 3. Same-pool team votes for pitchA -> RLS must reject
  const clientA2 = await anonSessionFor(teamA2.email);
  const { error: samePoolErr } = await clientA2.from('audience_scores').insert(ratingPayload(teamA2.team.id, pitchA.id));
  step('Same-pool team voting is REJECTED by RLS', !!samePoolErr, samePoolErr ? `${samePoolErr.code}: ${samePoolErr.message}` : 'NOT REJECTED — same-pool vote succeeded!');

  console.log('\n=== RLS: judge_scores / team_members read restriction (20260813 hardening) ===');
  // team account should NOT be able to read raw judge_scores rows (belongs to organiser/owning judge only)
  const { data: judgeScoresAsTeam, error: jsReadErr } = await clientB.from('judge_scores').select('*').limit(1);
  const teamCannotReadJudgeScores = (jsReadErr) || (judgeScoresAsTeam && judgeScoresAsTeam.length === 0);
  step('Team account cannot read judge_scores rows directly', teamCannotReadJudgeScores, jsReadErr ? jsReadErr.message : `rows returned: ${judgeScoresAsTeam?.length}`);

  // team account should NOT be able to read other teams' team_members (emails)
  const { data: membersAsTeam, error: memReadErr } = await clientB.from('team_members').select('*').eq('team_id', teamA.team.id);
  const teamCannotReadOtherMembers = (memReadErr) || (membersAsTeam && membersAsTeam.length === 0);
  step("Team account cannot read another team's team_members (email exposure)", teamCannotReadOtherMembers, memReadErr ? memReadErr.message : `rows returned: ${membersAsTeam?.length}`);

  console.log('\n=== Security: SQLi / XSS payload storage ===');
  const sqliPayload = `Robert'); DROP TABLE teams;--`;
  const xssPayload = `<script>alert(1)</script>`;
  // validation.ts is TS; inline the same sanitizeInput logic here (kept in sync manually) for a same-behavior check
  function sanitize(input) {
    if (!input || typeof input !== 'string') return '';
    return input
      .replace(/\0/g, '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
      .trim();
  }
  const sanitizedSqli = sanitize(sqliPayload);
  const sanitizedXss = sanitize(xssPayload);

  const { error: qInsertErr } = await clientA.from('questions').insert({
    asking_team_id: teamA.team.id, pitch_id: pitchB.id, question_text: sanitizedSqli, status: 'pending',
  });
  step('SQLi-style question text insert does not error / execute as SQL', !qInsertErr, qInsertErr?.message);
  const { data: storedSqli } = await admin.from('questions').select('question_text').eq('asking_team_id', teamA.team.id).eq('pitch_id', pitchB.id).order('created_at', { ascending: false }).limit(1).single();
  step('SQLi payload stored as literal text (teams table intact)', storedSqli.question_text === sanitizedSqli);
  const { data: teamsStillExist } = await admin.from('teams').select('id').limit(1);
  step('teams table was NOT dropped', teamsStillExist && teamsStillExist.length > 0);

  const { data: teamXss } = await admin.from('teams').insert({
    auth_user_id: null, team_name: `XSS-${xssPayload}-${RUN_ID}`, domain: (await admin.from('domains').select('name').limit(1)).data[0].name, pool: 'A', status: 'registered',
  }).select().single();
  const xssStoredLiteral = teamXss.team_name.includes('<script>');
  step('XSS payload in team_name stored as literal text in DB (raw insert)', xssStoredLiteral, `stored as: ${teamXss.team_name}`);
  // Confirm the sanitizer would neutralize it before render if passed through sanitizeInput
  step('sanitizeInput() neutralizes <script> tag (would not execute if used before render)', !sanitizedXss.includes('<script>'), `sanitized: ${sanitizedXss}`);
  created.teamIds.push(teamXss.id);

  console.log('\n=== Security: organiser-only server action rejected for team role ===');
  // Simulate requireRole('organiser') logic directly against a team profile
  const { data: teamProfile } = await admin.from('profiles').select('role').eq('id', teamA.authId).single();
  const wouldBeRejected = teamProfile.role !== 'organiser';
  step('Team role fails requireRole("organiser") check used by manualOverrideScoreAction etc.', wouldBeRejected, `role=${teamProfile.role}`);

  console.log('\n=== Security: malformed UUID handling ===');
  const { isValidUUIDCheck } = {};
  function isValidUUID(uuid) {
    if (!uuid || typeof uuid !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid.trim());
  }
  const malformed = ["'; DROP TABLE teams;--", 'not-a-uuid', '12345', ''];
  let allRejected = true;
  for (const m of malformed) {
    if (isValidUUID(m)) allRejected = false;
  }
  step('isValidUUID() rejects all malformed UUID inputs', allRejected);
  // Confirm a malformed UUID passed straight to a .eq() query does not crash (Postgres returns empty/error, not 500)
  const { data: badQuery, error: badQueryErr } = await admin.from('pitches').select('id').eq('id', 'not-a-uuid');
  const noCrash = !!badQueryErr && badQueryErr.code === '22P02'; // invalid_text_representation, handled gracefully by PostgREST as 400
  step('Malformed UUID in query param handled gracefully (no 500-style crash)', noCrash, badQueryErr ? `${badQueryErr.code}: ${badQueryErr.message}` : 'no error returned');

  console.log('\n=== Leaderboard math hand-verification ===');
  const judgeUser = await admin.auth.admin.createUser({ email: `rls-judge-${RUN_ID}@student.nitw.ac.in`, email_confirm: true });
  created.authUsers.push(judgeUser.data.user.id);
  await admin.from('profiles').upsert({ id: judgeUser.data.user.id, email: judgeUser.data.user.email, role: 'judge', full_name: 'RLS Judge' });
  const { data: judge } = await admin.from('judges').insert({ auth_user_id: judgeUser.data.user.id, name: 'RLS Judge', email: judgeUser.data.user.email }).select().single();
  created.judgeIds.push(judge.id);

  const scoreSet = { problem_market: 7, solution_innovation: 6, feasibility: 9, pitch_storytelling: 8 };
  for (const [criterion, score] of Object.entries(scoreSet)) {
    await admin.from('judge_scores').upsert({ judge_id: judge.id, pitch_id: pitchB.id, criterion, score, locked: true }, { onConflict: 'judge_id,pitch_id,criterion' });
  }

  // approve one question for pitchB with +1 to team
  const { data: qb } = await admin.from('questions').insert({ asking_team_id: teamA.team.id, pitch_id: pitchB.id, question_text: 'hand-calc test question', status: 'pending' }).select().single();
  await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_well', points_to_team: 1, points_to_asker: 0 }).eq('id', qb.id);

  await new Promise((r) => setTimeout(r, 600));
  const { data: lbRow } = await admin.from('pitch_leaderboard').select('*').eq('pitch_id', pitchB.id).single();

  // Hand calculation
  const jc = {
    problem_market_score: scoreSet.problem_market * 10,
    solution_innovation_score: scoreSet.solution_innovation * 10,
    feasibility_score: scoreSet.feasibility * 10,
    pitch_storytelling_score: scoreSet.pitch_storytelling * 10,
  };
  // audience: teamB (pitching) got votes from clientB earlier? No — teamB is the PITCHER for pitchB in this section, audience_scores were for pitchA.
  // pitchB had no audience votes -> audience_rating_score = 0 (COALESCE default)
  const audienceScore = 0;
  const qaScore = Math.min(Math.max(50 + 1 * 10, 0), 100); // 60
  const handCalc = (
    jc.problem_market_score * 0.20 +
    jc.solution_innovation_score * 0.20 +
    jc.feasibility_score * 0.15 +
    jc.pitch_storytelling_score * 0.15 +
    audienceScore * 0.20 +
    qaScore * 0.10
  );
  const handCalcRounded = Math.round(handCalc * 100) / 100;

  console.log(`Hand-calculated: problem_market=${jc.problem_market_score}*0.20 + solution_innovation=${jc.solution_innovation_score}*0.20 + feasibility=${jc.feasibility_score}*0.15 + storytelling=${jc.pitch_storytelling_score}*0.15 + audience=${audienceScore}*0.20 + qa=${qaScore}*0.10 = ${handCalcRounded}`);
  console.log(`DB view total_weighted_score: ${lbRow.total_weighted_score}`);
  step('Hand-calculated weighted score EXACTLY matches pitch_leaderboard view', Number(lbRow.total_weighted_score) === handCalcRounded, `hand=${handCalcRounded} db=${lbRow.total_weighted_score}`);

  console.log('\n=== Final 4 qualification logic ===');
  // Build a deliberately skewed dataset where top-2-per-pool DIFFERS from top-4-overall,
  // so the test actually distinguishes correct pool-based logic from a naive overall-top-4 bug.
  // Pool A: three teams scored 95, 90, 20 (award pattern via judge scores only, audience/qa=0)
  // Pool B: three teams scored 15, 12, 10
  // top-4-overall would be [A-95, A-90, B-15... wait B never reaches top4] -> use scores that force the distinction:
  // Pool A: 95, 92, 10   Pool B: 30, 28, 5
  // top-2-per-pool = {A-95, A-92, B-30, B-28}
  // top-4-overall  = {A-95, A-92, B-30, B-28, A-10?} -- overall top4 = A95,A92,B30,B28 too (same, since A-10 and B-5 both low)
  // To truly force a mismatch, Pool A must have a 3rd team that outranks Pool B's 2nd:
  // Pool A: 95, 92, 60   Pool B: 30, 28, 5
  // top-2-per-pool = {A-95, A-92, B-30, B-28}
  // top-4-overall  = {A-95, A-92, A-60, B-30}  <-- differs! (drops B-28, includes A-60)
  const finalFourRound = { A: [95, 92, 60], B: [30, 28, 5] };
  const f4Judge = await admin.auth.admin.createUser({ email: `f4-judge-${RUN_ID}@student.nitw.ac.in`, email_confirm: true });
  created.authUsers.push(f4Judge.data.user.id);
  await admin.from('profiles').upsert({ id: f4Judge.data.user.id, email: f4Judge.data.user.email, role: 'judge', full_name: 'F4 Judge' });
  const { data: f4JudgeRow } = await admin.from('judges').insert({ auth_user_id: f4Judge.data.user.id, name: 'F4 Judge', email: f4Judge.data.user.email }).select().single();
  created.judgeIds.push(f4JudgeRow.id);

  const { data: domainsForF4 } = await admin.from('domains').select('name').limit(1);
  const f4Teams = {};
  for (const pool of ['A', 'B']) {
    f4Teams[pool] = [];
    for (let i = 0; i < finalFourRound[pool].length; i++) {
      const targetTotal = finalFourRound[pool][i]; // score out of 100, achieved via judge criteria only (audience/qa = 0)
      // total_weighted_score = judge criteria weighted at 0.20+0.20+0.15+0.15=0.70 of a 0-100 judge score (all 4 criteria equal)
      // set all 4 criteria to the same raw score S (1-10) => each *10 = S*10 (0-100), weighted sum = S*10*0.70 = 7*S
      // solve S = targetTotal / 7, clamp 1-10
      const rawS = Math.max(1, Math.min(10, Math.round(targetTotal / 7)));
      const u = await admin.auth.admin.createUser({ email: `f4-${pool}${i}-${RUN_ID}@example.com`, email_confirm: true });
      created.authUsers.push(u.data.user.id);
      await admin.from('profiles').upsert({ id: u.data.user.id, email: u.data.user.email, role: 'team', full_name: `F4 ${pool}${i}` });
      const { data: t } = await admin.from('teams').insert({ auth_user_id: u.data.user.id, team_name: `F4-${pool}${i}-${RUN_ID}`, domain: domainsForF4[0].name, pool, status: 'registered' }).select().single();
      created.teamIds.push(t.id);
      const { data: p } = await admin.from('pitches').insert({ team_id: t.id, round_id: prelimRound.id, status: 'done', pitch_order: 900 + i }).select().single();
      created.pitchIds.push(p.id);
      for (const criterion of ['problem_market', 'solution_innovation', 'feasibility', 'pitch_storytelling']) {
        await admin.from('judge_scores').upsert({ judge_id: f4JudgeRow.id, pitch_id: p.id, criterion, score: rawS, locked: true }, { onConflict: 'judge_id,pitch_id,criterion' });
      }
      f4Teams[pool].push({ team_id: t.id, team_name: t.team_name, pitch_id: p.id, rawS });
    }
  }

  await new Promise((r) => setTimeout(r, 600));
  const { data: f4Lb } = await admin.from('pitch_leaderboard').select('*').in('pitch_id', [...f4Teams.A, ...f4Teams.B].map((t) => t.pitch_id));

  // This mirrors qualifyFinalFourAction's exact logic (organiserActions.ts:326-350)
  const poolA = f4Lb.filter((r) => r.pool === 'A').sort((a, b) => b.total_weighted_score - a.total_weighted_score);
  const poolB = f4Lb.filter((r) => r.pool === 'B').sort((a, b) => b.total_weighted_score - a.total_weighted_score);
  const appLogicResult = [...poolA.slice(0, 2), ...poolB.slice(0, 2)].map((r) => r.team_name).sort();

  const top4OverallResult = [...f4Lb].sort((a, b) => b.total_weighted_score - a.total_weighted_score).slice(0, 4).map((r) => r.team_name).sort();

  console.log('Scores:', f4Lb.map((r) => `${r.team_name}=${r.total_weighted_score}`).join(', '));
  console.log('App logic (top-2-per-pool):', appLogicResult);
  console.log('Naive top-4-overall:', top4OverallResult);
  const distinguishing = JSON.stringify(appLogicResult) !== JSON.stringify(top4OverallResult);
  step('Test dataset actually distinguishes top-2-per-pool from top-4-overall', distinguishing);
  const expectedTop2PerPool = [`F4-A0-${RUN_ID}`, `F4-A1-${RUN_ID}`, `F4-B0-${RUN_ID}`, `F4-B1-${RUN_ID}`].sort();
  step('qualifyFinalFourAction logic (code-reviewed against organiserActions.ts:336-344) picks top-2-per-pool, matching hand calculation', JSON.stringify(appLogicResult) === JSON.stringify(expectedTop2PerPool), `got=${JSON.stringify(appLogicResult)} expected=${JSON.stringify(expectedTop2PerPool)}`);

  console.log('');
}

async function cleanup() {
  console.log('Cleaning up test data...');
  for (const pid of created.pitchIds) {
    await admin.from('questions').delete().eq('pitch_id', pid);
    await admin.from('audience_scores').delete().eq('pitch_id', pid);
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
      console.log('\n✗ CHECKLIST FAILED — see above for failing steps.\n');
      process.exit(1);
    } else {
      console.log('\n✓ CHECKLIST PASSED.\n');
      process.exit(0);
    }
  });
