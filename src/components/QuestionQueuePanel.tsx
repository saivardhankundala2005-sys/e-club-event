'use client';

import { CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { Question } from '@/src/lib/types';
import { reviewQuestionAction } from '@/src/app/actions/organiserActions';

interface QuestionQueuePanelProps {
  pendingQuestions: Question[];
  onDataChange: () => void;
}

/**
 * Shared by Judge and Organiser portals so approve/reject + answer-quality
 * review can't drift out of sync between the two roles (same pattern as
 * PitchQueuePanel). Raw point rule (section 5):
 *   rejected:                    pitching +0, asking +0
 *   approved + answered well:    pitching +2, asking +2
 *   approved + answered poorly:  pitching +0, asking +1
 */
export default function QuestionQueuePanel({ pendingQuestions, onDataChange }: QuestionQueuePanelProps) {
  const handleQuestionReview = async (
    questionId: string,
    status: 'approved' | 'rejected',
    outcome?: 'team_answered_well' | 'team_answered_poorly' | null
  ) => {
    await reviewQuestionAction(questionId, status, outcome);
    onDataChange();
  };

  return (
    <div className="card rounded-2xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-text-primary flex items-center space-x-2">
            <HelpCircle className="w-5 h-5 text-accent-live" />
            <span>Incoming Question Queue</span>
          </h2>
          <p className="text-xs text-text-secondary">Review rival team questions and score their Q&amp;A performance.</p>
        </div>
        <span className="text-xs font-mono font-bold text-accent-live">{pendingQuestions.length} Pending</span>
      </div>

      {pendingQuestions.length === 0 ? (
        <div className="text-center py-10 space-y-2">
          <CheckCircle2 className="w-10 h-10 text-success-500 mx-auto" />
          <h4 className="font-bold text-text-primary">Question Queue Clear</h4>
          <p className="text-xs text-text-secondary">Incoming questions submitted by teams will appear here in real-time.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pendingQuestions.map((q) => (
            <div key={q.id} className="p-4 rounded-xl bg-white/[0.03] border border-panel-border space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-secondary">Asked by: <strong className="text-brand-500 font-bold">{q.asking_team?.team_name}</strong></span>
                <span className="text-text-secondary/70 font-mono">{new Date(q.created_at).toLocaleTimeString()}</span>
              </div>

              <p className="text-sm text-text-primary font-medium bg-black/20 p-3 rounded-lg border border-panel-border">
                &ldquo;{q.question_text}&rdquo;
              </p>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => handleQuestionReview(q.id, 'rejected')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 hover:bg-danger-500/15 text-text-secondary hover:text-danger-500 border border-panel-border transition-colors flex items-center space-x-1"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Reject</span>
                </button>

                <button
                  onClick={() => handleQuestionReview(q.id, 'approved', 'team_answered_well')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-success-500/15 hover:bg-success-500/25 text-success-500 border border-success-500/40 transition-colors flex items-center space-x-1"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Approve & Answered Well (+2 Pitching / +2 Asking)</span>
                </button>

                <button
                  onClick={() => handleQuestionReview(q.id, 'approved', 'team_answered_poorly')}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-accent-live/15 hover:bg-accent-live/25 text-accent-live border border-accent-live/40 transition-colors flex items-center space-x-1"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Approve & Answered Poorly (+0 Pitching / +1 Asking)</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
