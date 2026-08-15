'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trophy, Crown } from 'lucide-react';
import { PitchLeaderboardEntry } from '@/src/lib/types';
import PoolBadge from '@/src/components/PoolBadge';
import AnimatedNumber from '@/src/components/AnimatedNumber';
import { triggerConfetti, triggerGoldConfetti } from '@/src/components/ConfettiEffect';
import { usePrefersReducedMotion } from '@/src/lib/useReducedMotion';

interface PodiumRevealProps {
  leaderboard: PitchLeaderboardEntry[];
  /** Full-scale podium (for /display) vs. a compact card list (portals). */
  variant?: 'full' | 'compact';
}

/**
 * Top-3 reveal ceremony: a brief suspense beat, then the leaderboard
 * populates bottom-up with a staggered reveal, and the top 3 get a
 * podium layout (#1 center/tallest, #2 left, #3 right) with gold/silver/
 * bronze accents layered on the existing Arena Glass tokens. Confetti is
 * concentrated on the #1 reveal as the peak beat.
 */
export default function PodiumReveal({ leaderboard, variant = 'full' }: PodiumRevealProps) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<'suspense' | 'reveal'>('suspense');
  const hasFiredGold = useRef(false);
  const hasFiredGeneral = useRef(false);

  const ranked = leaderboard
    .filter((e) => e.total_weighted_score !== null)
    .slice()
    .sort((a, b) => (b.total_weighted_score ?? 0) - (a.total_weighted_score ?? 0));

  const top3 = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  const [first, second, third] = top3;

  useEffect(() => {
    // A few seconds of anticipation, not longer — 150 people shouldn't
    // wait through a slow build-up.
    const t = setTimeout(() => setPhase('reveal'), reduced ? 300 : 2200);
    return () => clearTimeout(t);
  }, [reduced]);

  useEffect(() => {
    if (phase !== 'reveal' || variant !== 'full') return;
    if (!hasFiredGeneral.current) {
      hasFiredGeneral.current = true;
      if (!reduced) triggerConfetti();
    }
    // Gold burst timed to land after the bottom-up stagger reaches #1.
    const goldDelay = reduced ? 400 : 1900;
    const t = setTimeout(() => {
      if (!hasFiredGold.current) {
        hasFiredGold.current = true;
        if (!reduced) triggerGoldConfetti();
      }
    }, goldDelay);
    return () => clearTimeout(t);
  }, [phase, variant, reduced]);

  if (ranked.length === 0) {
    return (
      <div className="text-center py-10 space-y-2">
        <Trophy className="w-10 h-10 text-text-secondary/50 mx-auto" />
        <p className="text-sm text-text-secondary">No scored pitches to reveal yet.</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-8">
      <AnimatePresence mode="wait">
        {phase === 'suspense' ? (
          <motion.div
            key="suspense"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-center py-16 space-y-4"
          >
            <motion.div
              animate={reduced ? undefined : { rotate: [0, -8, 8, -8, 0], scale: [1, 1.08, 1] }}
              transition={{ duration: 1.1, repeat: Infinity }}
              className="w-16 h-16 mx-auto rounded-2xl bg-accent-warm/15 text-accent-warm flex items-center justify-center border border-accent-warm/40"
            >
              <Trophy className="w-8 h-8" />
            </motion.div>
            <h2 className={`font-display font-bold text-text-primary ${variant === 'full' ? 'text-4xl sm:text-6xl' : 'text-xl'}`}>
              And the winners are&hellip;
            </h2>
          </motion.div>
        ) : (
          <motion.div key="reveal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-10">
            {/* PODIUM: #1 center/tallest, #2 left, #3 right — revealed bottom-up */}
            <div className={`grid grid-cols-3 gap-4 items-end ${variant === 'full' ? 'max-w-4xl mx-auto' : 'max-w-xl mx-auto'}`}>
              {[
                { entry: second, rank: 2, order: 'order-1', height: variant === 'full' ? 'h-40 sm:h-52' : 'h-24', delay: reduced ? 0 : 0.1, accent: 'from-slate-300 to-slate-400', text: 'text-slate-200', ring: 'border-slate-300/50' },
                { entry: first, rank: 1, order: 'order-2', height: variant === 'full' ? 'h-56 sm:h-72' : 'h-32', delay: reduced ? 0 : 1.6, accent: 'from-accent-warm via-yellow-400 to-amber-500', text: 'text-bg-base', ring: 'border-accent-warm/60' },
                { entry: third, rank: 3, order: 'order-3', height: variant === 'full' ? 'h-32 sm:h-40' : 'h-20', delay: reduced ? 0 : 0.85, accent: 'from-amber-700 to-amber-800', text: 'text-amber-100', ring: 'border-amber-600/50' },
              ].map(({ entry, rank, order, height, delay, accent, text, ring }) => (
                <motion.div
                  key={rank}
                  initial={reduced ? undefined : { opacity: 0, y: 60 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay, duration: 0.6, type: 'spring', stiffness: 220, damping: 22 }}
                  className={`${order} flex flex-col items-center gap-3`}
                >
                  {entry ? (
                    <>
                      <div className="text-center space-y-1 px-1">
                        {rank === 1 && <Crown className="w-6 h-6 text-accent-warm mx-auto mb-1" />}
                        <p className={`font-display font-bold text-text-primary truncate max-w-[9rem] sm:max-w-[14rem] ${rank === 1 ? 'text-lg sm:text-2xl' : 'text-sm sm:text-lg'}`}>
                          {entry.team_name}
                        </p>
                        <div className="flex items-center justify-center gap-2">
                          <PoolBadge pool={entry.pool} className="text-[10px]" />
                        </div>
                        <div className="tabular-nums font-bold text-brand-500 text-sm sm:text-base">
                          <AnimatedNumber value={entry.total_weighted_score ?? 0} decimals={1} /> pts
                        </div>
                      </div>
                      <div className={`w-full ${height} rounded-t-2xl bg-gradient-to-b ${accent} border-2 ${ring} shadow-2xl flex items-start justify-center pt-3`}>
                        <span className={`font-display font-black text-3xl sm:text-5xl ${text}`}>#{rank}</span>
                      </div>
                    </>
                  ) : (
                    <div className={`w-full ${height} rounded-t-2xl bg-white/5 border border-panel-border`} />
                  )}
                </motion.div>
              ))}
            </div>

            {/* Remainder of the leaderboard, staggered bottom-up beneath the podium */}
            {rest.length > 0 && (
              <div className="max-w-2xl mx-auto space-y-2">
                {rest.map((entry, i) => (
                  <motion.div
                    key={entry.team_id}
                    initial={reduced ? undefined : { opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: reduced ? 0 : 2.2 + (rest.length - i) * 0.05, duration: 0.3 }}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-white/[0.02] border border-panel-border"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs font-mono text-text-secondary w-6 shrink-0">#{i + 4}</span>
                      <span className="text-sm font-semibold text-text-primary truncate">{entry.team_name}</span>
                      <PoolBadge pool={entry.pool} className="text-[10px] shrink-0" />
                    </div>
                    <span className="tabular-nums text-sm font-bold text-text-secondary shrink-0">
                      {(entry.total_weighted_score ?? 0).toFixed(1)} pts
                    </span>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
