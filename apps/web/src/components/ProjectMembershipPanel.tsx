import React, { useEffect, useLayoutEffect, useId, useState, useSyncExternalStore } from 'react';
import { ProjectMembershipController } from '../project-membership.js';

interface Props { currentUser: { id?: string; role?: string } | null; }
export const ProjectMembershipPanel: React.FC<Props> = ({ currentUser }) => {
  return <MembershipPanel key={currentUser?.id || 'anonymous'} role={currentUser?.role || ''} />;
};

const MembershipPanel: React.FC<{ role: string }> = ({ role }) => {
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
      <h3 id={headingId} className="font-bold text-sm text-slate-900">Proje / Şantiye Üyelikleri</h3>
      <p className="text-slate-600">Yöneticiler tüm projelere global erişir; yöneticiye üyelik atamak gerekmez. Diğer kullanıcılar yalnız atandıkları projelere erişir. Kullanıcı oluşturmak otomatik proje ataması yapmaz. Yetkiler sunucuda doğrulanır.</p>
      {state.error && <p role="alert" className="text-rose-700 bg-rose-50 p-3 rounded-lg">{state.error} Yazma işlemi gönderildiyse sonucu doğrulamak için listeyi yeniden yükleyin.</p>}
      {state.notice && <p role="status" className="text-slate-700 bg-slate-50 p-3 rounded-lg">{state.notice}</p>}
      <button type="button" disabled={busy} onClick={() => { void controller.load(); }} className="text-blue-600 font-semibold disabled:opacity-50">Projeleri ve kullanıcıları yeniden yükle</button>
      {state.loading ? <p role="status">Projeler ve kullanıcılar yükleniyor...</p> : <>
        {!state.projects.length && !state.error && <p>Henüz proje bulunmuyor.</p>}
        <div>
          <label htmlFor={projectSelectId} className="block font-semibold text-slate-700 mb-1">Proje / Şantiye seçin</label>
          <select id={projectSelectId} value={state.projectId} onChange={(event) => { setSelectedUser(''); void controller.selectProject(event.target.value); }} className="w-full border border-slate-300 rounded-lg p-2 bg-slate-50">
            <option value="">Proje seçin</option>
            {state.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        {state.projectId && <button type="button" disabled={busy} onClick={() => { void controller.reloadMembers(); }} className="text-blue-600 font-semibold disabled:opacity-50">Üyeleri yeniden yükle</button>}
        {state.saving && <p role="status">Üyelik kaydediliyor...</p>}
        {state.loadingMembers && <p role="status">Üyeler yükleniyor...</p>}
        {state.ready && <>
          {!state.members.length ? <p>Bu projeye atanmış kullanıcı yok.</p> : <ul className="divide-y divide-slate-200">
            {state.members.map((member) => {
              const user = state.users.find((u) => u.id === member.userId);
              return <li key={member.userId} className="flex items-center justify-between gap-3 py-2">
                <span>{user?.fullName || member.userId} {user && <span className="text-slate-500">(@{user.username} · {user.role}{!user.isActive ? ' · Pasif' : ''})</span>}</span>
                <button type="button" aria-label={`${user?.fullName || member.userId} üyeliğini kaldır`} onClick={() => { void controller.changeMembership(member.userId, false); }} className="text-rose-700 font-semibold">Kaldır</button>
              </li>;
            })}
          </ul>}
          <form onSubmit={(event) => { event.preventDefault(); void controller.changeMembership(selectedUser, true); }} className="space-y-2">
            <label htmlFor={userSelectId} className="block font-semibold text-slate-700">Aktif kullanıcı ekle</label>
            <select id={userSelectId} value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)} className="w-full border border-slate-300 rounded-lg p-2 bg-slate-50">
              <option value="">Kullanıcı seçin</option>
              {candidates.map((user) => <option key={user.id} value={user.id}>{user.fullName} (@{user.username} · {user.role})</option>)}
            </select>
            {!candidates.length && <p>Eklenebilecek aktif, yönetici olmayan kullanıcı yok.</p>}
            <p className="text-slate-500">Pasif kullanıcılara yeni üyelik atanmaz; mevcut üyelikleri kaldırılabilir.</p>
            <button type="submit" disabled={!candidates.some((u) => u.id === selectedUser)} className="px-4 py-2 rounded-lg bg-blue-600 text-white font-bold disabled:opacity-50">Projeye ekle</button>
          </form>
        </>}
      </>}
    </section>
  );
};
