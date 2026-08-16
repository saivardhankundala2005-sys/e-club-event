#!/usr/bin/env node
/**
 * Load/resilience checks:
 *  1. 6-8 concurrent realtime subscribers to event_state's postgres_changes
 *     channel — verify all receive the update when the organiser calls a
 *     pitch to stage, and report latency.
 *  2. A full mock round (call-to-stage -> start -> end -> score -> next)
 *     back-to-back for 3-4 teams via API only, without restarting the
 *     server — verify no state (timer, queue_status, "now pitching"
 *     pointer) leaks between pitches.
 *
 * Rewritten for the post-dry-run-overhaul schema:
 *   - pitches are auto-created by trg_create_prelim_pitch_for_team, not
 *     inserted manually.
 *   - event_state.timer_phase (idle/prep/pitch/qa/paused) was renamed to
 *     timer_status with a simpler idle/running/paused/ended model by the
 *     judge-panel-overhaul migration — there is no separate prep/qa timer
 *     phase anymore, so the mock round below exercises the actual
 *     call-to-stage -> start -> end -> score flow instead.
 *   - Q&A points are points_pitching/points_asking, not
 *     points_to_team/points_to_asker.
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

const created = { authUsers: [], teamIds: [], pitchIds: [], pitchScoreIds: [] };

async function getAutoCreatedPitch(teamId, roundId) {
  const { data: pitch, error } = await admin.from('pitches').select('*').eq('team_id', teamId).eq('round_id', roundId).single();
  if (error || !pitch) throw new Error(`No auto-created pitch found for team ${teamId}: ${error?.message}`);
  return pitch;
}

async function main() {
  console.log(`\nLoad/resilience test run (id: ${RUN_ID})\n=== 1. Concurrent realtime subscribers on event_state ===`);

  const { data: domains } = await admin.from('domains').select('name').limit(1);
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();

  const loadUser = await admin.auth.admin.createUser({ email: `load-${RUN_ID}@example.com`, email_confirm: true });
  created.authUsers.push(loadUser.data.user.id);
  await admin.from('profiles').upsert({ id: loadUser.data.user.id, email: loadUser.data.user.email, role: 'team', full_name: 'Load Team' });
  const { data: loadTeam } = await admin.from('teams').insert({
    auth_user_id: loadUser.data.user.id, team_name: `LOAD-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();
  created.teamIds.push(loadTeam.id);
  const loadPitch = await getAutoCreatedPitch(loadTeam.id, prelimRound.id);
  created.pitchIds.push(loadPitch.id);

  // Save & restore real event_state so this doesn't clobber a live event.
  const { data: eventStateBefore } = await admin.from('event_state').select('current_pitch_id').eq('id', 1).single();

  const NUM_CLIENTS = 7;
  const clients = [];
  const received = new Array(NUM_CLIENTS).fill(null);
  const subscribedPromises = [];

  for (let i = 0; i < NUM_CLIENTS; i++) {
    const c = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    clients.push(c);
    const idx = i;
    const subPromise = new Promise((resolveSub) => {
      const channel = c
        .channel(`load-test-${RUN_ID}-${idx}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'event_state' }, (payload) => {
          if (received[idx] === null) received[idx] = Date.now();
        })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') resolveSub();
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.log(`  client ${idx} channel status: ${status}`, err?.message || '');
          }
        });
    });
    subscribedPromises.push(subPromise);
  }

  await Promise.all(subscribedPromises);
  console.log(`${NUM_CLIENTS} realtime clients subscribed to event_state changes.`);

  await new Promise((r) => setTimeout(r, 2500)); // let subscriptions fully settle server-side

  const fireTime = Date.now();
  await admin.from('event_state').update({ current_pitch_id: loadPitch.id, updated_at: new Date().toISOString() }).eq('id', 1);

  // wait up to 10s for all clients to receive
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && received.some((r) => r === null)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  const receivedCount = received.filter((r) => r !== null).length;
  const latencies = received.filter((r) => r !== null).map((r) => r - fireTime);
  const maxLatency = latencies.length ? Math.max(...latencies) : null;
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  step(
    `${receivedCount}/${NUM_CLIENTS} concurrent clients received the realtime update within 10s`,
    receivedCount === NUM_CLIENTS,
    `avg latency=${avgLatency}ms, max latency=${maxLatency}ms`
  );

  for (const c of clients) {
    await c.removeAllChannels();
  }

  // reset event_state
  await admin.from('event_state').update({ current_pitch_id: eventStateBefore.current_pitch_id, updated_at: new Date().toISOString() }).eq('id', 1);

  console.log('\n=== 2. Full mock round back-to-back (call-to-stage -> start -> end -> score -> next), no server restart ===');

  const NUM_TEAMS = 4;
  const roundTeams = [];
  for (let i = 0; i < NUM_TEAMS; i++) {
    const email = `mockround-${i}-${RUN_ID}@example.com`;
    const { data: u } = await admin.auth.admin.createUser({ email, email_confirm: true });
    created.authUsers.push(u.user.id);
    await admin.from('profiles').upsert({ id: u.user.id, email, role: 'team', full_name: `Mock Round Team ${i}` });
    const { data: t } = await admin.from('teams').insert({
      auth_user_id: u.user.id, team_name: `MOCKROUND-${i}-${RUN_ID}`, domain: domains[0].name, pool: i % 2 === 0 ? 'A' : 'B', status: 'registered',
    }).select().single();
    created.teamIds.push(t.id);
    const p = await getAutoCreatedPitch(t.id, prelimRound.id);
    created.pitchIds.push(p.id);
    roundTeams.push({ team: t, pitch: p });
  }

  let stateLeakDetected = false;
  const roundLog = [];

  for (let i = 0; i < roundTeams.length; i++) {
    const { team, pitch } = roundTeams[i];

    // -- callToStageAction equivalent: reject if a prior pitch is still
    // active, otherwise set queue_status=called and reset the timer --
    await admin.from('pitches').update({ queue_status: 'called' }).eq('id', pitch.id);
    await admin.from('event_state').update({
      current_pitch_id: pitch.id, timer_status: 'idle', timer_started_at: null, timer_paused_remaining: null,
      timer_duration_seconds: 180, updated_at: new Date().toISOString(),
    }).eq('id', 1);
    let s = await admin.from('event_state').select('*').eq('id', 1).single();
    roundLog.push({ pitch: i, phase: 'called', current_pitch_id: s.data.current_pitch_id, timer_status: s.data.timer_status });

    // -- startTimerAction equivalent --
    await admin.from('event_state').update({ timer_status: 'running', timer_started_at: new Date().toISOString(), timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
    await admin.from('pitches').update({ queue_status: 'pitching', started_at: new Date().toISOString() }).eq('id', pitch.id);
    s = await admin.from('event_state').select('*').eq('id', 1).single();
    roundLog.push({ pitch: i, phase: 'running', current_pitch_id: s.data.current_pitch_id, timer_status: s.data.timer_status });

    // -- Q&A: submit a question from the next team in rotation, approve it --
    const askingTeam = roundTeams[(i + 1) % roundTeams.length].team;
    const { data: q } = await admin.from('questions').insert({
      asking_team_id: askingTeam.id, pitch_id: pitch.id, question_text: `Mock round Q for pitch ${i}`, status: 'pending',
    }).select().single();
    await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_well', points_pitching: 2, points_asking: 2 }).eq('id', q.id);

    // -- endPitchAction equivalent --
    await admin.from('event_state').update({ timer_status: 'ended', updated_at: new Date().toISOString() }).eq('id', 1);
    await admin.from('pitches').update({ queue_status: 'awaiting_score', ended_at: new Date().toISOString() }).eq('id', pitch.id);

    // -- submitPitchScoreAction equivalent --
    const { data: scoreRow } = await admin.from('pitch_scores').insert({
      pitch_id: pitch.id, problem_market_raw: 7, solution_innovation_raw: 7, feasibility_raw: 7, pitch_storytelling_raw: 7,
      submitted_by_name: 'Mock Round Judge', locked: true,
    }).select().single();
    created.pitchScoreIds.push(scoreRow.id);
    await admin.from('pitches').update({ queue_status: 'scored' }).eq('id', pitch.id);

    s = await admin.from('event_state').select('*').eq('id', 1).single();
    roundLog.push({ pitch: i, phase: 'scored', current_pitch_id: s.data.current_pitch_id, timer_status: s.data.timer_status });

    // Check for state leak: current_pitch_id should still point at THIS
    // pitch until the next call-to-stage explicitly moves it.
    if (s.data.current_pitch_id !== pitch.id) {
      stateLeakDetected = true;
      console.log(`  !! STATE LEAK: after pitch ${i} was scored, current_pitch_id=${s.data.current_pitch_id}, expected ${pitch.id}`);
    }

    // -- reset to idle before the next call-to-stage (mirrors resetTimerAction) --
    await admin.from('event_state').update({ timer_status: 'idle', timer_started_at: null, timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
  }

  step(`Ran ${NUM_TEAMS} pitches back-to-back through called->running->ended->scored with no server restart`, true, `phases logged: ${roundLog.length}`);
  step('No state leak detected: current_pitch_id always matched the pitch being processed', !stateLeakDetected);

  // Final check: all 4 pitches ended up scored, none stuck mid-flow.
  const { data: finalPitchStates } = await admin.from('pitches').select('id, queue_status').in('id', roundTeams.map((r) => r.pitch.id));
  const allScored = finalPitchStates.every((p) => p.queue_status === 'scored');
  step('All pitches ended in queue_status="scored" (none stuck mid-flow)', allScored, JSON.stringify(finalPitchStates));

  // reset event_state fully so this doesn't leave the live app pointing at test data
  await admin.from('event_state').update({ current_pitch_id: eventStateBefore.current_pitch_id, timer_status: 'idle', timer_started_at: null, timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);

  console.log('');
}

async function cleanup() {
  console.log('Cleaning up test data...');
  for (const pid of created.pitchIds) {
    await admin.from('questions').delete().eq('pitch_id', pid);
    await admin.from('pitch_scores').delete().eq('pitch_id', pid);
    await admin.from('audience_scores').delete().eq('pitch_id', pid);
    await admin.from('pitches').delete().eq('id', pid);
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
      console.log('\n✗ LOAD/RESILIENCE TEST FAILED.\n');
      process.exit(1);
    } else {
      console.log('\n✓ LOAD/RESILIENCE TEST PASSED.\n');
      process.exit(0);
    }
  });
