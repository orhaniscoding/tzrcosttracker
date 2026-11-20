import { LanguageSelect, useLocale } from '../context/LocaleContext.js';
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

const englishTemplates: Record<string, { title: string; description: string }> = {
  construction: { title: '🏗️ Construction and contracting', description: 'Structures, finishes, mechanical and electrical work, subcontractors, and site overhead' },
  manufacturing: { title: '🏭 Manufacturing', description: 'Materials, equipment maintenance, logistics, packaging, labor, and energy' },
  software: { title: '💻 Software, technology, and SaaS', description: 'Cloud hosting, subscriptions, freelance development, and advertising' },
  general: { title: '🏢 General business and services', description: 'Rent, wages, accounting and legal services, utilities, and operating costs' },
  blank: { title: '⚪ Start from scratch', description: 'Create your own category tree' },
};

interface OnboardingWizardProps {
  onCompleted: (user: any, token: string) => Promise<void>;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ onCompleted }) => {
  const { t, language } = useLocale();
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
    const requiredFields = [companyName, fullName, username, email, password, pin, setupToken];
    if (!requiredFields.every(Boolean)) {
      setError(t("Lütfen tüm zorunlu alanları doldurunuz.", "Fill in all required fields."));
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
      setError(language === 'tr' && err.message ? err.message : t("Kurulum sırasında bir hata oluştu.", "Setup could not be completed. Check the form and setup token, then try again."));
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
          <h1 className="text-xl font-black tracking-tight">{t("TZRCoster İlk Kurulum Sihirbazı", "Set up TZR Cost Tracker")}</h1>
          <p className="text-xs text-slate-300 mt-0.5">
            {t("Sektörden bağımsız, hassas mali alanları şifrelenen maliyet ve bütçe yönetim platformu", "Set up your organization, administrator account, and starting categories.")}
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
          <div className="mb-4 flex justify-end"><LanguageSelect /></div>
          {/* ADIM 1: ŞİRKET BİLGİLERİ & PARA BİRİMİ */}
          {step === 1 && (
            <div className="space-y-4 text-xs">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-blue-600" />
                  <span>{t("Adım 1: Şirket Bilgileri & Ana Para Birimi", "Step 1: Organization and base currency")}</span>
                </h2>
                <p className="text-slate-500 mt-0.5">{t("Platformunuzun firma kimliğini ve temel para birimini belirleyin.", "Set your organization name and base currency.")}</p>
              </div>

              <div>
                <label htmlFor="setup-organization" className="block text-slate-700 font-semibold mb-1">{t("Şirket / Kuruluş Adı *", "Organization name *")}</label>
                <input id="setup-organization"
                  type="text"
                  placeholder={t("Örn: Özdemir İnşaat & Mimarlık Ltd. Şti.", "Example: Ridge Construction")}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 font-semibold text-sm focus:outline-none focus:border-blue-600"
                  autoFocus
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="setup-currency" className="block text-slate-700 font-semibold mb-1">{t("Ana Para Birimi *", "Base currency *")}</label>
                  <select id="setup-currency"
                    value={baseCurrency}
                    onChange={(e) => setBaseCurrency(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2.5 text-slate-900 font-bold focus:outline-none focus:border-blue-600"
                  >
                    <option value="TRY">{t("Türk Lirası (₺ - TRY)", "Turkish lira (₺ - TRY)")}</option>
                    <option value="USD">{t("Amerikan Doları ($ - USD)", "US dollar ($ - USD)")}</option>
                    <option value="EUR">Euro (€ - EUR)</option>
                    <option value="GBP">{t("İngiliz Sterlini (£ - GBP)", "British pound (£ - GBP)")}</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="setup-project" className="block text-slate-700 font-semibold mb-1">{t("İlk Proje / Şantiye Adı", "First project name")}</label>
                  <input id="setup-project"
                    type="text"
                    placeholder={t("Örn: Merkez Şantiye Bütçesi", "Example: Main site budget")}
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
                  <span>{t("Devam Et", "Continue")}</span>
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
                  <span>{t("Adım 2: İlk Yönetici (Admin) Hesabı & 4 Haneli Hızlı PIN", "Step 2: Administrator account and four-digit PIN")}</span>
                </h2>
                <p className="text-slate-500 mt-0.5">
                  {t("Sisteme tam yetkili ilk kullanıcıyı oluşturun. 4 haneli PIN şantiyede hızlı giriş için kullanılacaktır.", "Create the first administrator account and set a four-digit screen-lock PIN.")}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="setup-name" className="block text-slate-700 font-semibold mb-1">{t("Ad Soyad *", "Full name *")}</label>
                  <input id="setup-name"
                    type="text"
                    placeholder={t("Örn: Orhan Yılmaz", "Example: Alex Rivera")}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                    autoFocus
                    required
                  />
                </div>

                <div>
                  <label htmlFor="setup-account" className="block text-slate-700 font-semibold mb-1">{t("Kullanıcı Adı *", "Username *")}</label>
                  <input id="setup-account"
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
                  <label htmlFor="setup-email" className="block text-slate-700 font-semibold mb-1">{t("E-posta Adresi *", "Email address *")}</label>
                  <input id="setup-email"
                    type="email"
                    placeholder={t("admin@sirketiniz.com", "admin@example.com")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="setup-password" className="block text-slate-700 font-semibold mb-1">{t("Yönetici Parolası (En az 8) *", "Administrator password (at least 8 characters) *")}</label>
                  <input id="setup-password"
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
                  <label htmlFor="setup-pin" className="block text-blue-950 font-bold mb-0.5">{t("4 Haneli Hızlı PIN Kodu *", "Four-digit PIN *")}</label>
                  <p className="text-[11px] text-blue-700">{t("Ekran kilitlendiğinde kendi hesabınızın kilidini açmak için girilecek PIN", "Use this PIN to unlock the screen for your account.")}</p>
                </div>
                <input id="setup-pin"
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
                  <label htmlFor="setup-token" className="block text-slate-700 font-semibold mb-1">{t("Kurulum anahtarı *", "Setup token *")}</label>
                  <input id="setup-token" type="password" autoComplete="off" placeholder={t("Kurulum anahtarını girin", "Enter the setup token")} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600" required />
                  <p className="text-[11px] text-slate-500 mt-1">{t("Kurulum anahtarını sunucu yöneticisi sağlar; yalnızca ilk kurulum için gereklidir.", "Use the server setup token. It is required only for first-time setup.")}</p>
                </div>

              <div className="pt-4 flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  {t("Geri", "Back")}
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
                  <span>{t("Devam Et", "Continue")}</span>
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
                  <span>{t("Adım 3: Sektör Şablonu & Başlangıç Kategorileri", "Step 3: Industry template and starting categories")}</span>
                </h2>
                <p className="text-slate-500 mt-0.5">
                  {t("İşinize en uygun kategorileri tek tıkla yükleyin (Daha sonra dilediğiniz gibi düzenleyebilirsiniz).", "Choose a set of starting categories. You can edit them later.")}
                </p>
              </div>

              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {templates.map((tmpl) => {
                  const text = (language === 'en' ? englishTemplates[tmpl.id] : undefined) ?? tmpl;
                  return (
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
                      <div className="font-bold text-slate-900 text-sm">{text.title}</div>
                      <span className="text-[10px] bg-slate-200 px-2 py-0.5 rounded-full font-semibold text-slate-700">
                        {tmpl.categoryCount} {t("Kalem", tmpl.categoryCount === 1 ? "item" : "items")}
                      </span>
                    </div>
                    <p className="text-slate-500 text-[11px] mt-1">{text.description}</p>
                  </div>
                  );
                })}
              </div>

              <div className="pt-4 flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  {t("Geri", "Back")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setStep(4);
                  }}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm"
                >
                  <span>{t("Özeti İncele", "Review setup")}</span>
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
                  <span>{t("Adım 4: Kurulum Özeti & Onay", "Step 4: Review and confirm")}</span>
                </h2>
                <p className="text-slate-500 mt-0.5">{t("Bilgileri kontrol edip sistemi başlatın.", "Review your information before creating the account.")}</p>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2.5">
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">{t("Şirket / Kuruluş:", "Organization:")}</span>
                  <strong className="text-slate-900">{companyName}</strong>
                </div>
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">{t("Ana Para Birimi:", "Base currency:")}</span>
                  <strong className="text-slate-900">{baseCurrency}</strong>
                </div>
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">{t("Yönetici Kullanıcı:", "Administrator:")}</span>
                  <strong className="text-slate-900">{fullName} (@{username})</strong>
                </div>
                <div className="flex justify-between pb-2 border-b border-slate-200">
                  <span className="text-slate-500">{t("4 Haneli PIN Kodu:", "Four-digit PIN:")}</span>
                  <span className="font-mono font-bold text-blue-700">{t("•••• (Kayıtlı)", "•••• (entered)")}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{t("Seçilen Sektör Şablonu:", "Industry template:")}</span>
                  <strong className="text-slate-900 capitalize">{language === 'en' ? englishTemplates[selectedTemplate]?.title ?? selectedTemplate : templates.find((tmpl) => tmpl.id === selectedTemplate)?.title ?? selectedTemplate}</strong>
                </div>
              </div>

              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900 flex items-center gap-2">
                <Shield className="h-5 w-5 text-emerald-600 shrink-0" />
                <span>
                  {t("Verileriniz AES-256-GCM alan şifreleme ve SHA-256 denetim zinciri ile güvence altına alınacaktır.", "Selected fields use AES-256-GCM encryption. The audit trail uses a SHA-256 chain.")}
                </span>
              </div>

              <div className="pt-4 flex justify-between">
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  className="px-5 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  {t("Geri", "Back")}
                </button>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleFinishSetup}
                  className="flex items-center gap-2 px-8 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-sm transition shadow-lg disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4" />
                  <span>{isSubmitting ? t("Kurulum Yapılıyor...", "Setting up…") : t("Kurulumu Tamamla ve Başlat", "Finish setup")}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
