'use client';

import { useState } from 'react';
import { X, ShieldAlert } from 'lucide-react';
import { PitchLeaderboardEntry } from '@/src/lib/types';
import { manualOverrideScoreAction, unlockPitchScoreAction } from '@/src/app/actions/organiserActions';
import Toast, { ToastMessage } from '@/src/components/Toast';

interface ManualOverrideModalProps {
  entry: PitchLeaderboardEntry;
  onClose: () => void;
}

export default function ManualOverrideModal({ entry, onClose }: ManualOverrideModalProps) {
  const [activeTab, setActiveTab] = useState<'override' | 'unlock'>('override');
  const [tableChanged, setTableChanged] = useState<'pitch_scores' | 'audience_scores' | 'questions'>('pitch_scores');
  const [category, setCategory] = useState<'problem_market_raw' | 'solution_innovation_raw' | 'feasibility_raw' | 'pitch_storytelling_raw'>('problem_market_raw');
  const [rowId, setRowId] = useState('');
  const [newValue, setNewValue] = useState('');
  const [pointsPitching, setPointsPitching] = useState('0');
  const [pointsAsking, setPointsAsking] = useState('0');
  const [note, setNote] = useState('');
  const [unlockScoreId, setUnlockScoreId] = useState('');
  const [unlockNote, setUnlockNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<ToastMessage | null>(null);

  const handleOverrideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const newValuePayload =
      tableChanged === 'pitch_scores'
        ? { category, score: Number(newValue) }
        : tableChanged === 'questions'
          ? { points_pitching: Number(pointsPitching), points_asking: Number(pointsAsking) }
          : { score: Number(newValue) };

    const res = await manualOverrideScoreAction({
      tableChanged,
      rowId,
      oldValue: null,
      newValue: newValuePayload,
      note,
    });

    setLoading(false);
    if (res.error) {
      setMessage({ type: 'error', text: res.error });
    } else {
      setMessage({ type: 'success', text: 'Score overridden successfully & logged to audit table!' });
      setTimeout(() => onClose(), 1500);
    }
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const res = await unlockPitchScoreAction(unlockScoreId, unlockNote);

    setLoading(false);
    if (res.error) {
      setMessage({ type: 'error', text: res.error });
    } else {
      setMessage({ type: 'success', text: 'Pitch score unlocked successfully!' });
      setTimeout(() => onClose(), 1500);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="panel rounded-2xl w-full max-w-lg p-6 border border-brand-500/40 shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-text-secondary hover:text-text-primary transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-brand-500/15 text-brand-500 flex items-center justify-center border border-brand-500/40">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-primary">Manual Override Control</h3>
            <p className="text-xs text-text-secondary">Team: <span className="text-brand-500 font-bold">{entry.team_name}</span> (Pool {entry.pool})</p>
          </div>
        </div>

        {/* Tab Toggle */}
        <div className="flex border-b border-panel-border mb-5">
          <button
            onClick={() => setActiveTab('override')}
            className={`flex-1 py-2 text-xs font-bold text-center border-b-2 transition-colors ${
              activeTab === 'override'
                ? 'border-brand-500 text-brand-500'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            Direct Score Override
          </button>
          <button
            onClick={() => setActiveTab('unlock')}
            className={`flex-1 py-2 text-xs font-bold text-center border-b-2 transition-colors ${
              activeTab === 'unlock'
                ? 'border-brand-500 text-brand-500'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            Unlock Pitch Score
          </button>
        </div>

        <div className="mb-4">
          <Toast message={message} />
        </div>

        {activeTab === 'override' ? (
          <form onSubmit={handleOverrideSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Target Table</label>
              <select
                value={tableChanged}
                onChange={(e: any) => setTableChanged(e.target.value)}
                className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
              >
                <option value="pitch_scores">pitch_scores</option>
                <option value="audience_scores">audience_scores</option>
                <option value="questions">questions</option>
              </select>
            </div>

            {tableChanged === 'pitch_scores' && (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">Category</label>
                <select
                  value={category}
                  onChange={(e: any) => setCategory(e.target.value)}
                  className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
                >
                  <option value="problem_market_raw">Problem & Market (raw /10, weighted x2)</option>
                  <option value="solution_innovation_raw">Solution & Innovation (raw /10, weighted x2)</option>
                  <option value="feasibility_raw">Feasibility & Business (raw /10, weighted x1.5)</option>
                  <option value="pitch_storytelling_raw">Pitch & Storytelling (raw /10, weighted x1.5)</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Target Row UUID</label>
              <input
                type="text"
                required
                placeholder="Enter score UUID"
                value={rowId}
                onChange={(e) => setRowId(e.target.value)}
                className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
              />
            </div>

            {tableChanged === 'questions' ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Points to Pitching Team</label>
                  <input
                    type="number"
                    required
                    value={pointsPitching}
                    onChange={(e) => setPointsPitching(e.target.value)}
                    className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1">Points to Asking Team</label>
                  <input
                    type="number"
                    required
                    value={pointsAsking}
                    onChange={(e) => setPointsAsking(e.target.value)}
                    className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">New Value</label>
                <input
                  type="number"
                  required
                  placeholder={tableChanged === 'pitch_scores' ? 'New raw score (0-10)' : 'New Score'}
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Mandatory Audit Note</label>
              <textarea
                required
                rows={2}
                placeholder="State reason for manual override..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-500/90 text-white font-bold text-xs transition-colors shadow-brand-glow"
            >
              {loading ? 'Executing Override...' : 'Confirm Manual Override'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleUnlockSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Pitch Score ID to Unlock</label>
              <input
                type="text"
                required
                placeholder="Enter pitch_scores row UUID"
                value={unlockScoreId}
                onChange={(e) => setUnlockScoreId(e.target.value)}
                className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">Audit Note for Unlock</label>
              <textarea
                required
                rows={2}
                placeholder="Explain why this pitch score is being unlocked..."
                value={unlockNote}
                onChange={(e) => setUnlockNote(e.target.value)}
                className="w-full bg-white/5 border border-panel-border rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-brand-500"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-brand-500 hover:bg-brand-500/90 text-white font-bold text-xs transition-colors shadow-brand-glow"
            >
              {loading ? 'Unlocking...' : 'Unlock Pitch Score'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
