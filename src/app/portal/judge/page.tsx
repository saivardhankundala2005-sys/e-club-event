'use client';

import { useState, useEffect, useCallback } from 'react';
import Navbar from '@/src/components/Navbar';
import PitchQueuePanel from '@/src/components/PitchQueuePanel';
import QuestionQueuePanel from '@/src/components/QuestionQueuePanel';
import LiveLeaderboard from '@/src/components/LiveLeaderboard';
import PodiumReveal from '@/src/components/PodiumReveal';
import ScoredPitchesList from '@/src/components/ScoredPitchesList';
import { Award, HelpCircle, ListChecks, Trophy } from 'lucide-react';
import { createClient } from '@/src/lib/supabase/client';
import { EventState, Pitch, Team, Question, PitchLeaderboardEntry } from '@/src/lib/types';

export default function JudgePortalPage() {
  const [activeTab, setActiveTab] = useState<'live' | 'questions' | 'scored' | 'leaderboard'>('live');

  const [eventState, setEventState] = useState<EventState | null>(null);
  const [pitches, setPitches] = useState<(Pitch & { teams?: Team })[]>([]);
  const [approvedQuestions, setApprovedQuestions] = useState<Question[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<Question[]>([]);
  const [leaderboard, setLeaderboard] = useState<PitchLeaderboardEntry[]>([]);
  const [podiumLeaderboard, setPodiumLeaderboard] = useState<PitchLeaderboardEntry[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    const { data: es } = await supabase.from('event_state').select('*').eq('id', 1).single();
    setEventState((es as EventState) || null);

    const { data: pData } = await supabase
      .from('pitches')
      .select('*, teams(*)')
      .order('pitch_order', { ascending: true });
    setPitches((pData as any) || []);

    if (es?.current_pitch_id) {
      const { data: aqData } = await supabase
        .from('questions')
        .select('*, asking_team:teams(*)')
        .eq('pitch_id', es.current_pitch_id)
        .eq('status', 'approved');
      setApprovedQuestions((aqData as any) || []);
    } else {
      setApprovedQuestions([]);
    }

    const { data: pqData } = await supabase
      .from('questions')
      .select('*, asking_team:teams(*)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    setPendingQuestions((pqData as any) || []);

    const { data: lbData } = await supabase.from('pitch_leaderboard').select('*').eq('round_name', 'prelim');
    setLeaderboard((lbData as PitchLeaderboardEntry[]) || []);

    // Podium reveal banner (section 7): Final round's own scoring if one
    // ran, otherwise falls back to the same prelim data as above.
    const { data: finalLb } = await supabase.from('pitch_leaderboard').select('*').eq('round_name', 'final');
    setPodiumLeaderboard(finalLb && finalLb.length > 0 ? (finalLb as PitchLeaderboardEntry[]) : ((lbData as PitchLeaderboardEntry[]) || []));

    setLoadingData(false);
  }, []);

  useEffect(() => {
    fetchData();

    const supabase = createClient();
    const channel = supabase
      .channel('judge_portal_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_state' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitches' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitch_scores' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, () => fetchData())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  const tabs = [
    { key: 'live' as const, label: 'Live / Up Next', icon: Award, active: 'bg-brand-500 text-white shadow-brand-glow' },
    { key: 'questions' as const, label: 'Question Queue', icon: HelpCircle, active: 'bg-accent-live text-white shadow-live-glow' },
    { key: 'scored' as const, label: 'Scored', icon: ListChecks, active: 'bg-success-500 text-white' },
    { key: 'leaderboard' as const, label: 'Leaderboard', icon: Trophy, active: 'bg-accent-warm text-bg-base shadow-warm-glow' },
  ];

  if (loadingData) {
    return (
      <div className="min-h-screen flex flex-col" data-density="dense">
        <Navbar userRole="judge" />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-text-secondary font-mono">Loading judge panel...</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" data-density="dense">
      <Navbar userRole="judge" />

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 w-full">
        <div className="panel rounded-2xl p-2 flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-xl font-bold text-xs transition-all flex items-center space-x-2 ${
                activeTab === tab.key ? tab.active : 'bg-white/5 text-text-secondary hover:bg-white/10'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {activeTab === 'live' && (
          <PitchQueuePanel
            eventState={eventState}
            pitches={pitches}
            approvedQuestions={approvedQuestions}
            onDataChange={fetchData}
          />
        )}

        {activeTab === 'questions' && (
          <QuestionQueuePanel pendingQuestions={pendingQuestions} onDataChange={fetchData} />
        )}

        {activeTab === 'scored' && <ScoredPitchesList entries={leaderboard} />}

        {activeTab === 'leaderboard' && (
          <div className="space-y-6">
            {eventState?.results_revealed && (
              <div className="card rounded-2xl p-6">
                <PodiumReveal leaderboard={podiumLeaderboard} variant="compact" />
              </div>
            )}
            <LiveLeaderboard roundName="prelim" />
          </div>
        )}
      </main>
    </div>
  );
}
