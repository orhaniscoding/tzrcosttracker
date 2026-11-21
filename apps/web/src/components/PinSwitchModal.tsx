import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Lock, AlertTriangle, Delete } from 'lucide-react';
import { ApiClient } from '../api/client.js';
import { useLocale } from '../context/LocaleContext.js';

interface PinSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newUser: any) => Promise<void>;
  onPasswordLogin: () => void;
  currentUserId?: string;
}

export const PinSwitchModal: React.FC<PinSwitchModalProps> = ({ isOpen, onClose, onSuccess, onPasswordLogin, currentUserId }) => {
  const { t } = useLocale();
  const [profile, setProfile] = useState<any | null>(null);
  const [profileError, setProfileError] = useState<'' | 'session' | 'profile'>('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const genRef = useRef(0);
  const openRef = useRef(false);
  openRef.current = isOpen;
  const pinRef = useRef('');
  pinRef.current = pin;

  const resetTransient = useCallback(() => { setPin(''); setError(''); setProfile(null); setProfileError(''); setIsSubmitting(false); }, []);

  useEffect(() => {
    if (!isOpen) { genRef.current += 1; resetTransient(); return; }
    genRef.current += 1;
    const gen = genRef.current;
    const originToken = ApiClient.getToken();
    resetTransient();
    ApiClient.getMe().then((me) => {
      if (gen !== genRef.current || !openRef.current) return;
      if (ApiClient.getToken() !== originToken) return;
      if (currentUserId && me?.id && me.id !== currentUserId) { setProfileError('session'); return; }
      setProfile(me);
    }).catch(() => { if (gen === genRef.current && openRef.current) setProfileError('profile'); });
    return () => { genRef.current += 1; };
  }, [isOpen, currentUserId, resetTransient]);

  useEffect(() => { openRef.current = true; return () => { genRef.current += 1; openRef.current = false; }; }, []);
  const handleClose = useCallback(() => { genRef.current += 1; resetTransient(); onClose(); }, [onClose, resetTransient]);
  const handlePasswordLogin = useCallback(() => { genRef.current += 1; resetTransient(); onPasswordLogin(); }, [onPasswordLogin, resetTransient]);

  const executeVerify = useCallback(async (pinToVerify: string) => {
    const targetId = profile?.id || currentUserId;
    if (!targetId || isSubmitting) return;
    if (pinToVerify.length < 4 || pinToVerify.length > 6) { setError(t('PIN 4-6 haneli olmalıdır.', 'PIN must be 4–6 digits.')); return; }
    const gen = genRef.current;
    const originToken = ApiClient.getToken();
    if (!originToken) { setError(t('Oturum bulunamadı. Parola ile giriş yapın.', 'Session not found. Sign in with your password.')); return; }
    try {
      setIsSubmitting(true); setError('');
      const res = await ApiClient.switchUserPin({ userId: targetId, pin: pinToVerify });
      if (gen !== genRef.current || !openRef.current) return;
      if (ApiClient.getToken() !== originToken) return;
      if (res?.user?.id && res.user.id !== targetId) { setError(t('PIN yalnızca şu anki hesap için geçerlidir.', 'This PIN applies only to your current account.')); setPin(''); return; }
      if (res?.token) ApiClient.setToken(res.token);
      if (gen !== genRef.current || !openRef.current) return;
      await onSuccess(res.user);
      if (gen !== genRef.current) return;
      handleClose();
    } catch (err: any) {
      if (gen !== genRef.current || !openRef.current) return;
      setError(err.message || t('Hatalı PIN kodu. Lütfen tekrar deneyin.', 'Incorrect PIN. Please try again.')); setPin('');
    } finally { if (gen === genRef.current && openRef.current) setIsSubmitting(false); }
  }, [profile, currentUserId, isSubmitting, onSuccess, handleClose, t]);

  const verifyRef = useRef(executeVerify);
  verifyRef.current = executeVerify;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) { const n = pinRef.current.length < 6 ? pinRef.current + e.key : pinRef.current; pinRef.current = n; setPin(n); setError(''); }
      else if (e.key === 'Backspace') { pinRef.current = pinRef.current.slice(0, -1); setPin(pinRef.current); setError(''); }
      else if (e.key === 'Enter') { if (pinRef.current.length >= 4) void verifyRef.current(pinRef.current); }
      else if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  const handleKeypadPress = (val: string) => { if (!isSubmitting && pin.length < 6) { setPin(pin + val); setError(''); } };
  const handleBackspace = () => { setPin(pin.slice(0, -1)); setError(''); };

  if (!isOpen) return null;
  const hasPin = profile ? profile.hasPin !== false : false;
  const canVerify = !!profile && hasPin && pin.length >= 4 && pin.length <= 6 && !isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700"><Lock className="h-5 w-5" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">{t('PIN ile Hesabınızı Doğrulayın', 'Verify Your Account With a PIN')}</h3>
              <p className="text-[11px] text-slate-500">{t('Yalnızca şu anki hesabınız için PIN girin. Başka hesap için parola ile giriş yapın.', 'Enter the PIN for your current account. To switch accounts, sign in with a password.')}</p>
            </div>
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 space-y-4">
          {profile && (
            <div className="flex items-center gap-2.5 border-b border-slate-200 pb-3">
              <div className="h-9 w-9 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-xs">{(profile.fullName || profile.username || '?').slice(0, 2)}</div>
              <div><h4 className="text-xs font-bold text-slate-900">{profile.fullName}</h4><p className="text-[10px] text-slate-500">@{profile.username}</p></div>
            </div>
          )}
          {!profile && !profileError && <div className="text-center text-xs text-slate-500">{t('Hesap bilgisi yükleniyor...', 'Loading account information...')}</div>}
          {profileError && (<div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{profileError === 'session'
              ? t('Oturum bilgisi doğrulanamadı. Parola ile giriş yapın.', 'Could not verify your session. Sign in with your password.')
              : t('Hesap bilgisi alınamadı. PIN doğrulanamıyor; parola ile giriş yapabilirsiniz.', 'Could not load your account or verify the PIN. You can sign in with your password.')}</span></div>)}
          {profile && !hasPin && (<div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg">{t('Bu hesapta PIN tanımlı değil. Parola ile giriş yapabilirsiniz.', 'This account does not have a PIN. You can sign in with your password.')}</div>)}
          {error && (<div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{error}</span></div>)}
          <div className="text-center py-2">
            <label className="block text-xs font-semibold text-slate-600 mb-3">{t('4-6 Haneli PIN Kodunuzu Giriniz', 'Enter Your 4–6 Digit PIN')}</label>
            <div className="flex items-center justify-center gap-3">{[0,1,2,3,4,5].map((idx) => (<div key={idx} className={pin.length > idx ? 'h-4 w-4 rounded-full transition-all bg-blue-600 scale-110 shadow-sm' : 'h-4 w-4 rounded-full transition-all bg-slate-200 border border-slate-300'} />))}</div>
            <p className="text-[11px] text-slate-400 mt-2">{pin.length}{t('/6 hane', '/6 digits')}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 max-w-[260px] mx-auto pt-2">
            {[1,2,3,4,5,6,7,8,9].map((num) => (<button key={num} type="button" onClick={() => handleKeypadPress(String(num))} disabled={isSubmitting || !hasPin} className="h-12 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-lg flex items-center justify-center transition active:scale-95 disabled:opacity-50">{num}</button>))}
            <button type="button" onClick={() => setPin('')} disabled={isSubmitting} className="h-12 rounded-xl bg-slate-50 text-slate-500 font-semibold text-xs flex items-center justify-center hover:bg-slate-100 transition">{t('Temizle', 'Clear')}</button>
            <button type="button" onClick={() => handleKeypadPress('0')} disabled={isSubmitting || !hasPin} className="h-12 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-lg flex items-center justify-center transition active:scale-95 disabled:opacity-50">0</button>
            <button type="button" onClick={handleBackspace} disabled={isSubmitting} className="h-12 rounded-xl bg-slate-50 hover:bg-slate-200 text-slate-700 flex items-center justify-center transition" title={t('Geri Sil', 'Backspace')}><Delete className="h-5 w-5" /></button>
          </div>
          <button type="button" onClick={() => void executeVerify(pin)} disabled={!canVerify} className="w-full h-11 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed">{isSubmitting ? t('PIN doğrulanıyor...', 'Verifying PIN...') : t('PIN ile Doğrula', 'Verify With PIN')}</button>
          <div className="pt-3 border-t border-slate-200">
            <button type="button" onClick={handlePasswordLogin} className="w-full h-11 rounded-xl bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 font-bold text-sm">{t('Farklı hesapla giriş yap', 'Sign in with another account')}</button>
            <p className="text-[11px] text-slate-500 text-center mt-2">{t('Farklı bir hesap için mevcut oturum kapatılır ve normal parola (varsa 2FA) ile giriş ekranı açılır.', 'Switching accounts signs you out and opens the password sign-in screen. If 2FA is enabled, you’ll also enter a verification code.')}</p>
          </div>
        </div>
      </div>
    </div>
  );
};
