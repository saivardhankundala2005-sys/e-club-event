'use client';

import { useEffect, useState } from 'react';
import { Clock, Play, Pause, RotateCcw, Square } from 'lucide-react';
import { createClient } from '@/src/lib/supabase/client';
import { EventState, TimerStatus } from '@/src/lib/types';

interface CountdownTimerProps {
  initialState?: EventState | null;
  showControls?: boolean;
  onStart?: () => void | Promise<void>;
  onPause?: () => void | Promise<void>;
  onReset?: () => void | Promise<void>;
  onEnd?: () => void | Promise<void>;
}

export default function CountdownTimer({
  initialState,
  showControls = false,
  onStart,
  onPause,
  onReset,
  onEnd,
}: CountdownTimerProps) {
  const [eventState, setEventState] = useState<EventState | null>(initialState || null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  // Local optimistic override: applied the instant a control is clicked,
  // before the server round trip resolves. Cleared once a Realtime update
  // (or the next initialState prop) confirms the server agrees, or after a
  // timeout so a failed/slow request doesn't leave stale local state
  // showing forever.
  const [optimisticStatus, setOptimisticStatus] = useState<TimerStatus | null>(null);

  useEffect(() => {
    setEventState(initialState || null);
    setOptimisticStatus(null);
  }, [initialState]);

  useEffect(() => {
    if (optimisticStatus === null) return;
    const t = setTimeout(() => setOptimisticStatus(null), 5000);
    return () => clearTimeout(t);
  }, [optimisticStatus]);

  // Subscribe to Supabase Realtime on `event_state`
  useEffect(() => {
    const supabase = createClient();

    if (!initialState) {
      supabase
        .from('event_state')
        .select('*')
        .eq('id', 1)
        .single()
        .then(({ data }: any) => {
          if (data) setEventState(data as EventState);
        });
    }

    const channel = supabase
      .channel('timer_event_state')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'event_state', filter: 'id=eq.1' },
        (payload: any) => {
          setEventState(payload.new as EventState);
          // The server has now genuinely confirmed a state (this update
          // may be our own action's echo, or another client's) — drop the
          // local override so the real state takes over cleanly.
          setOptimisticStatus(null);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [initialState]);

  // Optimistic-local start timestamp: set the instant Start is clicked, so
  // the countdown can begin ticking from Date.now() before the server's
  // timer_started_at comes back over Realtime.
  const [optimisticStartedAt, setOptimisticStartedAt] = useState<string | null>(null);

  // Effective values: optimistic override where present, else server state.
  const effectiveStatus = optimisticStatus ?? eventState?.timer_status;
  const effectiveStartedAt = optimisticStatus === 'running' ? (optimisticStartedAt ?? eventState?.timer_started_at) : eventState?.timer_started_at;

  // Compute countdown ticker. timer_status defaults to 'idle' and only
  // ever becomes 'running' via an explicit Start Timer action elsewhere —
  // this component never starts the timer on its own.
  useEffect(() => {
    if (!eventState) return;

    const { timer_duration_seconds, timer_paused_remaining } = eventState;
    const status = effectiveStatus;

    if (status === 'idle' || status === 'ended') {
      setSecondsLeft(timer_duration_seconds || 180);
      return;
    }

    if (status === 'paused') {
      setSecondsLeft(timer_paused_remaining ?? 0);
      return;
    }

    const calculateRemaining = () => {
      if (!effectiveStartedAt) return timer_duration_seconds;
      const startTime = new Date(effectiveStartedAt).getTime();
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      return Math.max(0, timer_duration_seconds - elapsed);
    };

    setSecondsLeft(calculateRemaining());

    const interval = setInterval(() => {
      const remaining = calculateRemaining();
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [eventState, effectiveStatus, effectiveStartedAt]);

  const formatTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusBadge = (status?: TimerStatus) => {
    switch (status) {
      case 'running':
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-brand-500/15 text-brand-500 border border-brand-500/40">RUNNING</span>;
      case 'paused':
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-white/5 text-text-secondary border border-panel-border">PAUSED</span>;
      case 'ended':
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-accent-live/15 text-accent-live border border-accent-live/40">ENDED</span>;
      default:
        return <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-white/5 text-text-secondary">IDLE</span>;
    }
  };

  const isLowTime = secondsLeft <= 30 && effectiveStatus === 'running';

  const handleStart = async () => {
    setOptimisticStartedAt(new Date().toISOString());
    setOptimisticStatus('running');
    await onStart?.();
  };
  const handlePause = async () => {
    setOptimisticStatus('paused');
    await onPause?.();
  };
  const handleReset = async () => {
    setOptimisticStatus('idle');
    await onReset?.();
  };
  const handleEnd = async () => {
    setOptimisticStatus('ended');
    await onEnd?.();
  };

  return (
    <div className="card rounded-xl p-4 flex flex-col md:flex-row items-center justify-between gap-4">
      <div className="flex items-center space-x-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isLowTime ? 'bg-danger-500/15 text-danger-500' : 'bg-brand-500/10 text-brand-500'}`}>
          <Clock className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center space-x-2">
            <span className="text-xs uppercase tracking-wider text-text-secondary font-mono">Pitch Timer</span>
            {getStatusBadge(effectiveStatus)}
          </div>
          <p className="text-xs text-text-secondary">Synced across Team, Judge, Organiser screens</p>
        </div>
      </div>

      <div className="flex items-center space-x-6">
        <div className={`font-display tabular-nums text-3xl md:text-4xl font-bold tracking-widest ${isLowTime ? 'text-danger-500' : 'text-text-primary'}`}>
          {formatTime(secondsLeft)}
        </div>

        {showControls && (
          <div className="flex items-center space-x-1.5 bg-white/5 p-1.5 rounded-lg border border-panel-border">
            <button
              onClick={handleStart}
              disabled={effectiveStatus === 'running'}
              className="px-2.5 py-1 text-[11px] font-semibold bg-brand-500/15 text-brand-500 hover:bg-brand-500/25 disabled:opacity-40 rounded transition-colors flex items-center space-x-1"
              title="Start Timer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Start</span>
            </button>
            <button
              onClick={handlePause}
              disabled={effectiveStatus !== 'running'}
              className="px-2 py-1 text-[11px] font-semibold bg-white/5 text-text-secondary hover:bg-white/10 disabled:opacity-40 rounded transition-colors"
              title="Pause Timer"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleReset}
              className="px-2 py-1 text-[11px] font-semibold bg-white/5 text-text-secondary hover:bg-white/10 rounded transition-colors"
              title="Reset Timer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleEnd}
              className="px-2.5 py-1 text-[11px] font-semibold bg-accent-live/15 text-accent-live hover:bg-accent-live/25 rounded transition-colors flex items-center space-x-1"
              title="End Pitch"
            >
              <Square className="w-3.5 h-3.5" />
              <span>End Pitch</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
