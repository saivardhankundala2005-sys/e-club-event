'use client';

import { useEffect, useState } from 'react';
import { Reorder } from 'framer-motion';
import { GripVertical, Flame, Lock, HelpCircle, CheckCircle2, SkipForward } from 'lucide-react';
import CountdownTimer from '@/src/components/CountdownTimer';
import PoolBadge from '@/src/components/PoolBadge';
import Toast, { ToastMessage } from '@/src/components/Toast';
import { EventState, Pitch, Team, Question } from '@/src/lib/types';
import {
  callToStageAction,
  reorderQueueAction,
  startTimerAction,
  pauseTimerAction,
  resetTimerAction,
  endPitchAction,
  submitPitchScoreAction,
} from '@/src/app/actions/pitchQueueActions';

type PitchWithTeam = Pitch & { teams?: Team };

interface PitchQueuePanelProps {
  eventState: EventState | null;
  pitches: PitchWithTeam[];
  approvedQuestions: Question[];
  onDataChange: () => void;
}

function sortQueue(pitches: PitchWithTeam[]) {
  return [...pitches]
    .filter((p) => p.queue_status === 'queued')
    .sort((a, b) => {
      const aKey = a.queue_position_override ?? a.pitch_order;
      const bKey = b.queue_position_override ?? b.pitch_order;
      return aKey - bKey;
    });
}

export default function PitchQueuePanel({ eventState, pitches, approvedQuestions, onDataChange }: PitchQueuePanelProps) {
  const [queue, setQueue] = useState<PitchWithTeam[]>(sortQueue(pitches));
  const [loadingAction, setLoadingAction] = useState(false);
  const [scoreMessage, setScoreMessage] = useState<ToastMessage | null>(null);
  const [actionError, setActionError] = useState<ToastMessage | null>(null);

  // Judges always enter on a uniform 0-10 scale; category weighting
  // (x2 / x1.5) is applied server-side in pitch_leaderboard, never here.
  const [probMarket, setProbMarket] = useState(5);
  const [solInnovation, setSolInnovation] = useState(5);
  const [feasibility, setFeasibility] = useState(5);
  const [storytelling, setStorytelling] = useState(5);

  useEffect(() => {
    setQueue(sortQueue(pitches));
  }, [pitches]);

  const currentPitch = pitches.find((p) => p.id === eventState?.current_pitch_id) || null;
  const pitchingTeam = currentPitch?.teams;

  const handleReorder = async (newOrder: PitchWithTeam[]) => {
    setQueue(newOrder);
    const res = await reorderQueueAction(newOrder.map((p) => p.id));
    if ((res as any)?.error) setActionError({ type: 'error', text: (res as any).error });
    onDataChange();
  };

  const handleCallToStage = async (pitchId: string) => {
    setLoadingAction(true);
    setActionError(null);
    const res = await callToStageAction(pitchId);
    setLoadingAction(false);
    if (res.error) setActionError({ type: 'error', text: res.error });
    onDataChange();
  };

  const handleSkip = async (pitch: PitchWithTeam) => {
    if (!confirm(`Move ${pitch.teams?.team_name || 'this team'} to the back of the queue? Use this for no-shows — they'll stay queued and can be called later.`)) return;
    setLoadingAction(true);
    setActionError(null);
    const reordered = [...queue.filter((p) => p.id !== pitch.id), pitch];
    setQueue(reordered);
    const res = await reorderQueueAction(reordered.map((p) => p.id));
    setLoadingAction(false);
    if ((res as any)?.error) setActionError({ type: 'error', text: (res as any).error });
    onDataChange();
  };

  const handleEndPitch = async () => {
    if (!confirm(`End the pitch for ${pitchingTeam?.team_name || 'this team'} now and move to scoring?`)) return;
    setActionError(null);
    const r = await endPitchAction();
    if (r.error) setActionError({ type: 'error', text: r.error });
    onDataChange();
  };

  const handleSubmitScore = async () => {
    if (!currentPitch) return;
    setLoadingAction(true);
    setScoreMessage(null);

    const res = await submitPitchScoreAction({
      pitchId: currentPitch.id,
      scores: {
        problem_market: probMarket,
        solution_innovation: solInnovation,
        feasibility,
        pitch_storytelling: storytelling,
      },
    });

    setLoadingAction(false);
    if (res.error) {
      setScoreMessage({ type: 'error', text: res.error });
    } else {
      setScoreMessage({ type: 'success', text: 'Score submitted & locked!' });
      onDataChange();
    }
  };

  return (
    <div className="space-y-8">
      <CountdownTimer
        initialState={eventState || undefined}
        showControls={true}
        onStart={async () => { setActionError(null); const r = await startTimerAction(); if (r.error) { setActionError({ type: 'error', text: r.error }); onDataChange(); } }}
        onPause={async () => { setActionError(null); const r = await pauseTimerAction(); if (r.error) { setActionError({ type: 'error', text: r.error }); onDataChange(); } }}
        onReset={async () => { setActionError(null); const r = await resetTimerAction(); if (r.error) { setActionError({ type: 'error', text: r.error }); onDataChange(); } }}
        onEnd={handleEndPitch}
      />

      <Toast message={actionError} />

      {/* CURRENT PITCH CONTEXT */}
      <div className="panel rounded-3xl p-6 sm:p-8">
        {pitchingTeam ? (
          <div className="space-y-4">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div>
                <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-brand-500/15 text-brand-500 border border-brand-500/40 text-xs font-bold uppercase tracking-wider mb-2">
                  <Flame className="w-4 h-4" />
                  <span>ON STAGE • {currentPitch?.queue_status.toUpperCase()}</span>
                </div>
                <h1 className="font-display text-2xl sm:text-3xl font-bold text-text-primary">{pitchingTeam.team_name}</h1>
                <p className="text-xs text-text-secondary mt-1 flex items-center gap-2">
                  Domain: <span className="text-accent-warm font-bold">{pitchingTeam.domain}</span>
                  <PoolBadge pool={pitchingTeam.pool} />
                </p>
              </div>
            </div>

            {approvedQuestions.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-bold text-text-secondary uppercase flex items-center space-x-1.5">
                  <HelpCircle className="w-3.5 h-3.5 text-accent-live" />
                  <span>Approved Q&A Context</span>
                </h3>
                <div className="space-y-2">
                  {approvedQuestions.map((q) => (
                    <div key={q.id} className="p-3 rounded-xl bg-white/[0.03] border border-panel-border text-xs text-text-primary">
                      {q.question_text}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentPitch?.queue_status === 'awaiting_score' && (
              <div className="pt-4 border-t border-panel-border space-y-5">
                <Toast message={scoreMessage} />

                <ScoreSlider label="1. Problem & Market Insight (weighted 20%)" max={10} value={probMarket} onChange={setProbMarket} />
                <ScoreSlider label="2. Solution & Innovation (weighted 20%)" max={10} value={solInnovation} onChange={setSolInnovation} />
                <ScoreSlider label="3. Feasibility & Business Model (weighted 15%)" max={10} value={feasibility} onChange={setFeasibility} />
                <ScoreSlider label="4. Pitch & Storytelling (weighted 15%)" max={10} value={storytelling} onChange={setStorytelling} />

                <button
                  onClick={handleSubmitScore}
                  disabled={loadingAction}
                  className="w-full py-3.5 rounded-xl font-bold text-sm bg-brand-500 hover:bg-brand-500/90 text-white transition-all shadow-brand-glow flex items-center justify-center space-x-2"
                >
                  <Lock className="w-4 h-4" />
                  <span>{loadingAction ? 'Submitting & Locking...' : 'Submit & Lock Score for this Pitch'}</span>
                </button>
              </div>
            )}

            {currentPitch?.queue_status === 'scored' && (
              <div className="p-4 text-center bg-success-500/10 border border-success-500/30 rounded-xl text-xs text-success-500 flex items-center justify-center space-x-2">
                <CheckCircle2 className="w-4 h-4" />
                <span>This pitch has been scored. See the Scored tab.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6">
            <Flame className="w-10 h-10 text-text-secondary/40 mx-auto mb-2" />
            <h3 className="text-base font-bold text-text-primary">No Pitch Called to Stage</h3>
            <p className="text-xs text-text-secondary mt-1">Call the next team from the queue below.</p>
          </div>
        )}
      </div>

      {/* QUEUE */}
      <div className="card rounded-2xl p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-text-primary">Up Next Queue</h2>
          <p className="text-xs text-text-secondary">Registration order by default — drag to reorder for real-world adjustments.</p>
        </div>

        {queue.length === 0 ? (
          <p className="text-xs text-text-secondary/70 italic py-4 text-center">No teams currently queued.</p>
        ) : (
          <Reorder.Group axis="y" values={queue} onReorder={handleReorder} className="space-y-2">
            {queue.map((p, i) => (
              <Reorder.Item
                key={p.id}
                value={p}
                className="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.03] border border-panel-border cursor-grab active:cursor-grabbing"
              >
                <div className="flex items-center space-x-3 min-w-0">
                  <GripVertical className="w-4 h-4 text-text-secondary/50 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-bold text-text-primary truncate">{p.teams?.team_name || 'Unassigned'}</p>
                      {i === 0 && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent-warm/15 text-accent-warm border border-accent-warm/40 shrink-0 uppercase tracking-wider">
                          Next Up
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-secondary flex items-center gap-1.5">
                      Domain: <span className="text-accent-warm">{p.teams?.domain}</span>
                      {p.teams && <PoolBadge pool={p.teams.pool} />}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleSkip(p)}
                    disabled={loadingAction}
                    title="Skip — send to back of queue (no-show)"
                    className="px-2 py-1.5 rounded-lg font-bold text-xs bg-white/5 hover:bg-white/10 text-text-secondary border border-panel-border transition-all flex items-center gap-1"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleCallToStage(p.id)}
                    disabled={loadingAction}
                    className="px-3 py-1.5 rounded-lg font-bold text-xs bg-brand-500/15 hover:bg-brand-500 hover:text-white text-brand-500 border border-brand-500/40 transition-all"
                  >
                    Call to Stage
                  </button>
                </div>
              </Reorder.Item>
            ))}
          </Reorder.Group>
        )}
      </div>
    </div>
  );
}

function ScoreSlider({
  label,
  max,
  value,
  onChange,
}: {
  label: string;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="p-4 rounded-xl bg-white/[0.03] border border-panel-border space-y-2">
      <div className="flex justify-between items-center text-sm font-semibold">
        <span className="text-text-primary">{label}</span>
        <div className="flex items-center space-x-2">
          <input
            type="number"
            min={0}
            max={max}
            value={value}
            onChange={(e) => onChange(Math.max(0, Math.min(Number(e.target.value) || 0, max)))}
            className="w-14 bg-black/20 border border-panel-border rounded-lg px-2 py-1 text-xs text-text-primary font-mono text-center focus:outline-none focus:border-brand-500"
          />
          <span className="text-xs text-text-secondary font-mono">/ {max}</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-500"
      />
    </div>
  );
}
