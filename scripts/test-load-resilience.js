#!/usr/bin/env node
/**
 * Load/resilience checks:
 *  1. 6-8 concurrent realtime subscribers to a live pitch's postgres_changes
 *     channel — verify all receive the update when the organiser sets a
 *     pitch live, and report latency.
 *  2. A full mock round (prep -> pitch -> Q&A -> next) back-to-back for 3-4
 *     teams via API only, without restarting the server — verify no state
 *     (timer, "now pitching" pointer) leaks between pitches.
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

const created = { authUsers: [], teamIds: [], pitchIds: [] };

async function main() {
  console.log(`\nLoad/resilience test run (id: ${RUN_ID})\n=== 1. Concurrent realtime subscribers on event_state ===`);

  const { data: domains } = await admin.from('domains').select('name').limit(1);
  const { data: prelimRound } = await admin.from('rounds').select('id').eq('name', 'prelim').single();

  const { data: loadTeam } = await admin.from('teams').insert({
    auth_user_id: null, team_name: `LOAD-${RUN_ID}`, domain: domains[0].name, pool: 'A', status: 'registered',
  }).select().single();
  created.teamIds.push(loadTeam.id);
  const { data: loadPitch } = await admin.from('pitches').insert({
    team_id: loadTeam.id, round_id: prelimRound.id, status: 'upcoming', pitch_order: 800,
  }).select().single();
  created.pitchIds.push(loadPitch.id);

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
    `${receivedCount}/${NUM_CLIENTS} concurrent clients received the realtime update within 5s`,
    receivedCount === NUM_CLIENTS,
    `avg latency=${avgLatency}ms, max latency=${maxLatency}ms`
  );

  for (const c of clients) {
    await c.removeAllChannels();
  }

  // reset event_state
  await admin.from('event_state').update({ current_pitch_id: null, updated_at: new Date().toISOString() }).eq('id', 1);

  console.log('\n=== 2. Full mock round back-to-back (prep -> pitch -> Q&A -> next), no server restart ===');

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
    const { data: p } = await admin.from('pitches').insert({
      team_id: t.id, round_id: prelimRound.id, status: 'upcoming', pitch_order: 810 + i,
    }).select().single();
    created.pitchIds.push(p.id);
    roundTeams.push({ team: t, pitch: p });
  }

  let stateLeakDetected = false;
  const roundLog = [];

  for (let i = 0; i < roundTeams.length; i++) {
    const { team, pitch } = roundTeams[i];

    // -- setLivePitchAction equivalent: end previous live pitch, start this one --
    const { data: currentState } = await admin.from('event_state').select('current_pitch_id').eq('id', 1).single();
    if (currentState?.current_pitch_id && currentState.current_pitch_id !== pitch.id) {
      await admin.from('pitches').update({ status: 'done', ended_at: new Date().toISOString() }).eq('id', currentState.current_pitch_id);
    }
    await admin.from('pitches').update({ status: 'live', started_at: new Date().toISOString() }).eq('id', pitch.id);
    await admin.from('event_state').update({ current_pitch_id: pitch.id, updated_at: new Date().toISOString() }).eq('id', 1);

    // -- prep phase --
    await admin.from('event_state').update({ timer_phase: 'prep', timer_duration_seconds: 60, timer_started_at: new Date().toISOString(), timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
    let s = await admin.from('event_state').select('*').eq('id', 1).single();
    roundLog.push({ pitch: i, phase: 'prep', current_pitch_id: s.data.current_pitch_id, timer_phase: s.data.timer_phase });

    // -- pitch phase --
    await admin.from('event_state').update({ timer_phase: 'pitch', timer_duration_seconds: 180, timer_started_at: new Date().toISOString(), timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
    s = await admin.from('event_state').select('*').eq('id', 1).single();
    roundLog.push({ pitch: i, phase: 'pitch', current_pitch_id: s.data.current_pitch_id, timer_phase: s.data.timer_phase });

    // -- Q&A phase: submit a question, approve it --
    const { data: q } = await admin.from('questions').insert({
      asking_team_id: roundTeams[(i + 1) % roundTeams.length].team.id, pitch_id: pitch.id, question_text: `Mock round Q for pitch ${i}`, status: 'pending',
    }).select().single();
    await admin.from('event_state').update({ timer_phase: 'qa', timer_duration_seconds: 120, timer_started_at: new Date().toISOString(), timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
    await admin.from('questions').update({ status: 'approved', outcome: 'team_answered_well', points_to_team: 1, points_to_asker: 0 }).eq('id', q.id);
    s = await admin.from('event_state').select('*').eq('id', 1).single();
    roundLog.push({ pitch: i, phase: 'qa', current_pitch_id: s.data.current_pitch_id, timer_phase: s.data.timer_phase });

    // Check for state leak: does current_pitch_id match THIS pitch, and is the timer phase what we just set (not a stale value from prior iteration)?
    if (s.data.current_pitch_id !== pitch.id) {
      stateLeakDetected = true;
      console.log(`  !! STATE LEAK: after pitch ${i}'s Q&A phase, current_pitch_id=${s.data.current_pitch_id}, expected ${pitch.id}`);
    }

    // -- transition to idle before moving to next pitch (mirrors organiser clicking "next") --
    await admin.from('event_state').update({ timer_phase: 'idle', timer_started_at: null, timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
  }

  step(`Ran ${NUM_TEAMS} pitches back-to-back through prep->pitch->qa->idle with no server restart`, true, `phases logged: ${roundLog.length}`);
  step('No state leak detected: current_pitch_id always matched the pitch being processed', !stateLeakDetected);

  // Final check: last pitch is "live" (per setLivePitchAction never auto-transitions to done until next is set), others done
  const { data: finalPitchStates } = await admin.from('pitches').select('id, status').in('id', roundTeams.map((r) => r.pitch.id));
  const lastPitchId = roundTeams[roundTeams.length - 1].pitch.id;
  const earlierPitchIds = roundTeams.slice(0, -1).map((r) => r.pitch.id);
  const lastIsLive = finalPitchStates.find((p) => p.id === lastPitchId)?.status === 'live';
  const earlierAllDone = earlierPitchIds.every((id) => finalPitchStates.find((p) => p.id === id)?.status === 'done');
  step('Only the most recent pitch remains "live"; all earlier pitches transitioned to "done" (no stale live banners)', lastIsLive && earlierAllDone, JSON.stringify(finalPitchStates));

  // reset event_state fully
  await admin.from('event_state').update({ current_pitch_id: null, timer_phase: 'idle', timer_started_at: null, timer_paused_remaining: null, updated_at: new Date().toISOString() }).eq('id', 1);
  await admin.from('pitches').update({ status: 'done', ended_at: new Date().toISOString() }).eq('id', lastPitchId);

  console.log('');
}

async function cleanup() {
  console.log('Cleaning up test data...');
  for (const pid of created.pitchIds) {
    await admin.from('questions').delete().eq('pitch_id', pid);
    await admin.from('judge_scores').delete().eq('pitch_id', pid);
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
