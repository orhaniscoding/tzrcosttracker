import React, { useState, useEffect } from 'react';
import {
  Building2,
  Check,
  ChevronRight,
  Shield,
  KeyRound,
  Layers,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  Lock,
  User,
  DollarSign,
} from 'lucide-react';
import { ApiClient } from '../api/client.js';

interface OnboardingWizardProps {
  onCompleted: (user: any, token: string) => Promise<void>;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onCompleted }) => {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Form State
  const [companyName, setCompanyName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('TRY');
  const [projectName, setProjectName] = useState('');

  // Admin Account
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('admin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [setupToken, setSetupToken] = useState('');

  // Industry Template
  const [selectedTemplate, setSelectedTemplate] = useState('construction');
  const [templates, setTemplates] = useState<any[]>([]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ApiClient.getIndustryTemplates()
      .then((t) => setTemplates(t))
      .catch(() => {});
  }, []);

  const handleFinishSetup = async () => {
    if (!companyName || !fullName || !username || !email || !password || !pin || !setupToken) {
      setError('Lütfen tüm zorunlu alanları doldurunuz.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError('');

      const res = await ApiClient.setupSystem({
        companyName,
        baseCurrency,
        projectName: projectName || undefined,
        admin: {
          username,
          fullName,
          email,
          password,
          pin,
        },
        industryTemplate: selectedTemplate,
      }, setupToken);

      setSetupToken('');
      ApiClient.setToken(res.token);
      await onCompleted(res.user, res.token);
    } catch (err: any) {
      setError(err.message || 'Kurulum sırasında bir hata oluştu.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950 p-4 font-sans select-none overflow-y-auto">
      <div className="w-full max-w-2xl bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden my-auto">
        {/* Üst Logo ve İlerleme Çubuğu */}
        <div className="bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 p-6 text-white text-center relative">
          <div className="h-12 w-12 mx-auto rounded-2xl bg-blue-600 flex items-center justify-center font-black text-xl shadow-lg mb-2">
            TZR
          </div>
          <h1 className="text-xl font-black tracking-tight">TZRCoster İlk Kurulum Sihirbazı</h1>
          <p className="text-xs text-slate-300 mt-0.5">
            Sektörden bağımsız, hassas mali alanları şifrelenen maliyet ve bütçe yönetim platformu
          </p>

          {/* Stepper Göstergesi */}
          <div className="flex items-center justify-center gap-2 mt-4">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`h-2 rounded-full transition-all ${
                  step === s ? 'w-8 bg-blue-500' : step > s ? 'w-4 bg-emerald-500' : 'w-4 bg-slate-700'
                }`}
              />
            ))}
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold rounded-xl">
            {error}
          </div>
        )}

        <div className="p-6">
          {/* ADIM 1: ŞİRKET BİLGİLERİ & PARA BİRİMİ */}
          {step === 1 && (
            <div className="space-y-4 text-xs">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-blue-600" />
                  <span>Adım 1: Şirket Bilgileri & Ana Para Birimi</span>
                </h2>
                <p className="text-slate-500 mt-0.5">Platformunuzun firma kimliğini ve temel para birimini belirleyin.</p>
              </div>

              <div>
                <label className="block text-slate-700 font-semibold mb-1">Şirket / Kuruluş Adı *</label>
                <input
                  type="text"
                  placeholder="Örn: Özdemir İnşaat & Mimarlık Ltd. Şti."
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 font-semibold text-sm focus:outline-none focus:border-blue-600"
                  autoFocus
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Ana Para Birimi *</label>
                  <select
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-slate-900 font-bold focus:outline-none focus:border-blue-600"
                  >
                    <option value="TRY">Türk Lirası (₺ - TRY)</option>
                    <option value="USD">Amerikan Doları ($ - USD)</option>
                    <option value="EUR">Euro (€ - EUR)</option>
                    <option value="GBP">İngiliz Sterlini (£ - GBP)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">İlk Proje / Şantiye Adı</label>
                  <input
                    type="text"
                    placeholder="Örn: Merkez Şantiye Bütçesi"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <div className="pt-4 flex justify-end">
                <button
                  type="button"
                  disabled={!companyName.trim()}
                  onClick={() => {
                    setError('');
                    setStep(2);
                  }}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
                >
                  <span>Devam Et</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* ADIM 2: YÖNETİCİ HESABI & HIZLI PIN */}
          {step === 2 && (
            <div className="space-y-4 text-xs">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-blue-600" />
                  <span>Adım 2: İlk Yönetici (Admin) Hesabı & 4 Haneli Hızlı PIN</span>
                </h2>
                <p className="text-slate-500 mt-0.5">
                  Sisteme tam yetkili ilk kullanıcıyı oluşturun. 4 haneli PIN şantiyede hızlı giriş için kullanılacaktır.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Ad Soyad *</label>
                  <input
                    type="text"
                    placeholder="Örn: Orhan Yılmaz"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                    autoFocus
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Kullanıcı Adı *</label>
                  <input
                    type="text"
                    placeholder="admin"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-semibold mb-1">E-posta Adresi *</label>
                  <input
                    type="email"
                    placeholder="admin@sirketiniz.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                    required
                  />
                </div>

                <div>
                  <label className="block text-slate-700 font-semibold mb-1">Yönetici Parolası (En az 8) *</label>
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                    required
                  />
                </div>
              </div>

              <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-2xl flex items-center justify-between">
                <div>
                  <label className="block text-blue-950 font-bold mb-0.5">4 Haneli Hızlı PIN Kodu *</label>
                  <p className="text-[11px] text-blue-700">Ekran kilitlendiğinde kendi hesabınızın kilidini açmak için girilecek PIN</p>
                </div>
                <input
                  type="password"
                  maxLength={4}
                  placeholder="1234"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className="w-24 bg-white border border-blue-300 rounded-xl px-3 py-2 text-center text-lg font-mono tracking-widest font-bold text-slate-900 focus:outline-none"
                  required
                />
              </div>

              <div>
                  <label className="block text-slate-700 font-semibold mb-1">Kurulum anahtarı *</label>
                  <input type="password" autoComplete="off" placeholder="Kurulum anahtarını girin" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600" required />
                  <p className="text-[11px] text-slate-500 mt-1">Kurulum anahtarını sunucu yöneticisi sağlar; yalnızca ilk kurulum için gereklidir.</p>
                </div>

              <div className="pt-4 flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Geri
                </button>
                <button
                  type="button"
                  disabled={!fullName || !username || !email || password.length < 8 || pin.length < 4 || !setupToken}
                  onClick={() => {
                    setError('');
                    setStep(3);
                  }}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
                >
                  <span>Devam Et</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* ADIM 3: SEKTÖR ŞABLONU SEÇİMİ */}
          {step === 3 && (
            <div className="space-y-4 text-xs">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Layers className="h-4 w-4 text-blue-600" />
                  <span>Adım 3: Sektör Şablonu & Başlangıç Kategorileri</span>
                </h2>
                <p className="text-slate-500 mt-0.5">
                  İşinize en uygun kategorileri tek tıkla yükleyin (Daha sonra dilediğiniz gibi düzenleyebilirsiniz).
                </p>
              </div>

              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {templates.map((tmpl) => (
                  <div
                    key={tmpl.id}
                    onClick={() => setSelectedTemplate(tmpl.id)}
                    className={`p-3.5 rounded-2xl border cursor-pointer transition ${
                      selectedTemplate === tmpl.id
                        ? 'bg-blue-50/80 border-blue-500 shadow-sm'
                        : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-bold text-slate-900 text-sm">{tmpl.title}</div>
                      <span className="text-[10px] bg-slate-200 px-2 py-0.5 rounded-full font-semibold text-slate-700">
                        {tmpl.categoryCount} Kalem
                      </span>
                    </div>
                    <p className="text-slate-500 text-[11px] mt-1">{tmpl.description}</p>
                  </div>
                ))}
              </div>

              <div className="pt-4 flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Geri
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setStep(4);
                  }}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm"
                >
                  <span>Özeti İncele</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* ADIM 4: ÖZET & TAMAMLAMA */}
          {step === 4 && (
            <div className="space-y-4 text-xs">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span>Adım 4: Kurulum Özeti & Onay</span>
                </h2>
                <p className="text-slate-500 mt-0.5">Bilgileri kontrol edip sistemi başlatın.</p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2.5">
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">Şirket / Kuruluş:</span>
                  <strong className="text-slate-900">{companyName}</strong>
                </div>
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">Ana Para Birimi:</span>
                  <strong className="text-slate-900">{baseCurrency}</strong>
                </div>
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">Yönetici Kullanıcı:</span>
                  <strong className="text-slate-900">{fullName} (@{username})</strong>
                </div>
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">4 Haneli PIN Kodu:</span>
                  <span className="font-mono font-bold text-blue-700">•••• (Kayıtlı)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Seçilen Sektör Şablonu:</span>
                  <strong className="text-slate-900 capitalize">{selectedTemplate}</strong>
                </div>
              </div>

              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900 flex items-center gap-2">
                <Shield className="h-5 w-5 text-emerald-600 shrink-0" />
                <span>
                  Verileriniz AES-256-GCM alan şifreleme ve SHA-256 denetim zinciri ile güvence altına alınacaktır.
                </span>
              </div>

              <div className="pt-4 flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Geri
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleFinishSetup}
                  className="flex items-center gap-2 px-8 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-sm transition shadow-lg disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4" />
                  <span>{isSubmitting ? 'Kurulum Yapılıyor...' : 'Kurulumu Tamamla ve Başlat'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
