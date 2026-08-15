'use server';

import { createClient } from '@/src/lib/supabase/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { isValidStaffEmail, isValidEmailFormat, validateTeamMemberEmails } from '@/src/lib/validation';
import { redirect } from 'next/navigation';

const OTP_REQUEST_COOLDOWN_SECONDS = 15;

export async function requestTeamOtpAction(formData: FormData) {
  const email = formData.get('email') as string;

  if (!email || !isValidEmailFormat(email)) {
    return { error: 'Please provide a valid email address.' };
  }
  const normalizedEmail = email.trim().toLowerCase();

  const adminSupabase = createAdminClient();

  // Idempotency / rate-limit: if this email requested a code in the last
  // OTP_REQUEST_COOLDOWN_SECONDS, don't send a second one — acknowledge
  // success instead. Covers both a genuine double-tap/flaky-retry and
  // repeated-tap abuse, without a DB round trip that can race (the
  // UNIQUE PK on email + upsert-with-condition below is the atomic guard).
  const { data: existingLog } = await adminSupabase
    .from('otp_request_log')
    .select('last_requested_at')
    .eq('email', normalizedEmail)
    .maybeSingle();

  if (existingLog) {
    const elapsedMs = Date.now() - new Date(existingLog.last_requested_at).getTime();
    if (elapsedMs < OTP_REQUEST_COOLDOWN_SECONDS * 1000) {
      return { success: true, email: normalizedEmail };
    }
  }

  // Re-login vs. registration: one email input serves both. If a team
  // already exists for this email, send a login-only OTP that does not
  // create a new auth user (shouldCreateUser: false), so a repeat visitor
  // authenticates without re-running domain/pool assignment. Otherwise
  // fall through to the existing registration OTP (creates the user).
  // profiles.email is unique and populated for every verified team auth
  // user (see verifyTeamOtpAction's upsert), so it's a direct lookup —
  // no need to page through auth.admin.listUsers().
  const { data: existingProfile } = await adminSupabase
    .from('profiles')
    .select('id')
    .eq('email', normalizedEmail)
    .maybeSingle();

  const { data: existingTeam } = existingProfile
    ? await adminSupabase.from('teams').select('id').eq('auth_user_id', existingProfile.id).maybeSingle()
    : { data: null };

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      shouldCreateUser: !existingTeam,
    },
  });

  if (error) {
    return { error: error.message };
  }

  await adminSupabase
    .from('otp_request_log')
    .upsert({ email: normalizedEmail, last_requested_at: new Date().toISOString() });

  // Deliberately does NOT return whether this was a new-vs-returning team —
  // that would let an unauthenticated caller enumerate registered emails
  // via this response alone (routing on new-vs-returning only happens
  // post-verification, in verifyTeamOtpAction, once inbox ownership is
  // proven — see isReturningTeam there instead).
  return { success: true, email: normalizedEmail };
}

export async function verifyTeamOtpAction(email: string, token: string) {
  if (!email || !isValidEmailFormat(email)) {
    return { error: 'Invalid email address.' };
  }

  const supabase = createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });

  if (error) {
    const isExpired = /expired/i.test(error.message);
    return {
      error: isExpired
        ? 'This code has expired. Request a new one below.'
        : 'Incorrect code. Please check and try again.',
      expired: isExpired,
    };
  }

  if (!data.user) {
    return { error: 'Verification failed. Please try again.' };
  }

  const adminSupabase = createAdminClient();

  // Ensure profile row exists (both new registrants and returning teams).
  await adminSupabase.from('profiles').upsert({
    id: data.user.id,
    email: data.user.email!,
    role: 'team',
    full_name: email.split('@')[0],
  });

  // Returning team: route straight to their existing dashboard, skip
  // registration/domain/pool assignment entirely.
  const { data: existingTeam } = await adminSupabase
    .from('teams')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle();

  return { success: true, isReturningTeam: !!existingTeam };
}

export async function registerTeamAction(payload: {
  teamName: string;
  leaderName: string;
  leaderEmail: string;
  members: { name: string; email: string }[];
}) {
  const { teamName, leaderName, leaderEmail, members } = payload;

  // 1. Collect all member emails including leader
  const allEmails = [leaderEmail, ...members.map((m) => m.email)];
  
  // 2. Validate team size (2 to 4 members total)
  if (allEmails.length < 2 || allEmails.length > 4) {
    return { error: 'A team must have between 2 and 4 total members.' };
  }

  // 3. SERVER-SIDE VALIDATION: Check EVERY member email is a syntactically valid address (any domain allowed)
  const validation = validateTeamMemberEmails(allEmails);
  if (!validation.valid) {
    return {
      error: `All team member emails must be valid. Invalid emails found: ${validation.invalidEmails.join(', ')}`,
    };
  }

  const supabase = createClient();
  const adminSupabase = createAdminClient();

  // Get current logged in user
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'User is not authenticated. Please verify OTP first.' };
  }

  // 3b. ABUSE PROTECTION: block one authenticated identity from registering
  // more than one team (open email domain means no other natural cap on
  // repeat/spam registrations). Backed by a UNIQUE(auth_user_id) DB
  // constraint; this is just a friendlier pre-check.
  const { data: existingTeam } = await adminSupabase
    .from('teams')
    .select('id, team_name')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (existingTeam) {
    return { error: `You have already registered a team ("${existingTeam.team_name}"). Each account may register only one team.` };
  }

  // 4. Least-assigned-first domain selection: pick uniformly at random
  // among whichever domain(s) currently have the lowest assigned_count,
  // rather than pure Math.random() across the whole table (which produces
  // back-to-back repeats). The "find min, increment, return" happens
  // atomically in assign_least_used_domain (a single RPC round trip), so
  // two concurrent registrations can't both read the same lowest count and
  // pick the same domain without seeing each other's increment.
  const { data: domainResult, error: domainErr } = await adminSupabase.rpc('assign_least_used_domain');
  if (domainErr || !domainResult) {
    return { error: 'Failed to assign a domain.' };
  }
  const assignedDomain = domainResult as string;

  // 5. Deterministic pool alternation via a Postgres sequence: nextval()
  // is a single atomic operation, so two simultaneous registrations can
  // never both land in the same slot (unlike the previous
  // countA <= countB read-then-write check, which had a race window).
  const { data: seqResult, error: seqErr } = await adminSupabase.rpc('next_pool_assignment');
  if (seqErr || !seqResult) {
    return { error: 'Failed to assign a pool.' };
  }
  const assignedPool = seqResult as 'A' | 'B';

  // 6. Insert Team
  const { data: team, error: teamErr } = await adminSupabase
    .from('teams')
    .insert({
      auth_user_id: user.id,
      team_name: teamName,
      domain: assignedDomain,
      pool: assignedPool,
      status: 'registered',
    })
    .select()
    .single();

  if (teamErr || !team) {
    if (teamErr?.code === '23505') {
      if (teamErr.message?.includes('teams_auth_user_id_unique')) {
        return { error: 'You have already registered a team. Each account may register only one team.' };
      }
      return { error: 'A team with this name is already registered.' };
    }
    return { error: teamErr?.message || 'Failed to create team.' };
  }

  // 7. Insert Team Members
  const memberRows = [
    {
      team_id: team.id,
      name: leaderName,
      email: leaderEmail,
      is_leader: true,
    },
    ...members.map((m) => ({
      team_id: team.id,
      name: m.name,
      email: m.email,
      is_leader: false,
    })),
  ];

  const { error: membersErr } = await adminSupabase.from('team_members').insert(memberRows);
  if (membersErr) {
    return { error: 'Failed to register team members.' };
  }

  // Pitch record creation for the prelim round is handled by the
  // trg_create_prelim_pitch_for_team DB trigger (fires on the team insert
  // above), which owns queue_status/pitch_order — do not duplicate it
  // here, that would race the trigger's UNIQUE(team_id, round_id) insert.

  return {
    success: true,
    team,
    domain: assignedDomain,
    pool: assignedPool,
  };
}

export async function staffLoginAction(formData: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  if (!email || !password) {
    return { error: 'Please provide both email and password.' };
  }

  // SERVER-SIDE STRICT DOMAIN ENFORCEMENT for staff (judge/organiser) accounts.
  // Temporary exception: STAFF_TEST_EMAIL_ALLOWLIST (comma-separated) lets pre-seeded
  // non-institute test accounts keep working until they're migrated to real
  // @student.nitw.ac.in addresses. Remove this allowlist once testing is done.
  const testAllowlist = (process.env.STAFF_TEST_EMAIL_ALLOWLIST || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const normalizedEmail = email.trim().toLowerCase();

  if (!isValidStaffEmail(email) && !testAllowlist.includes(normalizedEmail)) {
    return { error: 'Staff login is restricted to official @student.nitw.ac.in email addresses.' };
  }

  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    return { error: error?.message || 'Invalid login credentials.' };
  }

  // Fetch role
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .single();

  const role = profile?.role || 'judge';

  if (role === 'organiser') {
    redirect('/portal/organiser');
  } else if (role === 'judge') {
    redirect('/portal/judge');
  } else {
    redirect('/portal/team');
  }
}

export async function signOutAction() {
  const supabase = createClient();
  await supabase.auth.signOut();
  redirect('/');
}
