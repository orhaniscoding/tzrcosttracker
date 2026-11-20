import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Lock, Shield, KeyRound, AlertTriangle, Delete, LogOut } from 'lucide-react';
import { ApiClient } from '../api/client.js';

interface ScreenLockModalProps {
  isOpen: boolean;
  user: any;
  onUnlocked: () => void;
  onSwitchUser: () => void;
  onPasswordLogin?: () => void;
  onLogout: () => void;
}

export const ScreenLockModal: React.FC<ScreenLockModalProps> = ({
  isOpen,
  user,
  onUnlocked,
  onSwitchUser,
  onPasswordLogin,
  onLogout,
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutTimer, setLockoutTimer] = useState<number>(0);
  const [isVerifying, setIsVerifying] = useState(false);
  const genRef = useRef(0);
  const mountedRef = useRef(true);

  // Brute-force kilit geri sayımı
  useEffect(() => {
    if (lockoutTimer > 0) {
      const interval = setInterval(() => {
        setLockoutTimer((t) => t - 1);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [lockoutTimer]);

  // Fiziksel klavye desteği
  useEffect(() => {
    if (!isOpen || lockoutTimer > 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        handleBackspace();
      } else if (e.key === 'Escape') {
        setPin('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, pin, lockoutTimer]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; genRef.current += 1; }; }, []);
  useEffect(() => { if (!isOpen) { genRef.current += 1; } }, [isOpen]);
  const handleSwitchUser = useCallback(() => { genRef.current += 1; onSwitchUser(); }, [onSwitchUser]);
  const handlePasswordLogin = useCallback(() => { genRef.current += 1; if (onPasswordLogin) onPasswordLogin(); }, [onPasswordLogin]);
  const handleLogout = useCallback(() => { genRef.current += 1; onLogout(); }, [onLogout]);
  if (!isOpen) return null;

  const handleDigit = (digit: string) => {
    if (lockoutTimer > 0 || isVerifying) return;
    if (pin.length < 4) {
      const nextPin = pin + digit;
      setPin(nextPin);
      setError('');
      if (nextPin.length === 4) {
        verifyPin(nextPin);
      }
    }
  };

  const handleBackspace = () => {
    if (lockoutTimer > 0) return;
    setPin((p) => p.slice(0, -1));
    setError('');
  };

  const verifyPin = async (pinToTest: string) => {
    genRef.current += 1;
    const gen = genRef.current;
    const originToken = ApiClient.getToken();
    const isStale = () => !mountedRef.current || gen !== genRef.current || ApiClient.getToken() !== originToken;
    try {
      setIsVerifying(true);
      setError('');

      // switch-pin endpoint'i ile PIN doğrulaması yap
      const res = await ApiClient.switchUserPin({
        userId: user?.id || undefined,
        pin: pinToTest,
      });

      if (isStale()) return;
      if (res?.user?.id && user?.id && res.user.id !== user.id) { setError('PIN yalnızca şu anki hesap için geçerlidir.'); setPin(''); return; }
      if (res?.token) {
        ApiClient.setToken(res.token);
      }
      if (!mountedRef.current || gen !== genRef.current) return;

      // Doğrulama başarılı
      setFailedAttempts(0);
      setPin('');
      onUnlocked();
    } catch (err: any) {
      if (isStale()) return;
      const nextFailed = failedAttempts + 1;
      setFailedAttempts(nextFailed);
      setPin('');

      if (nextFailed >= 5) {
        setLockoutTimer(300); // 5 dakika kilit
        setError('Çok fazla hatalı PIN denemesi! Güvenlik nedeniyle 5 dakika kilitlendi.');
      } else {
        setError(`Hatalı PIN kodu! (Kalan hak: ${5 - nextFailed})`);
      }
    } finally {
      if (!isStale()) setIsVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-xl p-4 select-none">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-sm p-6 shadow-2xl text-center space-y-4">
        {/* Kullanıcı Profili */}
        <div className="space-y-2">
          <div className="relative mx-auto w-16 h-16 rounded-full bg-blue-600 text-white font-black text-xl flex items-center justify-center shadow-lg">
            {user?.fullName ? user.fullName.slice(0, 2).toUpperCase() : 'TZ'}
            <div className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-slate-900 border-2 border-white flex items-center justify-center text-amber-400">
              <Lock className="h-3 w-3" />
            </div>
          </div>

          <div>
            <h3 className="text-base font-bold text-slate-900">{user?.fullName || 'Kullanıcı'}</h3>
            <p className="text-xs text-slate-500 font-medium">@{user?.username || 'admin'}</p>
          </div>

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200">
            <Shield className="h-3.5 w-3.5 text-blue-600" />
            <span>Ekran Güvenliği Aktif (Varsayılan PIN: 1234)</span>
          </div>
        </div>

        {/* Hata veya Kilit Bildirimi */}
        {error && (
          <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl font-medium flex items-center justify-center gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
            <span>{error}</span>
          </div>
        )}

        {lockoutTimer > 0 && (
          <div className="p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs font-bold text-amber-900">
            Kilit Açılma Süresi: {Math.floor(lockoutTimer / 60)}:{(lockoutTimer % 60).toString().padStart(2, '0')}
          </div>
        )}

        {/* PIN Daireleri */}
        <div className="py-2">
          <p className="text-xs text-slate-500 font-medium mb-3">4 Haneli Hızlı PIN Kodunuzu Giriniz</p>
          <div className="flex items-center justify-center gap-3">
            {[0, 1, 2, 3].map((idx) => (
              <div
                key={idx}
                className={`h-4 w-4 rounded-full transition-all ${
                  pin.length > idx
                    ? 'bg-blue-600 scale-110 shadow-sm'
                    : 'bg-slate-200 border border-slate-300'
                }`}
              />
            ))}
          </div>
        </div>

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-2 max-w-[240px] mx-auto pt-1">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
            <button
              key={num}
              type="button"
              disabled={lockoutTimer > 0 || isVerifying}
              onClick={() => handleDigit(String(num))}
              className="h-12 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-lg flex items-center justify-center transition active:scale-95 disabled:opacity-40"
            >
              {num}
            </button>
          ))}
          <button
            type="button"
            disabled={lockoutTimer > 0 || isVerifying}
            onClick={() => setPin('')}
            className="h-12 rounded-2xl bg-slate-50 text-slate-500 font-semibold text-xs flex items-center justify-center hover:bg-slate-100 transition"
          >
            Temizle
          </button>
          <button
            type="button"
            disabled={lockoutTimer > 0 || isVerifying}
            onClick={() => handleDigit('0')}
            className="h-12 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-lg flex items-center justify-center transition active:scale-95 disabled:opacity-40"
          >
            0
          </button>
          <button
            type="button"
            disabled={lockoutTimer > 0 || isVerifying}
            onClick={handleBackspace}
            className="h-12 rounded-2xl bg-slate-50 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition"
            title="Geri Sil"
          >
            <Delete className="h-5 w-5" />
          </button>
        </div>

        {/* Alt Aksiyonlar */}
        <div className="pt-3 border-t border-slate-200 flex items-center justify-between text-xs font-semibold">
          <button
            onClick={handleSwitchUser}
            className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            <span>Kullanıcı Değiştir</span>
          </button>

          {onPasswordLogin && (
            <button
              onClick={handlePasswordLogin}
              className="text-slate-600 hover:text-slate-900"
            >
              <span>Parola ile Giriş</span>
            </button>
          )}

          <button
            onClick={handleLogout}
            className="text-rose-500 hover:text-rose-700 flex items-center gap-1"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Çıkış</span>
          </button>
        </div>
      </div>
    </div>
  );
};
