import React, { useEffect, useLayoutEffect, useId, useState, useSyncExternalStore } from 'react';
import { ProjectMembershipController } from '../project-membership.js';
import { useLocale } from '../context/LocaleContext.js';

export function localizeMembershipMessage(text: string, t: ReturnType<typeof useLocale>['t']): string {
  switch (text) {
    case 'Oturumunuz geçerli değil. Lütfen yeniden giriş yapın.':
      return t(text, 'Your session is no longer valid. Sign in again.');
    case 'Bu işlem için yönetici yetkisi gerekiyor. Yetkilerinizi kontrol edip yeniden deneyin.':
      return t(text, 'This action requires administrator access. Check your permissions and try again.');
    case 'İşlem tamamlanamadı. Lütfen yeniden deneyin.':
      return t(text, 'Could not complete the action. Please try again.');
    case 'Üyelik güncellendi.':
      return t(text, 'Membership updated.');
    case 'İstenen üyelik durumu zaten geçerliydi; değişiklik yapılmadı.':
      return t(text, 'The requested membership was already in effect.');
    default:
      return text;
  }
}

interface Props { currentUser: { id?: string; role?: string } | null; }
export const ProjectMembershipPanel: React.FC<Props> = ({ currentUser }) => {
  return <MembershipPanel key={currentUser?.id || 'anonymous'} role={currentUser?.role || ''} />;
};

const MembershipPanel: React.FC<{ role: string }> = ({ role }) => {
  const { t } = useLocale();
  const [controller] = useState(() => new ProjectMembershipController(role));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [selectedUser, setSelectedUser] = useState('');
  const projectSelectId = useId(), userSelectId = useId(), headingId = useId();
  // Invalidate in the commit phase, not a later passive cleanup, so a promise
  // cannot publish between a role/unmount commit and effect cleanup.
  useLayoutEffect(() => { void controller.start(); return controller.dispose; }, [controller]);
  useLayoutEffect(() => { controller.setRole(role); }, [controller, role]);
  // A selection is not a grant. The submit handler rechecks current candidates.
  useEffect(() => { setSelectedUser(''); }, [state.projectId, state.users, state.members]);
  const candidates = controller.getCandidates();
  const busy = state.loading || state.loadingMembers || state.saving;
  if (role !== 'admin') return null;
  return (
    <section aria-labelledby={headingId} aria-busy={busy} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4 text-xs">
      <h3 id={headingId} className="font-bold text-sm text-slate-900">{t('Proje / Şantiye Üyelikleri', 'Project / Site Membership')}</h3>
      <p className="text-slate-600">{t('Yöneticiler tüm projelere global erişir; yöneticiye üyelik atamak gerekmez. Diğer kullanıcılar yalnız atandıkları projelere erişir. Kullanıcı oluşturmak otomatik proje ataması yapmaz. Yetkiler sunucuda doğrulanır.', 'Administrators already have access to every project. All other users can access only their assigned projects. Creating a user does not assign them to a project. The server checks permissions.')}</p>
      {state.error && <p role="alert" className="text-rose-700 bg-rose-50 p-3 rounded-lg">{localizeMembershipMessage(state.error, t)}{t(' Yazma işlemi gönderildiyse sonucu doğrulamak için listeyi yeniden yükleyin.', ' If you submitted a change, reload the list to verify the result.')}</p>}
      {state.notice && <p role="status" className="text-slate-700 bg-slate-50 p-3 rounded-lg">{localizeMembershipMessage(state.notice, t)}</p>}
      <button type="button" disabled={busy} onClick={() => { void controller.load(); }} className="text-blue-600 font-semibold disabled:opacity-50">{t('Projeleri ve kullanıcıları yeniden yükle', 'Reload Projects and Users')}</button>
      {state.loading ? <p role="status">{t('Projeler ve kullanıcılar yükleniyor...', 'Loading projects and users...')}</p> : <>
        {!state.projects.length && !state.error && <p>{t('Henüz proje bulunmuyor.', 'No projects yet.')}</p>}
        <div>
          <label htmlFor={projectSelectId} className="block font-semibold text-slate-700 mb-1">{t('Proje / Şantiye seçin', 'Select a Project / Site')}</label>
          <select id={projectSelectId} value={state.projectId} onChange={(event) => { setSelectedUser(''); void controller.selectProject(event.target.value); }} className="w-full border border-slate-300 rounded-lg p-2 bg-slate-50">
            <option value="">{t('Proje seçin', 'Select a project')}</option>
            {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        {state.projectId && <button type="button" disabled={busy} onClick={() => { void controller.reloadMembers(); }} className="text-blue-600 font-semibold disabled:opacity-50">{t('Üyeleri yeniden yükle', 'Reload Members')}</button>}
        {state.saving && <p role="status">{t('Üyelik kaydediliyor...', 'Saving membership...')}</p>}
        {state.loadingMembers && <p role="status">{t('Üyeler yükleniyor...', 'Loading members...')}</p>}
        {state.ready && <>
          {!state.members.length ? <p>{t('Bu projeye atanmış kullanıcı yok.', 'No users are assigned to this project.')}</p> : <ul className="divide-y divide-slate-200">
            {state.members.map((member) => {
              const user = state.users.find((u) => u.id === member.userId);
              return <li key={member.userId} className="flex items-center justify-between gap-3 py-2">
                <span>{user?.fullName || member.userId} {user && <span className="text-slate-500">(@{user.username} · {user.role}{!user.isActive ? t(' · Pasif', ' · Inactive') : ''})</span>}</span>
                <button type="button" aria-label={t(`${user?.fullName || member.userId} üyeliğini kaldır`, `Remove membership for ${user?.fullName || member.userId}`)} onClick={() => { void controller.changeMembership(member.userId, false); }} className="text-rose-700 font-semibold">{t('Kaldır', 'Remove')}</button>
              </li>;
            })}
          </ul>}
          <form onSubmit={(event) => { event.preventDefault(); void controller.changeMembership(selectedUser, true); }} className="space-y-2">
            <label htmlFor={userSelectId} className="block font-semibold text-slate-700">{t('Aktif kullanıcı ekle', 'Add an Active User')}</label>
            <select id={userSelectId} value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)} className="w-full border border-slate-300 rounded-lg p-2 bg-slate-50">
              <option value="">{t('Kullanıcı seçin', 'Select a user')}</option>
              {candidates.map((user) => <option key={user.id} value={user.id}>{user.fullName} (@{user.username} · {user.role})</option>)}
            </select>
            {!candidates.length && <p>{t('Eklenebilecek aktif, yönetici olmayan kullanıcı yok.', 'No active non-admin users are available to add.')}</p>}
            <p className="text-slate-500">{t('Pasif kullanıcılara yeni üyelik atanmaz; mevcut üyelikleri kaldırılabilir.', 'You can remove existing memberships for inactive users. New memberships require an active user.')}</p>
            <button type="submit" disabled={!candidates.some((u) => u.id === selectedUser)} className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold disabled:opacity-50">{t('Projeye ekle', 'Add to Project')}</button>
          </form>
        </>}
      </>}
    </section>
  );
};
