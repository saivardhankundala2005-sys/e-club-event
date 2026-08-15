'use server';

import { createAdminClient } from '@/src/lib/supabase/admin';
import { requireRole } from '@/src/lib/authHelpers';
import { sanitizeInput } from '@/src/lib/validation';
import { revalidatePath } from 'next/cache';

export async function submitAudienceRatingAction(payload: {
  pitchId: string;
  scores: {
    problem_relevance: number;
    creativity: number;
    solution_quality: number;
    pitch_quality: number;
    overall_potential: number;
  };
}) {
  let userCtx;
  try {
    userCtx = await requireRole(['team', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const { pitchId, scores } = payload;
  const sanitizedPitchId = sanitizeInput(pitchId);
  const adminSupabase = createAdminClient();

  // Fetch voting team details
  const { data: votingTeam } = await adminSupabase
    .from('teams')
    .select('id, pool')
    .eq('auth_user_id', userCtx.user.id)
    .single();

  if (!votingTeam) return { error: 'Voting team profile not found.' };

  // Fetch pitching team details
  const { data: pitch } = await adminSupabase
    .from('pitches')
    .select('id, team_id, teams (id, pool)')
    .eq('id', sanitizedPitchId)
    .single();

  if (!pitch || !pitch.teams) return { error: 'Pitch not found.' };

  const pitchingTeam = pitch.teams as any;

  // Strict Pool Check: Cannot vote for own team or team in the SAME pool!
  if (votingTeam.id === pitchingTeam.id || votingTeam.pool === pitchingTeam.pool) {
    return { error: 'You are not allowed to vote on pitches from your own team or pool.' };
  }

  // Check if team already voted on this pitch (fast-path UX check — the
  // real guarantee against a double-tap/double-submit race is the
  // UNIQUE(voting_team_id, pitch_id, criterion) DB constraint below, since
  // this check and the insert are not atomic).
  const { data: existing } = await adminSupabase
    .from('audience_scores')
    .select('id')
    .eq('voting_team_id', votingTeam.id)
    .eq('pitch_id', sanitizedPitchId);

  if (existing && existing.length > 0) {
    return { error: 'Your team has already submitted a rating for this pitch.' };
  }

  const entries = [
    { criterion: 'problem_relevance', score: Math.max(1, Math.min(Number(scores.problem_relevance) || 1, 5)) },
    { criterion: 'creativity', score: Math.max(1, Math.min(Number(scores.creativity) || 1, 5)) },
    { criterion: 'solution_quality', score: Math.max(1, Math.min(Number(scores.solution_quality) || 1, 5)) },
    { criterion: 'pitch_quality', score: Math.max(1, Math.min(Number(scores.pitch_quality) || 1, 5)) },
    { criterion: 'overall_potential', score: Math.max(1, Math.min(Number(scores.overall_potential) || 1, 5)) },
  ];

  const { error: insertErr } = await adminSupabase.from('audience_scores').insert(
    entries.map((entry) => ({
      voting_team_id: votingTeam.id,
      pitch_id: sanitizedPitchId,
      criterion: entry.criterion as any,
      score: entry.score,
    }))
  );

  if (insertErr) {
    // 23505 = unique_violation: a concurrent double-submit from the same
    // team already inserted these rows first. Treat as success (idempotent)
    // rather than surfacing a confusing duplicate-key error to the user.
    if (insertErr.code === '23505') {
      revalidatePath('/portal/team');
      revalidatePath('/portal/organiser');
      return { success: true };
    }
    return { error: 'Failed to submit rating: ' + insertErr.message };
  }

  revalidatePath('/portal/team');
  revalidatePath('/portal/organiser');
  return { success: true };
}

export async function submitQuestionAction(payload: { pitchId: string; questionText: string }) {
  let userCtx;
  try {
    userCtx = await requireRole(['team', 'organiser']);
  } catch (err: any) {
    return { error: err.message || 'Not authenticated.' };
  }

  const { pitchId, questionText } = payload;
  const sanitizedPitchId = sanitizeInput(pitchId);
  const sanitizedQuestionText = sanitizeInput(questionText || '');

  if (!sanitizedQuestionText || sanitizedQuestionText.trim().length < 5) {
    return { error: 'Question must be at least 5 characters long.' };
  }

  const adminSupabase = createAdminClient();

  const { data: team } = await adminSupabase
    .from('teams')
    .select('id, pool')
    .eq('auth_user_id', userCtx.user.id)
    .single();

  if (!team) return { error: 'Team profile not found.' };

  // Opposite-pool-only, same as audience rating (section 4's pattern):
  // a team may only question the opposite pool's live pitch, never its
  // own pool (including its own pitch).
  const { data: pitch } = await adminSupabase
    .from('pitches')
    .select('id, team_id, teams (id, pool)')
    .eq('id', sanitizedPitchId)
    .single();

  if (!pitch || !pitch.teams) return { error: 'Pitch not found.' };
  const pitchingTeam = pitch.teams as any;

  if (team.id === pitchingTeam.id || team.pool === pitchingTeam.pool) {
    return { error: 'You can only submit questions for pitches from the opposite pool.' };
  }

  // Double-submit guard: on a double-tap (common on bad event wifi), reject
  // an identical question from the same team for the same pitch submitted
  // in the last 10 seconds instead of creating a duplicate queue entry.
  const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
  const { data: recentDuplicate } = await adminSupabase
    .from('questions')
    .select('id')
    .eq('asking_team_id', team.id)
    .eq('pitch_id', sanitizedPitchId)
    .eq('question_text', sanitizedQuestionText)
    .gte('created_at', tenSecondsAgo)
    .maybeSingle();

  if (recentDuplicate) {
    return { success: true };
  }

  const { error } = await adminSupabase.from('questions').insert({
    asking_team_id: team.id,
    pitch_id: sanitizedPitchId,
    question_text: sanitizedQuestionText,
    status: 'pending',
  });

  if (error) return { error: error.message };

  revalidatePath('/portal/team');
  revalidatePath('/portal/organiser');
  return { success: true };
}
