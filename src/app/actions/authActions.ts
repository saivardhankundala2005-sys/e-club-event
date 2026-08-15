'use server';

import { createClient } from '@/src/lib/supabase/server';
import { createAdminClient } from '@/src/lib/supabase/admin';
import { isValidStaffEmail, isValidEmailFormat, validateTeamMemberEmails } from '@/src/lib/validation';
import { redirect } from 'next/navigation';

export async function requestTeamOtpAction(formData: FormData) {
  const email = formData.get('email') as string;

  if (!email || !isValidEmailFormat(email)) {
    return { error: 'Please provide a valid email address.' };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
    },
  });

  if (error) {
    return { error: error.message };
  }

  return { success: true, email };
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
    return { error: error.message };
  }

  if (data.user) {
    // Ensure profile row exists
    const adminSupabase = createAdminClient();
    await adminSupabase.from('profiles').upsert({
      id: data.user.id,
      email: data.user.email!,
      role: 'team',
      full_name: email.split('@')[0],
    });
  }

  return { success: true };
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

  // 4. Random Domain Selection from `domains` table
  const { data: domains, error: domainErr } = await adminSupabase.from('domains').select('name');
  if (domainErr || !domains || domains.length === 0) {
    return { error: 'Failed to fetch domains from database.' };
  }
  const randomDomain = domains[Math.floor(Math.random() * domains.length)].name;

  // 5. Auto-Balanced Pool Assignment (A or B)
  const { data: poolACount } = await adminSupabase
    .from('teams')
    .select('id', { count: 'exact' })
    .eq('pool', 'A');
  
  const { data: poolBCount } = await adminSupabase
    .from('teams')
    .select('id', { count: 'exact' })
    .eq('pool', 'B');

  const countA = poolACount?.length || 0;
  const countB = poolBCount?.length || 0;
  const assignedPool: 'A' | 'B' = countA <= countB ? 'A' : 'B';

  // 6. Insert Team
  const { data: team, error: teamErr } = await adminSupabase
    .from('teams')
    .insert({
      auth_user_id: user.id,
      team_name: teamName,
      domain: randomDomain,
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
    domain: randomDomain,
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
