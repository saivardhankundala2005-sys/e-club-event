'use server';

import { createAdminClient } from '@/src/lib/supabase/admin';
import { requireRole } from '@/src/lib/authHelpers';
import { sanitizeInput, isValidUUID } from '@/src/lib/validation';
import { revalidatePath } from 'next/cache';

const PITCH_DURATION_SECONDS = 180;

function revalidateAllPortals() {
  revalidatePath('/portal/judge');
  revalidatePath('/portal/organiser');
  revalidatePath('/portal/team');
  revalidatePath('/display');
}

/**
 * Moves a pitch to the top of the active queue: sets it as event_state's
 * current pitch, marks it 'called', and resets the timer to idle at full
 * duration. Judge or Organiser may call this.
 */
export async function callToStageAction(pitchId: string) {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const sanitizedPitchId = sanitizeInput(pitchId);
  if (!isValidUUID(sanitizedPitchId)) return { error: 'Invalid pitch id.' };

  const adminSupabase = createAdminClient();

  // Guard against overwriting a pitch that's already active on stage — a
  // double Call-to-Stage click (e.g. judge and organiser both act near-
  // simultaneously) would otherwise silently strand the first pitch: it
  // drops out of the 'queued' list but never reaches 'scored', requiring
  // a manual DB fix mid-event.
  const { data: currentState } = await adminSupabase
    .from('event_state')
    .select('current_pitch_id')
    .eq('id', 1)
    .single();

  if (currentState?.current_pitch_id && currentState.current_pitch_id !== sanitizedPitchId) {
    const { data: activePitch } = await adminSupabase
      .from('pitches')
      .select('queue_status, teams(team_name)')
      .eq('id', currentState.current_pitch_id)
      .single();

    if (activePitch && activePitch.queue_status !== 'scored') {
      const activeTeamName = (activePitch as any).teams?.team_name || 'another team';
      return {
        error: `${activeTeamName} is still on stage (${activePitch.queue_status}). End and score that pitch before calling the next one.`,
      };
    }
  }

  const { error: pitchErr } = await adminSupabase
    .from('pitches')
    .update({ queue_status: 'called' })
    .eq('id', sanitizedPitchId);

  if (pitchErr) return { error: pitchErr.message };

  const { error: stateErr } = await adminSupabase
    .from('event_state')
    .update({
      current_pitch_id: sanitizedPitchId,
      timer_status: 'idle',
      timer_started_at: null,
      timer_paused_remaining: null,
      timer_duration_seconds: PITCH_DURATION_SECONDS,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (stateErr) return { error: stateErr.message };

  revalidateAllPortals();
  return { success: true };
}

/**
 * Manual reorder of the queue. Sets queue_position_override on the given
 * pitch ids in the order provided (index order = new display order).
 * Only affects pitches still in 'queued' status.
 */
export async function reorderQueueAction(orderedPitchIds: string[]) {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  if (!Array.isArray(orderedPitchIds) || orderedPitchIds.length === 0) {
    return { error: 'No pitch order provided.' };
  }

  const adminSupabase = createAdminClient();

  for (let i = 0; i < orderedPitchIds.length; i++) {
    const id = sanitizeInput(orderedPitchIds[i]);
    if (!isValidUUID(id)) continue;
    await adminSupabase
      .from('pitches')
      .update({ queue_position_override: i + 1 })
      .eq('id', id)
      .eq('queue_status', 'queued');
  }

  revalidateAllPortals();
  return { success: true };
}

export async function startTimerAction() {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const adminSupabase = createAdminClient();

  const { data: state } = await adminSupabase
    .from('event_state')
    .select('current_pitch_id')
    .eq('id', 1)
    .single();

  if (!state?.current_pitch_id) {
    return { error: 'No pitch is currently called to stage.' };
  }

  const { error: stateErr } = await adminSupabase
    .from('event_state')
    .update({
      timer_status: 'running',
      timer_started_at: new Date().toISOString(),
      timer_paused_remaining: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (stateErr) return { error: stateErr.message };

  await adminSupabase
    .from('pitches')
    .update({ queue_status: 'pitching', started_at: new Date().toISOString() })
    .eq('id', state.current_pitch_id);

  revalidateAllPortals();
  return { success: true };
}

export async function pauseTimerAction() {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const adminSupabase = createAdminClient();

  const { data: curr } = await adminSupabase
    .from('event_state')
    .select('timer_started_at, timer_duration_seconds')
    .eq('id', 1)
    .single();

  let remaining = curr?.timer_duration_seconds ?? PITCH_DURATION_SECONDS;
  if (curr?.timer_started_at) {
    const elapsed = Math.floor((Date.now() - new Date(curr.timer_started_at).getTime()) / 1000);
    remaining = Math.max(0, (curr.timer_duration_seconds || PITCH_DURATION_SECONDS) - elapsed);
  }

  const { error } = await adminSupabase
    .from('event_state')
    .update({
      timer_status: 'paused',
      timer_paused_remaining: remaining,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (error) return { error: error.message };

  revalidateAllPortals();
  return { success: true };
}

export async function resetTimerAction() {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const adminSupabase = createAdminClient();

  const { error } = await adminSupabase
    .from('event_state')
    .update({
      timer_status: 'idle',
      timer_started_at: null,
      timer_paused_remaining: null,
      timer_duration_seconds: PITCH_DURATION_SECONDS,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (error) return { error: error.message };

  revalidateAllPortals();
  return { success: true };
}

/**
 * Ends the pitch whether the timer has run out or not — real pitches can
 * run long or end early. Moves the pitch to 'awaiting_score'.
 */
export async function endPitchAction() {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const adminSupabase = createAdminClient();

  const { data: state } = await adminSupabase
    .from('event_state')
    .select('current_pitch_id')
    .eq('id', 1)
    .single();

  if (!state?.current_pitch_id) {
    return { error: 'No pitch is currently active.' };
  }

  const { error: stateErr } = await adminSupabase
    .from('event_state')
    .update({
      timer_status: 'ended',
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (stateErr) return { error: stateErr.message };

  const { error: pitchErr } = await adminSupabase
    .from('pitches')
    .update({ queue_status: 'awaiting_score', ended_at: new Date().toISOString() })
    .eq('id', state.current_pitch_id);

  if (pitchErr) return { error: pitchErr.message };

  revalidateAllPortals();
  return { success: true };
}

/**
 * Submits the single authoritative score for a pitch. First submission
 * locks it (enforced by the DB UNIQUE(pitch_id) constraint on
 * pitch_scores, not just a disabled client button). Any subsequent
 * attempt for the same pitch is rejected with a clear "already scored"
 * message rather than a raw constraint-violation error.
 */
/**
 * Judges always enter scores on a uniform 0-10 scale per category — the
 * ×2 (20% categories) / ×1.5 (15% categories) weighting happens only in
 * pitch_leaderboard's SQL, never here or in the UI.
 */
export async function submitPitchScoreAction(payload: {
  pitchId: string;
  scores: {
    problem_market: number;
    solution_innovation: number;
    feasibility: number;
    pitch_storytelling: number;
  };
}) {
  let userCtx;
  try {
    userCtx = await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const sanitizedPitchId = sanitizeInput(payload.pitchId);
  if (!isValidUUID(sanitizedPitchId)) return { error: 'Invalid pitch id.' };

  const adminSupabase = createAdminClient();

  const { data: profile } = await adminSupabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', userCtx.user.id)
    .single();

  const submittedByName = profile?.full_name || profile?.email || userCtx.user.email;

  const { scores } = payload;
  const clamp10 = (val: number) => Math.max(0, Math.min(Number(val) || 0, 10));

  const { data: inserted, error: insertErr } = await adminSupabase
    .from('pitch_scores')
    .insert({
      pitch_id: sanitizedPitchId,
      problem_market_raw: clamp10(scores.problem_market),
      solution_innovation_raw: clamp10(scores.solution_innovation),
      feasibility_raw: clamp10(scores.feasibility),
      pitch_storytelling_raw: clamp10(scores.pitch_storytelling),
      submitted_by: userCtx.user.id,
      submitted_by_name: submittedByName,
      locked: true,
    })
    .select()
    .single();

  if (insertErr) {
    // Unique-violation on pitch_id means someone else already submitted
    // first — surface a clear message instead of the raw DB error.
    if (insertErr.code === '23505') {
      const { data: existing } = await adminSupabase
        .from('pitch_scores')
        .select('submitted_by_name')
        .eq('pitch_id', sanitizedPitchId)
        .single();

      return {
        error: `Already scored by ${existing?.submitted_by_name || 'another judge/organiser'}.`,
        alreadyScored: true,
      };
    }
    return { error: insertErr.message };
  }

  await adminSupabase
    .from('pitches')
    .update({ queue_status: 'scored' })
    .eq('id', sanitizedPitchId);

  revalidateAllPortals();
  return { success: true, pitchScore: inserted };
}
