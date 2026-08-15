'use server';

import { createAdminClient } from '@/src/lib/supabase/admin';
import { requireRole } from '@/src/lib/authHelpers';
import { sanitizeInput } from '@/src/lib/validation';
import { revalidatePath } from 'next/cache';
import { PitchLeaderboardEntry } from '@/src/lib/types';

export async function exportRegistrationsCsvAction() {
  try {
    await requireRole('organiser');
  } catch (err: any) {
    return { error: err.message || 'Unauthorized action.' };
  }

  const adminSupabase = createAdminClient();

  const { data: teams, error: teamsErr } = await adminSupabase
    .from('teams')
    .select('id, team_name, domain, pool')
    .order('created_at', { ascending: false });

  if (teamsErr || !teams) {
    return { error: teamsErr?.message || 'Failed to fetch teams.' };
  }

  const { data: members, error: membersErr } = await adminSupabase
    .from('team_members')
    .select('team_id, name, email, is_leader');

  if (membersErr || !members) {
    return { error: membersErr?.message || 'Failed to fetch team members.' };
  }

  const headers = ['Team Name', 'Domain', 'Pool', 'Member Name', 'Member Email', 'Is Leader'];
  const rows: string[] = [];

  teams.forEach((t) => {
    const teamMembers = members.filter((m) => m.team_id === t.id);
    teamMembers.forEach((m) => {
      rows.push(
        [`"${t.team_name}"`, `"${t.domain}"`, `"${t.pool}"`, `"${m.name}"`, `"${m.email}"`, m.is_leader].join(',')
      );
    });
  });

  const csv = [headers.join(','), ...rows].join('\n');
  return { success: true, csv };
}

// Raw point rule (per question, once approval + outcome are recorded):
//   rejected:                    pitching +0, asking +0
//   approved + answered well:    pitching +2, asking +2
//   approved + answered poorly:  pitching +0, asking +1
// Stored per-question (not just an incrementing counter) so the math is
// auditable/re-computable — see pitch_leaderboard's qa_component for the
// per-team aggregation + min-max normalization into the 10% slice.
export async function reviewQuestionAction(
  questionId: string,
  status: 'approved' | 'rejected',
  outcome?: 'team_answered_well' | 'team_answered_poorly' | null
) {
  try {
    await requireRole(['judge', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Unauthorized action.' };
  }

  const sanitizedQuestionId = sanitizeInput(questionId);
  if (!['approved', 'rejected'].includes(status)) {
    return { error: 'Invalid question status.' };
  }
  if (status === 'approved' && !['team_answered_well', 'team_answered_poorly'].includes(outcome || '')) {
    return { error: 'An approved question requires an answer-quality outcome.' };
  }

  const adminSupabase = createAdminClient();

  let pointsPitching = 0;
  let pointsAsking = 0;

  if (status === 'approved') {
    if (outcome === 'team_answered_well') {
      pointsPitching = 2;
      pointsAsking = 2;
    } else if (outcome === 'team_answered_poorly') {
      pointsPitching = 0;
      pointsAsking = 1;
    }
  }

  const { error } = await adminSupabase
    .from('questions')
    .update({
      status,
      outcome: status === 'approved' ? outcome : null,
      points_pitching: pointsPitching,
      points_asking: pointsAsking,
    })
    .eq('id', sanitizedQuestionId);

  if (error) return { error: error.message };

  revalidatePath('/portal/organiser');
  revalidatePath('/portal/judge');
  revalidatePath('/portal/team');
  return { success: true };
}

// Manual override always writes the raw 0-10 input columns — the same
// scale judges see — never the pre-weighted value, so the weighting math
// stays entirely server-side in pitch_leaderboard.
const PITCH_SCORE_RAW_CATEGORIES = [
  'problem_market_raw',
  'solution_innovation_raw',
  'feasibility_raw',
  'pitch_storytelling_raw',
];

export async function manualOverrideScoreAction(payload: {
  tableChanged: 'pitch_scores' | 'audience_scores' | 'questions';
  rowId: string;
  oldValue: any;
  newValue: any;
  note: string;
}) {
  let userCtx;
  try {
    userCtx = await requireRole('organiser');
  } catch (err: any) {
    return { error: err.message || 'Unauthorized action.' };
  }

  const { tableChanged, rowId, oldValue, newValue, note } = payload;
  const sanitizedNote = sanitizeInput(note || '');
  const sanitizedRowId = sanitizeInput(rowId || '');

  if (!['pitch_scores', 'audience_scores', 'questions'].includes(tableChanged)) {
    return { error: 'Invalid target table for score override.' };
  }

  if (!sanitizedNote || sanitizedNote.trim().length < 3) {
    return { error: 'A short descriptive note is required for manual overrides.' };
  }

  const adminSupabase = createAdminClient();

  // 1. Apply modification to target table
  if (tableChanged === 'pitch_scores') {
    const category = String(newValue.category || '');
    if (!PITCH_SCORE_RAW_CATEGORIES.includes(category)) return { error: 'Invalid pitch score category.' };
    const numScore = Math.max(0, Math.min(Number(newValue.score) || 0, 10));
    const { error: updateErr } = await adminSupabase
      .from('pitch_scores')
      .update({ [category]: numScore })
      .eq('id', sanitizedRowId);
    if (updateErr) return { error: updateErr.message };
  } else if (tableChanged === 'audience_scores') {
    const numScore = Math.max(1, Math.min(Number(newValue.score) || 1, 5));
    await adminSupabase
      .from('audience_scores')
      .update({ score: numScore })
      .eq('id', sanitizedRowId);
  } else if (tableChanged === 'questions') {
    await adminSupabase
      .from('questions')
      .update({
        points_pitching: Number(newValue.points_pitching) || 0,
        points_asking: Number(newValue.points_asking) || 0,
      })
      .eq('id', sanitizedRowId);
  }

  // 2. Insert record into audit log
  const { error: auditErr } = await adminSupabase.from('score_audit_log').insert({
    changed_by: userCtx.user.id,
    table_changed: tableChanged,
    row_id: sanitizedRowId,
    old_value: oldValue,
    new_value: newValue,
    note: sanitizedNote,
  });

  if (auditErr) return { error: auditErr.message };

  revalidatePath('/portal/organiser');
  return { success: true };
}

/**
 * Deletes the locked pitch_scores row for a pitch so it can be re-scored
 * from scratch. There's no partial "unlock and edit in place" concept for
 * the single-row model — the row IS the lock (see submitPitchScoreAction's
 * UNIQUE(pitch_id) constraint) — so unlocking means clearing it and letting
 * a judge/organiser submit again.
 */
export async function unlockPitchScoreAction(pitchScoreId: string, note: string) {
  let userCtx;
  try {
    userCtx = await requireRole('organiser');
  } catch (err: any) {
    return { error: err.message || 'Unauthorized action.' };
  }

  const sanitizedId = sanitizeInput(pitchScoreId);
  const sanitizedNote = sanitizeInput(note || '');

  if (!sanitizedNote || sanitizedNote.trim().length < 3) {
    return { error: 'Please provide a note explaining why this pitch score is being unlocked.' };
  }

  const adminSupabase = createAdminClient();

  const { data: oldRow } = await adminSupabase
    .from('pitch_scores')
    .select('*')
    .eq('id', sanitizedId)
    .single();

  if (!oldRow) return { error: 'Pitch score not found.' };

  const { error: deleteErr } = await adminSupabase
    .from('pitch_scores')
    .delete()
    .eq('id', sanitizedId);

  if (deleteErr) return { error: deleteErr.message };

  await adminSupabase
    .from('pitches')
    .update({ queue_status: 'awaiting_score' })
    .eq('id', oldRow.pitch_id);

  await adminSupabase.from('score_audit_log').insert({
    changed_by: userCtx.user.id,
    table_changed: 'pitch_scores',
    row_id: sanitizedId,
    old_value: oldRow,
    new_value: null,
    note: `[UNLOCK SCORE]: ${sanitizedNote}`,
  });

  revalidatePath('/portal/organiser');
  revalidatePath('/portal/judge');
  return { success: true };
}

export async function qualifyFinalFourAction() {
  try {
    await requireRole('organiser');
  } catch (err: any) {
    return { error: err.message || 'Unauthorized action.' };
  }

  const adminSupabase = createAdminClient();

  // Fetch authoritative rankings for Prelim round
  const { data: leaderboard, error } = await adminSupabase
    .from('pitch_leaderboard')
    .select('*')
    .eq('round_name', 'prelim');

  if (error || !leaderboard) {
    return { error: 'Failed to fetch prelim leaderboard for qualification.' };
  }

  // Separate Pool A and Pool B rankings
  const poolA = (leaderboard as PitchLeaderboardEntry[])
    .filter((item) => item.pool === 'A')
    .sort((a, b) => (b.total_weighted_score ?? -1) - (a.total_weighted_score ?? -1));
  const poolB = (leaderboard as PitchLeaderboardEntry[])
    .filter((item) => item.pool === 'B')
    .sort((a, b) => (b.total_weighted_score ?? -1) - (a.total_weighted_score ?? -1));

  const topPoolA = poolA.slice(0, 2);
  const topPoolB = poolB.slice(0, 2);

  if (topPoolA.length < 2 || topPoolB.length < 2) {
    return { error: 'Need at least 2 registered teams in Pool A and 2 in Pool B to create Final 4.' };
  }

  const finalFourTeams = [...topPoolA, ...topPoolB];

  // Fetch or ensure Final Round ID exists
  const { data: finalRound } = await adminSupabase
    .from('rounds')
    .select('id')
    .eq('name', 'final')
    .single();

  if (!finalRound) {
    return { error: 'Final round configuration not found in rounds table.' };
  }

  // Insert Final Round pitches
  for (let i = 0; i < finalFourTeams.length; i++) {
    const team = finalFourTeams[i];
    await adminSupabase
      .from('pitches')
      .upsert(
        {
          team_id: team.team_id,
          round_id: finalRound.id,
          status: 'upcoming',
          pitch_order: i + 1,
        },
        { onConflict: 'team_id,round_id' }
      );
  }

  // Update event_state current_round_id to Final round
  await adminSupabase
    .from('event_state')
    .update({ current_round_id: finalRound.id })
    .eq('id', 1);

  revalidatePath('/portal/organiser');
  return {
    success: true,
    qualifiers: finalFourTeams.map((t) => ({
      team_name: t.team_name,
      pool: t.pool,
      score: t.total_weighted_score,
    })),
  };
}

/**
 * Organiser-only "Reveal Top 3 & Leaderboard" ceremony trigger. Sets
 * event_state.results_revealed = true (Team Portal's leaderboard/RLS gate
 * flips immediately via Realtime) and logs the action to the audit trail.
 *
 * Top 3 is computed from the FINAL round if one has run (qualifyFinalFourAction
 * already switched event_state.current_round_id to it), otherwise from the
 * single prelim leaderboard — the caller decides which round_name to pass;
 * this action only flips the reveal flag and audits it.
 */
export async function revealTopThreeAction() {
  let userCtx;
  try {
    userCtx = await requireRole('organiser');
  } catch (err: any) {
    return { error: err.message || 'Unauthorized action.' };
  }

  const adminSupabase = createAdminClient();

  const { error } = await adminSupabase
    .from('event_state')
    .update({ results_revealed: true, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) return { error: error.message };

  await adminSupabase.from('score_audit_log').insert({
    changed_by: userCtx.user.id,
    table_changed: 'event_state',
    row_id: '00000000-0000-0000-0000-000000000001',
    old_value: { results_revealed: false },
    new_value: { results_revealed: true },
    note: '[REVEAL] Organiser triggered the Top 3 & Leaderboard reveal ceremony.',
  });

  revalidatePath('/portal/organiser');
  revalidatePath('/portal/team');
  revalidatePath('/portal/judge');
  revalidatePath('/display');
  return { success: true };
}
