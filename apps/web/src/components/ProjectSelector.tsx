import React, { useState } from 'react';
import { Building, Plus, Check } from 'lucide-react';
import type { Project } from '@cost-core/types';

interface ProjectSelectorProps {
  canCreate?: boolean;
  disabled?: boolean;
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  onCreateProject: (name: string, budget?: number) => Promise<void>;
}

export function canSubmitProject(canCreate: boolean, disabled: boolean, name: string): boolean {
  return canCreate && !disabled && name.trim().length > 0;
}

export const ProjectSelector: React.FC<ProjectSelectorProps> = ({
  canCreate = false,
  disabled = false,
  projects,
  selectedProjectId,
  onSelectProject,
  onCreateProject,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectBudget, setNewProjectBudget] = useState('');
  const [error, setError] = useState('');

  const currentProject = projects.find((p) => p.id === selectedProjectId);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitProject(canCreate, disabled, newProjectName)) return;
    setError('');
    try {
      await onCreateProject(newProjectName.trim(), newProjectBudget ? parseFloat(newProjectBudget) : 0);
      setNewProjectName('');
      setNewProjectBudget('');
      setIsCreating(false);
    } catch { setError('Proje oluşturulamadı. Lütfen yeniden deneyin.'); }
  };

  return (
    <div className="relative">
      <button
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 hover:border-slate-600 text-xs text-slate-200 transition font-medium"
      >
        <Building className="h-4 w-4 text-blue-400" />
        <span>
          {currentProject ? (
            <span className="font-bold text-white">{currentProject.name}</span>
          ) : (
            <span className="text-slate-300">🏢 Tüm Şantiyeler / Projeler (Konsolide)</span>
          )}
        </span>
        <span className="text-slate-500">▼</span>
      </button>

      {isOpen && !disabled && (
        <div className="absolute left-0 mt-2 w-72 rounded-xl bg-slate-900 border border-slate-800 shadow-2xl z-50 p-2 text-xs">
          <div className="px-2 py-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800 mb-1">
            Aktif Proje / Şantiye Seçimi
          </div>

          <button
            onClick={() => {
              onSelectProject(null);
              setIsOpen(false);
            }}
            className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center justify-between transition"
          >
            <span>🏢 Tüm Projeler (Konsolide Bilanço)</span>
            {!selectedProjectId && <Check className="h-4 w-4 text-emerald-400" />}
          </button>

          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onSelectProject(p.id);
                setIsOpen(false);
              }}
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center justify-between transition"
            >
              <div className="truncate pr-2">
                <div className="font-medium text-white truncate">{p.name}</div>
                {p.budget > 0 && (
                  <div className="text-[10px] text-slate-400">
                    Bütçe: {new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(p.budget)}
                  </div>
                )}
              </div>
              {selectedProjectId === p.id && <Check className="h-4 w-4 text-emerald-400 shrink-0" />}
            </button>
          ))}

          {/* Yeni Proje Ekle Butonu */}
          {canCreate && <div className="pt-2 border-t border-slate-800 mt-1">
            {!isCreating ? (
              <button
                onClick={() => setIsCreating(true)}
                className="w-full py-1.5 px-3 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 flex items-center justify-center gap-1 font-medium transition"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Yeni Proje / Şantiye Aç</span>
              </button>
            ) : (
              <form onSubmit={handleCreate} className="space-y-2 p-1">
                {error && <p role="alert">{error}</p>}
                <input
                  type="text"
                  placeholder="Proje / Şantiye Adı *"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                  autoFocus
                  required
                />
                <input
                  type="number"
                  placeholder="Hedef Bütçe (TL)"
                  value={newProjectBudget}
                  onChange={(e) => setNewProjectBudget(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
                />
                <div className="flex gap-1.5">
                  <button
                    type="submit"
                    className="flex-1 py-1 rounded bg-blue-600 text-white font-medium hover:bg-blue-500"
                  >
                    Oluştur
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="px-2 py-1 rounded bg-slate-800 text-slate-400 hover:text-white"
                  >
                    İptal
                  </button>
                </div>
              </form>
            )}
          </div>}
        </div>
      )}
    </div>
  );
};
