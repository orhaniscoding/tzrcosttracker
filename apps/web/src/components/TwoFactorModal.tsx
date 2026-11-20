import React, { useState } from 'react';
import { X, ShieldCheck, Key, Copy, Check } from 'lucide-react';
import { ApiClient } from '../api/client.js';

interface TwoFactorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const TwoFactorModal: React.FC<TwoFactorModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [step, setStep] = useState<'init' | 'setup' | 'done'>('init');
  const [setupData, setSetupData] = useState<{ secret: string; qrCodeUri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleStartSetup = async () => {
    try {
      setIsLoading(true);
      setError('');
      const data = await ApiClient.setup2FA();
      setSetupData(data);
      setStep('setup');
    } catch (err: any) {
      setError(err.message || '2FA kurulumu başlatılamadı.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupData || !code) return;

    try {
      setIsLoading(true);
      setError('');
      await ApiClient.enable2FA({
        secret: setupData.secret,
        code,
        backupCodes: setupData.backupCodes,
      });
      setStep('done');
      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Doğrulama kodu hatalı.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopySecret = () => {
    if (setupData?.secret) {
      navigator.clipboard.writeText(setupData.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-400" />
            İki Aşamalı Doğrulama (2FA) Kurulumu
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 text-xs text-slate-300">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-rose-950/80 border border-rose-800 text-rose-300">
              {error}
            </div>
          )}

          {step === 'init' && (
            <div className="text-center py-4 space-y-4">
              <div className="h-16 w-16 mx-auto rounded-full bg-blue-950/60 border border-blue-800 flex items-center justify-center text-blue-400">
                <Key className="h-8 w-8" />
              </div>
              <p className="text-slate-300">
                Hesabınızı Google Authenticator, Microsoft Authenticator veya 1Password ile güvenceye alın. Giriş yaparken ve kritik maliyet onaylarında tek kullanımlık 6 haneli kod sorulur.
              </p>
              <button
                onClick={handleStartSetup}
                disabled={isLoading}
                className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 font-medium text-white transition disabled:opacity-50"
              >
                {isLoading ? 'Hazırlanıyor...' : '2FA Kurulumunu Başlat'}
              </button>
            </div>
          )}

          {step === 'setup' && setupData && (
            <form onSubmit={handleVerify} className="space-y-4">
              <p className="text-slate-300">
                1. Authenticator uygulamanızda "Hesap Ekle" diyerek aşağıdaki anahtarı girin:
              </p>

              <div className="bg-slate-950 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between font-mono text-sm text-blue-400">
                <span>{setupData.secret}</span>
                <button
                  type="button"
                  onClick={handleCopySecret}
                  className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  title="Kopyala"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">
                  2. Uygulamanızın ürettiği 6 Haneli Kodu Girin *
                </label>
                <input
                  type="text"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-center text-lg font-mono text-white tracking-widest focus:border-blue-500 focus:outline-none"
                  required
                />
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg">
                <p className="font-semibold text-slate-200 mb-1">Acil Durum Kurtarma Kodlarınız:</p>
                <div className="grid grid-cols-2 gap-1 font-mono text-[11px] text-slate-400">
                  {setupData.backupCodes.map((c, i) => (
                    <div key={i}>{c}</div>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading || code.length !== 6}
                className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium text-white transition disabled:opacity-50"
              >
                {isLoading ? 'Doğrulanıyor...' : 'Doğrula ve Aktifleştir'}
              </button>
            </form>
          )}

          {step === 'done' && (
            <div className="text-center py-6 space-y-4">
              <div className="h-16 w-16 mx-auto rounded-full bg-emerald-950/60 border border-emerald-800 flex items-center justify-center text-emerald-400">
                <ShieldCheck className="h-8 w-8" />
              </div>
              <h4 className="text-sm font-bold text-white">İki Aşamalı Doğrulama Aktif!</h4>
              <p className="text-slate-400">
                Hesabınız en yüksek güvenlik standardına ulaştı.
              </p>
              <button
                onClick={onClose}
                className="px-6 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-medium transition"
              >
                Kapat
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
