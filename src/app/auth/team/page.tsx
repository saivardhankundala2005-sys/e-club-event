'use client';

import { useState } from 'react';
import Navbar from '@/src/components/Navbar';
import Toast, { ToastMessage } from '@/src/components/Toast';
import { Mail, KeyRound, ArrowRight } from 'lucide-react';
import { requestTeamOtpAction, verifyTeamOtpAction } from '@/src/app/actions/authActions';
import { isValidEmailFormat } from '@/src/lib/validation';
import { useRouter } from 'next/navigation';

export default function TeamAuthPage() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [email, setEmail] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<ToastMessage | null>(null);

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    // Client-side format check (any email domain allowed for teams)
    if (!isValidEmailFormat(email)) {
      setMessage({ type: 'error', text: 'Please enter a valid email address.' });
      return;
    }

    setLoading(true);
    const formData = new FormData();
    formData.append('email', email);

    const res = await requestTeamOtpAction(formData);
    setLoading(false);

    if (res.error) {
      setMessage({ type: 'error', text: res.error });
    } else {
      setMessage({ type: 'success', text: 'Code sent to your inbox! Enter it below to sign in or complete registration.' });
      setStep('verify');
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!otpToken || otpToken.trim().length < 6) {
      setMessage({ type: 'error', text: 'Please enter a valid 6-digit OTP code.' });
      return;
    }

    setLoading(true);
    const res = await verifyTeamOtpAction(email, otpToken.trim());
    setLoading(false);

    if (res.error) {
      setMessage({ type: 'error', text: res.error });
    } else if (res.isReturningTeam) {
      router.push('/portal/team');
    } else {
      router.push('/register-team');
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md panel rounded-3xl p-8 space-y-6 shadow-2xl relative">
          <div className="text-center space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mx-auto border border-brand-500/30 shadow-brand-glow">
              <Mail className="w-6 h-6" />
            </div>
            <h1 className="font-display text-2xl font-bold text-text-primary tracking-tight">Team Authentication</h1>
            <p className="text-xs text-text-secondary">
              We&apos;ll send a code to sign in or complete your registration.
            </p>
          </div>

          <Toast message={message} />

          {step === 'request' ? (
            <form onSubmit={handleRequestOtp} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1.5 uppercase tracking-wider">
                  Leader Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-text-secondary absolute left-3.5 top-3.5" />
                  <input
                    type="email"
                    required
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-white/5 border border-panel-border rounded-xl pl-10 pr-4 py-3 text-sm text-text-primary focus:outline-none focus:border-brand-500 transition-colors font-mono"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 rounded-xl font-bold text-sm bg-brand-500 hover:bg-brand-500/90 text-white transition-all shadow-brand-glow flex items-center justify-center space-x-2"
              >
                <span>{loading ? 'Sending OTP...' : 'Send Magic OTP Code'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1.5 uppercase tracking-wider">
                  Enter 6-Digit OTP Code
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-text-secondary absolute left-3.5 top-3.5" />
                  <input
                    type="text"
                    required
                    maxLength={6}
                    placeholder="123456"
                    value={otpToken}
                    onChange={(e) => setOtpToken(e.target.value)}
                    className="w-full bg-white/5 border border-panel-border rounded-xl pl-10 pr-4 py-3 text-center text-lg tracking-widest font-mono text-text-primary focus:outline-none focus:border-brand-500 transition-colors"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 rounded-xl font-bold text-sm bg-brand-500 hover:bg-brand-500/90 text-white transition-all shadow-brand-glow flex items-center justify-center space-x-2"
              >
                <span>{loading ? 'Verifying OTP...' : 'Verify OTP & Proceed'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => setStep('request')}
                className="w-full text-center text-xs text-text-secondary hover:text-text-primary underline pt-2"
              >
                Change Email
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
