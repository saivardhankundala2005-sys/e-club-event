'use client';

import { useState, useEffect, useCallback } from 'react';
import Navbar from '@/src/components/Navbar';
import PitchQueuePanel from '@/src/components/PitchQueuePanel';
import QuestionQueuePanel from '@/src/components/QuestionQueuePanel';
import LiveLeaderboard from '@/src/components/LiveLeaderboard';
import PodiumReveal from '@/src/components/PodiumReveal';
import ManualOverrideModal from '@/src/components/ManualOverrideModal';
import { triggerConfetti } from '@/src/components/ConfettiEffect';
import { ShieldAlert, Flame, Users, HelpCircle, Trophy, Sparkles, FileSpreadsheet, PartyPopper } from 'lucide-react';
import { createClient } from '@/src/lib/supabase/client';
import { EventState, Pitch, Team, Question, PitchLeaderboardEntry, ScoreAuditLog } from '@/src/lib/types';
import {
  qualifyFinalFourAction,
  exportRegistrationsCsvAction,
  revealTopThreeAction,
} from '@/src/app/actions/organiserActions';

export default function OrganiserPortalPage() {
  const [activeTab, setActiveTab] = useState<'control' | 'registrations' | 'questions' | 'leaderboard' | 'audit'>('control');

  const [eventState, setEventState] = useState<EventState | null>(null);
  const [pitches, setPitches] = useState<(Pitch & { teams?: Team })[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamMembers, setTeamMembers] = useState<any[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<Question[]>([]);
  const [auditLogs, setAuditLogs] = useState<ScoreAuditLog[]>([]);
  const [approvedQuestions, setApprovedQuestions] = useState<Question[]>([]);
  const [leaderboard, setLeaderboard] = useState<PitchLeaderboardEntry[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [selectedOverrideEntry, setSelectedOverrideEntry] = useState<PitchLeaderboardEntry | null>(null);
  const [qualifySuccessMsg, setQualifySuccessMsg] = useState<string | null>(null);
  const [loadingAction, setLoadingAction] = useState(false);

  const fetchOrganiserData = useCallback(async () => {
    const supabase = createClient();

    const { data: es } = await supabase.from('event_state').select('*').eq('id', 1).single();
    setEventState((es as EventState) || null);

    const { data: pData } = await supabase
      .from('pitches')
      .select('*, teams(*)')
      .order('pitch_order', { ascending: true });
    setPitches((pData as any) || []);

    const { data: tData } = await supabase.from('teams').select('*').order('created_at', { ascending: false });
    setTeams((tData as Team[]) || []);

    const { data: tmData } = await supabase.from('team_members').select('*');
    setTeamMembers(tmData || []);

    const { data: qData } = await supabase
      .from('questions')
      .select('*, asking_team:teams(*)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setPendingQuestions((qData as any) || []);

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

    const { data: auditData } = await supabase
      .from('score_audit_log')
      .select('*')
      .order('timestamp', { ascending: false });
    setAuditLogs((auditData as ScoreAuditLog[]) || []);

    // For the podium reveal banner: Final round's own scoring if one ran,
    // otherwise the prelim leaderboard (section 7's round-structure rule).
    const { data: finalLb } = await supabase.from('pitch_leaderboard').select('*').eq('round_name', 'final');
    if (finalLb && finalLb.length > 0) {
      setLeaderboard(finalLb as PitchLeaderboardEntry[]);
    } else {
      const { data: prelimLb } = await supabase.from('pitch_leaderboard').select('*').eq('round_name', 'prelim');
      setLeaderboard((prelimLb as PitchLeaderboardEntry[]) || []);
    }

    setLoadingData(false);
  }, []);

  useEffect(() => {
    fetchOrganiserData();

    const supabase = createClient();
    const channel = supabase
      .channel('organiser_portal_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_state' }, () => fetchOrganiserData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitches' }, () => fetchOrganiserData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pitch_scores' }, () => fetchOrganiserData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, () => fetchOrganiserData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' }, () => fetchOrganiserData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'score_audit_log' }, () => fetchOrganiserData())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchOrganiserData]);

  const handleQualifyFinalFour = async () => {
    setLoadingAction(true);
    setQualifySuccessMsg(null);

    const res = await qualifyFinalFourAction();
    setLoadingAction(false);

    if (res.success) {
      triggerConfetti();
      setQualifySuccessMsg('Top 2 Pool A & Top 2 Pool B Qualified for Final 4!');
      fetchOrganiserData();
    }
  };

  const handleRevealTopThree = async () => {
    if (!confirm('Reveal the Top 3 & full leaderboard to everyone now? This cannot be undone during the event.')) return;
    setLoadingAction(true);
    const res = await revealTopThreeAction();
    setLoadingAction(false);
    if (res.success) {
      fetchOrganiserData();
    } else if (res.error) {
      alert(res.error);
    }
  };

  const exportRegistrationsCSV = async () => {
    const res = await exportRegistrationsCsvAction();
    if (res.error || !res.csv) {
      alert(res.error || 'Failed to export CSV.');
      return;
    }

    const csvContent = 'data:text/csv;charset=utf-8,' + res.csv;
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `pitch_under_pressure_teams_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const tabs = [
    { key: 'control' as const, label: 'Live Control Room', icon: Flame, badge: null, active: 'bg-brand-500 text-white shadow-brand-glow' },
    { key: 'questions' as const, label: 'Question Queue', icon: HelpCircle, badge: pendingQuestions.length, active: 'bg-accent-live text-white shadow-live-glow' },
    { key: 'leaderboard' as const, label: 'Live Leaderboard & Overrides', icon: Trophy, badge: null, active: 'bg-accent-warm text-bg-base shadow-warm-glow' },
    { key: 'registrations' as const, label: `Team Registrations (${teams.length})`, icon: Users, badge: null, active: 'bg-brand-500 text-white shadow-brand-glow' },
    { key: 'audit' as const, label: `Score Audit Log (${auditLogs.length})`, icon: ShieldAlert, badge: null, active: 'bg-white/10 text-text-primary' },
  ];

  if (loadingData) {
    return (
      <div className="min-h-screen flex flex-col" data-density="dense">
        <Navbar userRole="organiser" />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-4 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-text-secondary font-mono">Loading control room...</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col" data-density="dense">
      <Navbar userRole="organiser" />

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8 w-full">
        {/* ORGANISER TABS HEADER */}
        <div className="panel rounded-2xl p-2 flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-xl font-bold text-xs transition-all flex items-center space-x-2 relative ${
                activeTab === tab.key ? tab.active : 'bg-white/5 text-text-secondary hover:bg-white/10'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {!!tab.badge && (
                <span className="w-5 h-5 rounded-full bg-danger-500 text-white font-mono font-bold text-[10px] flex items-center justify-center">
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* TAB 1: LIVE CONTROL PANEL — reuses the exact same PitchQueuePanel
            component as the Judge Portal so queue/timer/scoring controls
            can never drift out of sync between the two roles. */}
        {activeTab === 'control' && (
          <div className="space-y-8">
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={handleQualifyFinalFour}
                disabled={loadingAction}
                className="px-4 py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-accent-warm via-amber-500 to-yellow-400 text-bg-base shadow-warm-glow hover:scale-105 transition-all flex items-center space-x-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>Reveal Final 4 & Qualify</span>
              </button>

              {/* Organiser-only, single end-of-event moment: flips
                  results_revealed and broadcasts the podium ceremony to
                  Team/Judge/Organiser/Display via Realtime. */}
              <button
                onClick={handleRevealTopThree}
                disabled={loadingAction || eventState?.results_revealed}
                className="px-4 py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-brand-500 via-purple-500 to-accent-live text-white shadow-brand-glow hover:scale-105 transition-all flex items-center space-x-2 disabled:opacity-50 disabled:hover:scale-100"
              >
                <PartyPopper className="w-4 h-4" />
                <span>{eventState?.results_revealed ? 'Results Revealed' : 'Reveal Top 3 & Leaderboard'}</span>
              </button>
            </div>

            {qualifySuccessMsg && (
              <div className="p-4 rounded-xl bg-success-500/15 text-success-500 border border-success-500/40 text-xs font-bold text-center">
                {qualifySuccessMsg}
              </div>
            )}

            <PitchQueuePanel
              eventState={eventState}
              pitches={pitches}
              approvedQuestions={approvedQuestions}
              onDataChange={fetchOrganiserData}
            />
          </div>
        )}

        {/* TAB 2: QUESTION QUEUE — shared with Judge portal, see
            QuestionQueuePanel */}
        {activeTab === 'questions' && (
          <QuestionQueuePanel pendingQuestions={pendingQuestions} onDataChange={fetchOrganiserData} />
        )}

        {/* TAB 3: LIVE LEADERBOARD & MANUAL OVERRIDES */}
        {activeTab === 'leaderboard' && (
          <div className="space-y-6">
            {eventState?.results_revealed && (
              <div className="card rounded-2xl p-6">
                <PodiumReveal leaderboard={leaderboard} variant="compact" />
              </div>
            )}
            <LiveLeaderboard
              roundName="prelim"
              showOverrideButton={true}
              onOverrideClick={(entry) => setSelectedOverrideEntry(entry)}
            />
          </div>
        )}

        {/* TAB 4: TEAM REGISTRATIONS TABLE */}
        {activeTab === 'registrations' && (
          <div className="card rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-text-primary flex items-center space-x-2">
                  <Users className="w-5 h-5 text-brand-500" />
                  <span>Registered Startup Teams</span>
                </h2>
                <p className="text-xs text-text-secondary">Full list of teams, assigned sector domains, pools, and members.</p>
              </div>

              <button
                onClick={exportRegistrationsCSV}
                className="px-4 py-2 rounded-xl font-bold text-xs bg-brand-500 hover:bg-brand-500/90 text-white border border-brand-500/40 shadow-brand-glow transition-all flex items-center space-x-2"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>Export CSV</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-panel-border text-text-secondary uppercase tracking-wider font-mono">
                    <th className="py-3 px-4">Team Name</th>
                    <th className="py-3 px-4">Domain</th>
                    <th className="py-3 px-4">Pool</th>
                    <th className="py-3 px-4">Members</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-panel-border">
                  {teams.map((t) => {
                    const members = teamMembers.filter((m) => m.team_id === t.id);

                    return (
                      <tr key={t.id} className="hover:bg-white/[0.03] transition-colors">
                        <td className="py-3 px-4 font-bold text-text-primary">{t.team_name}</td>
                        <td className="py-3 px-4 text-accent-warm">{t.domain}</td>
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 rounded font-bold bg-brand-500/15 text-brand-500 border border-brand-500/30">
                            Pool {t.pool}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="space-y-1">
                            {members.map((m) => (
                              <div key={m.id} className="text-text-secondary">
                                <strong className="text-text-primary/80">{m.name}</strong> <span className="text-text-secondary/70 font-mono text-[10px]">({m.email})</span>
                                {m.is_leader && <span className="ml-1 text-[10px] text-brand-500 font-bold">[Leader]</span>}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 5: SCORE AUDIT LOG */}
        {activeTab === 'audit' && (
          <div className="card rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-text-primary flex items-center space-x-2">
                  <ShieldAlert className="w-5 h-5 text-accent-warm" />
                  <span>Manual Override Audit Log</span>
                </h2>
                <p className="text-xs text-text-secondary">Automated log of all organiser manual score overrides and judge score unlocks.</p>
              </div>
            </div>

            {auditLogs.length === 0 ? (
              <p className="text-xs text-text-secondary/70 italic py-6 text-center">No manual overrides logged yet.</p>
            ) : (
              <div className="space-y-3">
                {auditLogs.map((log) => (
                  <div key={log.id} className="p-3.5 rounded-xl bg-white/[0.03] border border-panel-border space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-accent-warm">Table: {log.table_changed}</span>
                      <span className="text-[10px] text-text-secondary font-mono">{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-text-secondary">Note: <strong className="text-text-primary">{log.note}</strong></p>
                    <div className="text-[10px] text-text-secondary font-mono flex items-center space-x-4">
                      <span>Row ID: {log.row_id}</span>
                      <span>New Value: {JSON.stringify(log.new_value)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Manual Override Modal */}
      {selectedOverrideEntry && (
        <ManualOverrideModal
          entry={selectedOverrideEntry}
          onClose={() => setSelectedOverrideEntry(null)}
        />
      )}
    </div>
  );
}
