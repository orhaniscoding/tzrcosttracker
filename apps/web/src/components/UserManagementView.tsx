import React, { useState, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Users, UserPlus, KeyRound, Check, RefreshCw } from 'lucide-react';
import { ApiClient } from '../api/client.js';
import { useTheme } from '../context/ThemeContext.js';
import { localizeMembershipMessage, ProjectMembershipPanel } from './ProjectMembershipPanel.js';
import { canListManagedUsers, membershipError } from '../project-membership.js';
import { useLocale } from '../context/LocaleContext.js';

interface UserManagementViewProps {
  currentUser: any;
  onRefreshAuth: () => Promise<void>;
  subView?: 'list' | 'new' | 'pin';
  onNavigateToList?: () => void;
}

export const UserManagementView: React.FC<UserManagementViewProps> = (props) => {
  const generation = useSyncExternalStore(ApiClient.subscribeAuthChange.bind(ApiClient), ApiClient.getAuthGeneration.bind(ApiClient), ApiClient.getAuthGeneration.bind(ApiClient));
  return <UserManagementContent key={`${props.currentUser?.id}:${props.currentUser?.role}:${props.subView}:${generation}`} {...props} />;
};

const UserManagementContent: React.FC<UserManagementViewProps> = ({
  currentUser,
  onRefreshAuth,
  subView,
  onNavigateToList,
}) => {
  const { t } = useLocale();
  const { settings } = useTheme();
  const mounted = useRef(false);
  const requestNumber = useRef(0);
  const generation = ApiClient.getAuthGeneration();
  const isAdmin = currentUser?.role === 'admin';
  const isCurrent = () => mounted.current && generation === ApiClient.getAuthGeneration() && !!ApiClient.getToken();

  const [users, setUsers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [listError, setListError] = useState('');

  // Yeni Kullanıcı Ekleme Formu
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('viewer');
  const [pin, setPin] = useState('');
  const [addUserError, setAddUserError] = useState('');
  const [isSubmittingUser, setIsSubmittingUser] = useState(false);

  // Kendi PIN'ini Güncelleme Formu
  const [myPin, setMyPin] = useState('');
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const [isSubmittingPin, setIsSubmittingPin] = useState(false);

  const fetchUsers = async () => {
    if (!canListManagedUsers(currentUser?.role, subView) || !isCurrent()) return;
    const request = ++requestNumber.current;
    try {
      setIsLoading(true);
      setUsers([]);
      setListError('');
      const list = await ApiClient.getUsers();
      if (isCurrent() && request === requestNumber.current) setUsers(list);
    } catch (e) {
      if (isCurrent() && request === requestNumber.current) setListError(membershipError(e));
    } finally {
      if (isCurrent() && request === requestNumber.current) setIsLoading(false);
    }
  };

  useLayoutEffect(() => {
    mounted.current = true;
    void fetchUsers();
    return () => { mounted.current = false; requestNumber.current++; };
  }, []);

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !isCurrent() || isSubmittingUser || subView === 'pin') return;
    if (!username || !fullName || !email || !password) return;

    try {
      setIsSubmittingUser(true);
      setAddUserError('');
      await ApiClient.createUser({
        username,
        fullName,
        email,
        password,
        role,
        pin: pin || undefined,
      });
      if (!isCurrent()) return;

      setUsername('');
      setFullName('');
      setEmail('');
      setPassword('');
      setPin('');
      setIsAddingUser(false);
      await fetchUsers();
      if (isCurrent() && onNavigateToList) onNavigateToList();
    } catch (err: any) {
      if (isCurrent()) setAddUserError(membershipError(err));
    } finally {
      if (isCurrent()) setIsSubmittingUser(false);
    }
  };

  const handleSetMyPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser?.id || subView !== 'pin' || !isCurrent() || isSubmittingPin) return;
    if (!/^\d{4}$/.test(myPin)) {
      setPinNotice(t('Lütfen 4 haneli bir PIN kodu giriniz.', 'Enter a 4-digit PIN.'));
      return;
    }

    try {
      setIsSubmittingPin(true);
      setPinNotice(null);
      await ApiClient.setUserPin({ pin: myPin });
      if (!isCurrent()) return;
      setPinNotice(t('4 haneli hızlı PIN kodunuz başarıyla kaydedildi!', 'Your 4-digit PIN was saved.'));
      setMyPin('');
      await onRefreshAuth();
    } catch (err: any) {
      if (isCurrent()) setPinNotice(membershipError(err));
    } finally {
      if (isCurrent()) setIsSubmittingPin(false);
    }
  };

  const roleLabels: Record<string, { label: string; color: string }> = {
    admin: { label: t('Yönetici (Admin)', 'Administrator (Admin)'), color: 'bg-rose-100 text-rose-800 border-rose-300' },
    manager: { label: t('Şantiye Müdürü', 'Site Manager'), color: 'bg-purple-100 text-purple-800 border-purple-300' },
    accountant: { label: t('Muhasebe / Kasa', 'Accounting / Cash'), color: 'bg-blue-100 text-blue-800 border-blue-300' },
    auditor: { label: t('Denetçi / Mühür', 'Auditor / Integrity Seal'), color: 'bg-amber-100 text-amber-800 border-amber-300' },
    viewer: { label: t('Salt Okunur (İzleyici)', 'Read-Only (Viewer)'), color: 'bg-slate-100 text-slate-800 border-slate-300' },
  };

  if (!isAdmin && subView !== 'pin') return <p role="alert" className="p-4 bg-slate-50 text-slate-700 rounded-xl">{t('Kullanıcı ve proje üyeliği yönetimi yalnızca yöneticiler içindir.', 'Only administrators can manage users and project memberships.')}</p>;

  return (
    <div className="space-y-6">
      {/* 1. SADECE YENİ KULLANICI EKLEME GÖRÜNÜMÜ */}
      {subView === 'new' || (isAddingUser && subView !== 'pin') ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-4 max-w-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <h3 className="font-bold text-slate-800 flex items-center gap-2 text-sm">
              <UserPlus className="h-5 w-5 text-blue-600" />
              <span>{t('Yeni Personel / Kullanıcı Tanımlama', 'Add a User')}</span>
            </h3>
            {(
              <button
                onClick={() => { setIsAddingUser(false); onNavigateToList?.(); }}
                className="text-xs text-blue-600 hover:underline font-semibold"
              >
                {t('← Kullanıcı Listesine Dön', '← Back to Users')}
              </button>
            )}
          </div>

          {addUserError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-xs">
              {localizeMembershipMessage(addUserError, t)}
            </div>
          )}

          <form onSubmit={handleAddUser} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-6">
                <label className="block text-slate-700 font-semibold mb-1">{t('Ad Soyad *', 'Full Name *')}</label>
                <input
                  type="text"
                  placeholder={t('Örn: Yılmaz Sağır', 'E.g. Jordan Lee')}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                  autoFocus
                  required
                />
              </div>

              <div className="sm:col-span-6">
                <label className="block text-slate-700 font-semibold mb-1">{t('Kullanıcı Adı (Giriş için) *', 'Username (for Sign-In) *')}</label>
                <input
                  type="text"
                  placeholder={t('Örn: yilmaz_sagir', 'E.g. jordan_lee')}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-6">
                <label className="block text-slate-700 font-semibold mb-1">{t('E-posta Adresi *', 'Email Address *')}</label>
                <input
                  type="email"
                  placeholder={t('yilmaz@sirket.com', 'jordan@example.com')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  required
                />
              </div>

              <div className="sm:col-span-6">
                <label className="block text-slate-700 font-semibold mb-1">{t('Parola (İlk Giriş) *', 'Password (First Sign-In) *')}</label>
                <input
                  type="password"
                  placeholder={t('En az 8 karakter...', 'At least 8 characters...')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div className="sm:col-span-6">
                <label className="block text-slate-700 font-semibold mb-1">{t('Rol & Yetki Seviyesi *', 'Role & Permissions *')}</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                >
                  <option value="admin">{t('Yönetici (Tüm Yetkiler)', 'Administrator (Full Access)')}</option>
                  <option value="manager">{t('Şantiye Müdürü (Onay & Rapor)', 'Site Manager (Approvals & Reports)')}</option>
                  <option value="accountant">{t('Muhasebe & Kasa Girişi', 'Accounting & Cash Entry')}</option>
                  <option value="auditor">{t('Denetçi / Mühür', 'Auditor / Integrity Seal')}</option>
                  <option value="viewer">{t('Salt Okunur (İzleyici)', 'Read-Only (Viewer)')}</option>
                </select>
              </div>

              <div className="sm:col-span-6">
                <label className="block text-slate-700 font-semibold mb-1">{t('Hızlı Giriş PIN Kodu (4 Hane)', 'Quick Sign-In PIN (4 Digits)')}</label>
                <input
                  type="text"
                  maxLength={4}
                  placeholder={t('Örn: 1234', 'E.g. 1234')}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono tracking-widest text-center focus:outline-none focus:border-blue-600"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              {(
                <button
                  type="button"
                  onClick={() => { setIsAddingUser(false); onNavigateToList?.(); }}
                  className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition"
                >
                  {t('Vazgeç', 'Cancel')}
                </button>
              )}
              <button
                type="submit"
                disabled={isSubmittingUser}
                className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
              >
                {isSubmittingUser ? t('Kaydediliyor...', 'Saving...') : t('Kullanıcıyı Kaydet', 'Save User')}
              </button>
            </div>
          </form>
        </div>
      ) : subView === 'pin' ? (
        /* 2. SADECE KİŞİSEL PIN AYARI GÖRÜNÜMÜ */
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm max-w-xl space-y-4">
          <div className="flex items-center gap-3 border-b border-slate-200 pb-3">
            <div className="h-10 w-10 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                {t('Kişisel 4 Haneli Hızlı PIN Tanımlama (Kiosk Modu)', 'Set Your 4-Digit Quick PIN (Kiosk Mode)')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                 {t('Yalnızca kendi hesabınız için 4 haneli PIN belirleyin. Başka hesaba geçiş parola ile yapılır.', 'Set a 4-digit PIN for your own account. To switch accounts, sign in with a password.')}
              </p>
            </div>
          </div>

          {pinNotice && (
            <div role="status" className="p-3 bg-slate-50 border border-slate-300 rounded-lg text-slate-900 text-xs font-semibold flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-700" />
              <span>{localizeMembershipMessage(pinNotice, t)}</span>
            </div>
          )}

          <form onSubmit={handleSetMyPin} className="space-y-4 text-xs">
            <div>
              <label htmlFor="personal-pin" className="block text-slate-700 font-semibold mb-1.5">
                {t('Yeni 4 Haneli PIN Kodunuz', 'Your New 4-Digit PIN')}
              </label>
              <input
                id="personal-pin"
                type="password"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                placeholder="****"
                value={myPin}
                onChange={(e) => setMyPin(e.target.value.replace(/\D/g, ''))}
                className="w-48 bg-slate-50 border border-slate-300 rounded-lg px-4 py-2.5 text-center text-lg font-mono tracking-widest text-slate-900 focus:outline-none focus:border-blue-600 font-bold"
                autoFocus
                required
              />
              <p className="text-[11px] text-slate-500 mt-1.5">
                {t('PIN kodunuz sunucuda Scrypt ile hashlenerek saklanır.', 'The server stores a hash of your PIN using scrypt.')}
              </p>
            </div>

            <button
              type="submit"
              disabled={isSubmittingPin}
              className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
            >
              {isSubmittingPin ? t('Kaydediliyor...', 'Saving...') : t('PIN Kodunu Güncelle', 'Update PIN')}
            </button>
          </form>
        </div>
      ) : (
        /* 3. KULLANICI LİSTESİ VE DİĞERLERİ */
        <>
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Users className="h-5 w-5 text-blue-600" />
                  <span>{t('Kullanıcı Yönetimi & Roller', 'User Management & Roles')}</span>
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {t('Sistemdeki tüm personellerin yetkilerini ve aktif durumlarını yönetin', 'Manage user permissions and account status.')}
                </p>
              </div>

              {isAdmin && (
                <button
                  onClick={() => setIsAddingUser(!isAddingUser)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-sm transition"
                  style={{ backgroundColor: settings.primaryColor }}
                >
                  <UserPlus className="h-4 w-4" />
                  <span>{isAddingUser ? t('Formu Kapat', 'Close Form') : t('+ Yeni Kullanıcı Ekle', '+ Add New User')}</span>
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* KULLANICILAR LİSTESİ TABLOSU (subView 'list' veya undefined olduğunda gösterilir) */}
      {(subView === 'list' || !subView) && !isAddingUser && (
        <>
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800">
              {t('Kayıtlı Kullanıcılar & Yetkiler (', 'Registered Users & Permissions (')}{users.length}{t(' kişi)', ' users)')}
            </span>
            <button
              onClick={fetchUsers}
              disabled={isLoading}
              className="text-xs text-blue-600 hover:underline flex items-center gap-1 font-medium"
            >
              <RefreshCw className={`h-3 w-3 ${isLoading ? 'animate-spin' : ''}`} />
              <span>{t('Yenile', 'Refresh')}</span>
            </button>
          </div>

          {listError && <p role="alert" className="p-4 text-rose-700">{localizeMembershipMessage(listError, t)}{t(' Yenile düğmesiyle tekrar deneyin.', ' Click Refresh to try again.')}</p>}
          {isLoading && <p role="status" className="p-4 text-slate-600">{t('Kullanıcılar yükleniyor...', 'Loading users...')}</p>}
          {!isLoading && !listError && !users.length && <p className="p-4 text-slate-600">{t('Kayıtlı kullanıcı bulunmuyor.', 'No users found.')}</p>}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100 text-slate-700 font-semibold uppercase border-b border-slate-200">
                <th className="py-2.5 px-4">{t('Kullanıcı Adı & İsim', 'Username & Name')}</th>
                <th className="py-2.5 px-4">{t('E-posta', 'Email')}</th>
                <th className="py-2.5 px-4">{t('Yetki Rolü', 'Role')}</th>
                <th className="py-2.5 px-4 text-center">{t('Hızlı PIN', 'Quick PIN')}</th>
                <th className="py-2.5 px-4 text-center">{t('2FA Durumu', '2FA Status')}</th>
                <th className="py-2.5 px-4 text-center">{t('Durum', 'Status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {users.map((u) => {
                const isCurrent = u.id === currentUser?.id;
                const rInfo = roleLabels[u.role] || roleLabels.viewer;

                return (
                  <tr key={u.id} className={`hover:bg-slate-50 ${isCurrent ? 'bg-blue-50/30' : ''}`}>
                    <td className="py-2.5 px-4 font-bold text-slate-900 flex items-center gap-2.5">
                      <div className="h-8 w-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-xs uppercase">
                        {u.fullName.slice(0, 2)}
                      </div>
                      <div>
                        <div>
                          {u.fullName} {isCurrent && <span className="text-blue-600 font-bold">{t('(Siz)', '(You)')}</span>}
                        </div>
                        <div className="text-[11px] text-slate-400 font-normal font-mono">@{u.username}</div>
                      </div>
                    </td>

                    <td className="py-2.5 px-4 text-slate-600">{u.email}</td>

                    <td className="py-2.5 px-4">
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold border ${rInfo.color}`}>
                        {rInfo.label}
                      </span>
                    </td>

                    <td className="py-2.5 px-4 text-center">
                      {u.hasPin ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-300">
                          {t('✓ Aktif (4 Haneli)', '✓ Active (4 Digits)')}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">-</span>
                      )}
                    </td>

                    <td className="py-2.5 px-4 text-center">
                      {u.twoFactorEnabled ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-300">
                          {t('✓ Açık (TOTP)', '✓ Enabled (TOTP)')}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">{t('Kapalı', 'Disabled')}</span>
                      )}
                    </td>

                    <td className="py-2.5 px-4 text-center">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        {u.isActive ? t('Aktif', 'Active') : t('Pasif', 'Inactive')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
           </table>
        </div>
       </div>
        <ProjectMembershipPanel currentUser={currentUser} />
        </>
      )}
    </div>
  );
};
