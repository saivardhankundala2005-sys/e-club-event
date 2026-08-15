'use client';

import { memo, useEffect, useRef } from 'react';
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
function AnimatedNumber({ value, decimals = 0, className = '', suffix = '' }: AnimatedNumberProps) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const spring = useSpring(reduced ? value : 0, { stiffness: 120, damping: 20 });
  const display = useTransform(spring, (v) => `${v.toFixed(decimals)}${suffix}`);

  useEffect(() => {
    if (reduced || inView) spring.set(value);
  }, [value, inView, reduced, spring]);

  return (
    <motion.span ref={ref} className={`tabular-nums ${className}`}>
      {display}
    </motion.span>
  );
}

export default memo(AnimatedNumber);
