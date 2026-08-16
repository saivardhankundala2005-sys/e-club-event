'use client';

import { useEffect, useRef } from 'react';
import { motion, useSpring, useTransform, useInView } from 'framer-motion';
import { usePrefersReducedMotion } from '@/src/lib/useReducedMotion';

interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  className?: string;
  suffix?: string;
}

/**
 * Counts up/down to `value` instead of snapping, for live-updating scores
 * and vote counts. Renders tabular-nums so digit width never jitters.
 */
export default function AnimatedNumber({ value, decimals = 0, className = '', suffix = '' }: AnimatedNumberProps) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  // Counts up only once the element has actually been visible on screen —
  // but a row that's never scrolled into view (long leaderboard, small
  // viewport) must still show its real value eventually, not stay frozen
  // at the initial 0. Fall back to setting the value directly after a
  // short grace period if it still hasn't come into view.
  const inView = useInView(ref, { once: true });
  const spring = useSpring(reduced ? value : 0, { stiffness: 120, damping: 20 });
  const display = useTransform(spring, (v) => `${v.toFixed(decimals)}${suffix}`);

  useEffect(() => {
    if (reduced || inView) {
      spring.set(value);
      return;
    }
    const t = setTimeout(() => spring.set(value), 400);
    return () => clearTimeout(t);
  }, [value, inView, reduced, spring]);

  return (
    <motion.span ref={ref} className={`tabular-nums ${className}`}>
      {display}
    </motion.span>
  );
}
