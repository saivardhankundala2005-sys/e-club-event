'use client';

import { useState, useEffect } from 'react';
import Navbar from '@/src/components/Navbar';
import CountdownTimer from '@/src/components/CountdownTimer';
import PodiumReveal from '@/src/components/PodiumReveal';
import Toast, { ToastMessage } from '@/src/components/Toast';
import PoolBadge from '@/src/components/PoolBadge';
import { Users, Flame, Send, CheckCircle2, ShieldAlert, Trophy, HelpCircle, Lock, ListOrdered } from 'lucide-react';
import { createClient } from '@/src/lib/supabase/client';
import { EventState, Pitch, Team, Question, PitchLeaderboardEntry } from '@/src/lib/types';
import { submitAudienceRatingAction, submitQuestionAction } from '@/src/app/actions/teamActions';

export default function TeamPortalPage() {
  const [myTeam, setMyTeam] = useState<Team | null>(null);
  const [eventState, setEventState] = useState<EventState | null>(null);
  const [currentPitch, setCurrentPitch] = useState<(Pitch & { teams?: Team }) | null>(null);
  const [upNextTeams, setUpNextTeams] = useState<Team[]>([]);
  const [podiumLeaderboard, setPodiumLeaderboard] = useState<PitchLeaderboardEntry[]>([]);
  const [myQuestions, setMyQuestions] = useState<Question[]>([]);
  const [loadingTeam, setLoadingTeam] = useState(true);

  // Rating Sliders (1-5 scale)
  const [problemRel, setProblemRel] = useState<number>(3);
  const [creativity, setCreativity] = useState<number>(3);
  const [solQuality, setSolQuality] = useState<number>(3);
  const [pitchQuality, setPitchQuality] = useState<number>(3);
  const [overallPot, setOverallPot] = useState<number>(3);

  const [questionText, setQuestionText] = useState('');

  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [loadingRating, setLoadingRating] = useState(false);
  const [loadingQuestion, setLoadingQuestion] = useState(false);

  const [ratingMessage, setRatingMessage] = useState<ToastMessage | null>(null);
  const [questionMessage, setQuestionMessage] = useState<ToastMessage | null>(null);

  const fetchTeamAndEventData = async () => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const { data: team } = await supabase
        .from('teams')
        .select('*')
        .eq('auth_user_id', user.id)
        .single();

      setMyTeam((team as Team) || null);

      if (team) {
        // Fetch questions asked by my team
        const { data: qData } = await supabase
          .from('questions')
          .select('*')
          .eq('asking_team_id', team.id)
          .order('created_at', { ascending: false });

        setMyQuestions((qData as Question[]) || []);
      }
    }

    // Fetch Event State & Current Pitch
    const { data: es } = await supabase.from('event_state').select('*').eq('id', 1).single();
    setEventState((es as EventState) || null);

    // Podium reveal data: RLS only lets team role read this once
    // results_revealed = true (see migration), so this is a no-op fetch
    // pre-reveal — the UI gate below also never renders it before then.
    if (es?.results_revealed) {
      const { data: finalLb } = await supabase.from('pitch_leaderboard').select('*').eq('round_name', 'final');
      const { data: prelimLb } = await supabase.from('pitch_leaderboard').select('*').eq('round_name', 'prelim');
      setPodiumLeaderboard(finalLb && finalLb.length > 0 ? (finalLb as PitchLeaderboardEntry[]) : ((prelimLb as PitchLeaderboardEntry[]) || []));
    }
    if (es?.current_pitch_id) {
      const { data: pData } = await supabase
        .from('pitches')
        .select('*, teams(*)')
        .eq('id', es.current_pitch_id)
        .single();

      setCurrentPitch((pData as any) || null);
    } else {
      setCurrentPitch(null);
    }

    // Up-next queue (next 3-5 teams), so waiting teams know when to
    // prepare — read-only, no scores, consistent with the pre-reveal
    // leaderboard restriction below.
    const { data: queuedPitches } = await supabase
      .from('pitches')
      .select('team_id, pitch_order, queue_position_override, teams(*)')
      .eq('queue_status', 'queued')
      .order('pitch_order', { ascending: true });

    if (queuedPitches && queuedPitches.length > 0) {
      const sorted = [...queuedPitches].sort((a: any, b: any) => {
        const aKey = a.queue_position_override ?? a.pitch_order;
        const bKey = b.queue_position_override ?? b.pitch_order;
        return aKey - bKey;
      });
      setUpNextTeams(sorted.slice(0, 5).map((p: any) => p.teams).filter(Boolean));
    } else {
      setUpNextTeams([]);
    }

    setLoadingTeam(false);
  };

  useEffect(() => {
    fetchTeamAndEventData();

    const supabase = createClient();
    const channel = supabase
      .channel('team_portal_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_state' }, () => fetchTeamAndEventData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitches' }, () => fetchTeamAndEventData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, () => fetchTeamAndEventData())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const pitchingTeam = currentPitch?.teams;
  const isOwnTeam = pitchingTeam && myTeam && pitchingTeam.id === myTeam.id;
  const isSamePool = pitchingTeam && myTeam && pitchingTeam.pool === myTeam.pool;
  const canVote = currentPitch && pitchingTeam && myTeam && !isOwnTeam && !isSamePool;

  const handleRatingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPitch) return;
    setLoadingRating(true);
    setRatingMessage(null);

    const res = await submitAudienceRatingAction({
      pitchId: currentPitch.id,
      scores: {
        problem_relevance: problemRel,
        creativity,
        solution_quality: solQuality,
        pitch_quality: pitchQuality,
        overall_potential: overallPot,
      },
    });

    setLoadingRating(false);
    if (res.error) {
      setRatingMessage({ type: 'error', text: res.error });
    } else {
      setRatingSubmitted(true);
    }
  };

  const handleQuestionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPitch) return;
    setLoadingQuestion(true);
    setQuestionMessage(null);

    const res = await submitQuestionAction({
      pitchId: currentPitch.id,
      questionText,
    });

    setLoadingQuestion(false);
    if (res.error) {
      setQuestionMessage({ type: 'error', text: res.error });
    } else {
      setQuestionMessage({ type: 'success', text: 'Submitted — pending organiser review' });
      setQuestionText('');
      fetchTeamAndEventData();
    }
  };

  if (loadingTeam) {
    return (
      <div className="min-h-screen flex flex-col" data-density="dense">
        <Navbar userRole="team" />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-text-secondary font-mono">Loading your team...</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" data-density="dense">
      <Navbar userRole="team" teamName={myTeam?.team_name} />

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 w-full">
        {/* Synced Countdown Timer */}
        <CountdownTimer initialState={eventState || undefined} />

        {/* BIG NOW PITCHING BANNER */}
        <div className="panel rounded-3xl p-6 sm:p-8 text-center space-y-4 relative overflow-hidden">
          <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-accent-live/15 text-accent-live border border-accent-live/40 text-xs font-extrabold tracking-widest uppercase">
            <Flame className="w-4 h-4" />
            <span>NOW PITCHING LIVE</span>
          </div>

          {currentPitch && pitchingTeam ? (
            <div className="space-y-2">
              <h1 className="font-display text-3xl sm:text-5xl font-bold text-text-primary tracking-tight">
                {pitchingTeam.team_name}
              </h1>
              <div className="flex items-center justify-center space-x-4 text-xs sm:text-sm text-text-secondary">
                <span className="px-3 py-1 rounded-lg bg-white/5 border border-panel-border font-bold">
                  Domain: <span className="text-accent-warm">{pitchingTeam.domain}</span>
                </span>
                <span className="px-3 py-1 rounded-lg bg-white/5 border border-panel-border font-bold">
                  Pool <span className="text-brand-500">{pitchingTeam.pool}</span>
                </span>
              </div>
            </div>
          ) : (
            <div className="py-6 space-y-2">
              <h2 className="text-2xl font-bold text-text-secondary">Waiting for next pitch to begin...</h2>
              <p className="text-xs text-text-secondary/70">The Organiser will set the live pitching team shortly.</p>
            </div>
          )}
        </div>

        {/* LIVE QUEUE: Up Next (read-only, no scores) */}
        {upNextTeams.length > 0 && (
          <div className="card rounded-2xl p-4 space-y-2">
            <div className="flex items-center space-x-2 mb-1">
              <ListOrdered className="w-4 h-4 text-text-secondary" />
              <span className="text-[10px] uppercase tracking-wider text-text-secondary font-mono">Up Next</span>
            </div>
            <div className="space-y-1.5">
              {upNextTeams.map((team, idx) => (
                <div
                  key={team.id}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl ${
                    myTeam && team.id === myTeam.id ? 'border border-accent-warm/50 bg-accent-warm/10' : 'bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono text-text-secondary shrink-0">#{idx + 1}</span>
                    <p className="text-sm font-bold text-text-primary truncate">
                      {team.team_name}
                      {myTeam && team.id === myTeam.id && (
                        <span className="ml-2 text-accent-warm">— that&apos;s you, get ready!</span>
                      )}
                    </p>
                  </div>
                  <PoolBadge pool={team.pool} className="shrink-0" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AUDIENCE VOTING & QUESTION SUBMISSION PANEL */}
        {currentPitch && pitchingTeam && (
          <div>
            {canVote ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* 5-CRITERIA SLIDERS FORM */}
                <div className="card rounded-2xl p-6 space-y-5">
                  <div className="flex items-center space-x-3">
                    <Trophy className="w-5 h-5 text-accent-warm" />
                    <div>
                      <h3 className="text-lg font-bold text-text-primary">Rate Rivals&apos; Pitch</h3>
                      <p className="text-xs text-text-secondary">Evaluate {pitchingTeam.team_name} (Pool {pitchingTeam.pool}) on 1–5 scale</p>
                    </div>
                  </div>

                  <Toast message={ratingMessage} />

                  {ratingSubmitted ? (
                    <div className="p-6 text-center space-y-3 bg-success-500/10 border border-success-500/30 rounded-xl">
                      <CheckCircle2 className="w-10 h-10 text-success-500 mx-auto" />
                      <h4 className="font-bold text-text-primary text-base">Rating Submitted!</h4>
                      <p className="text-xs text-text-secondary">Your scores have been included in the normalized audience rating view.</p>
                    </div>
                  ) : (
                    <form onSubmit={handleRatingSubmit} className="space-y-4">
                      <div>
                        <div className="flex justify-between text-xs font-medium text-text-secondary mb-1">
                          <span>Problem Relevance</span>
                          <span className="font-bold text-brand-500">{problemRel} / 5</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={problemRel}
                          onChange={(e) => setProblemRel(Number(e.target.value))}
                          className="w-full accent-brand-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-xs font-medium text-text-secondary mb-1">
                          <span>Creativity & Originality</span>
                          <span className="font-bold text-brand-500">{creativity} / 5</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={creativity}
                          onChange={(e) => setCreativity(Number(e.target.value))}
                          className="w-full accent-brand-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-xs font-medium text-text-secondary mb-1">
                          <span>Solution Quality</span>
                          <span className="font-bold text-brand-500">{solQuality} / 5</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={solQuality}
                          onChange={(e) => setSolQuality(Number(e.target.value))}
                          className="w-full accent-brand-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-xs font-medium text-text-secondary mb-1">
                          <span>Pitch Quality & Clad</span>
                          <span className="font-bold text-brand-500">{pitchQuality} / 5</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={pitchQuality}
                          onChange={(e) => setPitchQuality(Number(e.target.value))}
                          className="w-full accent-brand-500"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-xs font-medium text-text-secondary mb-1">
                          <span>Overall Potential</span>
                          <span className="font-bold text-brand-500">{overallPot} / 5</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={overallPot}
                          onChange={(e) => setOverallPot(Number(e.target.value))}
                          className="w-full accent-brand-500"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={loadingRating}
                        className="w-full py-2.5 rounded-xl font-bold text-xs bg-brand-500 hover:bg-brand-500/90 text-white transition-colors shadow-brand-glow"
                      >
                        {loadingRating ? 'Submitting...' : 'Submit Audience Rating'}
                      </button>
                    </form>
                  )}
                </div>

                {/* QUESTION SUBMISSION FORM */}
                <div className="card rounded-2xl p-6 space-y-5">
                  <div className="flex items-center space-x-3">
                    <HelpCircle className="w-5 h-5 text-accent-live" />
                    <div>
                      <h3 className="text-lg font-bold text-text-primary">Pressure Test Q&A</h3>
                      <p className="text-xs text-text-secondary">Submit a challenging question for {pitchingTeam.team_name}</p>
                    </div>
                  </div>

                  <Toast message={questionMessage} />

                  <form onSubmit={handleQuestionSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">Your Question</label>
                      <textarea
                        required
                        rows={4}
                        placeholder="Ask about unit economics, technical feasibility, scalability..."
                        value={questionText}
                        onChange={(e) => setQuestionText(e.target.value)}
                        className="w-full bg-white/5 border border-panel-border rounded-xl p-3 text-xs text-text-primary focus:outline-none focus:border-accent-live transition-colors"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={loadingQuestion}
                      className="w-full py-2.5 rounded-xl font-bold text-xs bg-accent-live hover:bg-accent-live/90 text-white transition-colors shadow-live-glow flex items-center justify-center space-x-2"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>{loadingQuestion ? 'Submitting Question...' : 'Submit Question for Review'}</span>
                    </button>
                  </form>
                </div>
              </div>
            ) : (
              <div className="card rounded-2xl p-6 text-center space-y-2">
                <ShieldAlert className="w-8 h-8 text-accent-warm mx-auto" />
                <h3 className="text-base font-bold text-text-primary">Voting Restricted for this Pitch</h3>
                <p className="text-xs text-text-secondary max-w-md mx-auto">
                  {isOwnTeam
                    ? 'This is your own team pitching! You cannot rate or ask questions on your own pitch.'
                    : `You are in Pool ${myTeam?.pool} alongside ${pitchingTeam.team_name}. Audience voting is only allowed for teams pitching from the opposite pool.`}
                </p>
              </div>
            )}
          </div>
        )}

        {/* LEADERBOARD: hidden from Team role until the Organiser reveals
            results (event_state.results_revealed). This is enforced at
            the RLS level too (pitch_scores/audience_scores SELECT
            policies) — this UI gate is a courtesy, not the real boundary. */}
        {eventState?.results_revealed ? (
          <div className="card rounded-2xl p-6 sm:p-8">
            <PodiumReveal leaderboard={podiumLeaderboard} variant="compact" />
          </div>
        ) : (
          <div className="card rounded-2xl p-8 text-center space-y-2">
            <Lock className="w-10 h-10 text-text-secondary/50 mx-auto" />
            <h3 className="text-base font-bold text-text-primary">Results Not Yet Revealed</h3>
            <p className="text-xs text-text-secondary max-w-md mx-auto">
              Rankings and scores stay hidden from teams until the Organiser reveals the results at the end of the event.
            </p>
          </div>
        )}

        {/* YOUR TEAM'S JOURNEY SUMMARY */}
        <div className="card rounded-2xl p-6 space-y-4">
          <h3 className="text-lg font-bold text-text-primary flex items-center space-x-2">
            <Users className="w-5 h-5 text-brand-500" />
            <span>Your Team&apos;s Event Journey</span>
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white/[0.03] p-4 rounded-xl border border-panel-border space-y-2">
              <span className="text-xs font-bold text-text-secondary uppercase tracking-wider block">Assigned Team Details</span>
              <p className="text-xs text-text-secondary">Team Name: <span className="text-text-primary font-bold">{myTeam?.team_name}</span></p>
              <p className="text-xs text-text-secondary">Sector Domain: <span className="text-accent-warm font-bold">{myTeam?.domain}</span></p>
              <p className="text-xs text-text-secondary">Assigned Pool: <span className="text-brand-500 font-bold">Pool {myTeam?.pool}</span></p>
            </div>

            <div className="bg-white/[0.03] p-4 rounded-xl border border-panel-border space-y-2">
              <span className="text-xs font-bold text-text-secondary uppercase tracking-wider block">Questions Asked ({myQuestions.length})</span>
              {myQuestions.length === 0 ? (
                <p className="text-xs text-text-secondary/70">No questions submitted yet.</p>
              ) : (
                <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                  {myQuestions.map((q) => (
                    <div key={q.id} className="p-2 rounded bg-black/20 text-xs border border-panel-border">
                      <p className="text-text-primary line-clamp-2">{q.question_text}</p>
                      <div className="flex items-center justify-between text-[10px] text-text-secondary mt-1">
                        <span>Status: <strong className="text-brand-500 uppercase">{q.status}</strong></span>
                        {q.points_asking > 0 && <span className="text-accent-warm font-bold">+{q.points_asking} pts earned</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
