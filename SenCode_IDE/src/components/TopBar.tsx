/**
 * TopBar — app header.
 * Logo uses the real icon image. Open Folder/File merged into one dropdown button.
 * Runtimes live in the sidebar. New File lives next to the project name in Files.
 */

import { useState, useRef, useEffect } from 'react';
import { SlidersHorizontal, Code2, MessageCircle, FolderOpen, FileCode2, ChevronDown, FolderX, FolderPlus, Shield } from 'lucide-react';
import { ModelSelector } from './Chat/ModelSelector';
import type { ModelInfo, AppMode, HardwareInfo } from '../lib/types';
import iconUrl from '../assets/icon.png';

interface TopBarProps {
  models: ModelInfo[];
  activeModel: string;
  connected: boolean;
  backendType?: string; // retained for future use but not rendered
  projectPath: string;
  mode: AppMode;
  hardwareInfo?: HardwareInfo | null;
  onModeChange: (mode: AppMode) => void;
  onModelSelect: (id: string) => void;
  onRefreshModels: () => void;
  onOpenSettings: () => void;
  onOpenLicense: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onOpenRuntimeLibrary: () => void;
  onCloseFolder: () => void;
  onNewProject: () => void;
  /** Optional: number of grace days remaining (0-15). Shows amber indicator on shield when ≤5. */
  graceDaysLeft?: number | null;
}

export function TopBar({
  models, activeModel, connected, projectPath, mode, hardwareInfo,
  onModeChange, onModelSelect, onRefreshModels, onOpenSettings, onOpenLicense,
  onOpenFolder, onOpenFile, onOpenRuntimeLibrary, onCloseFolder, onNewProject,
  graceDaysLeft,
}: TopBarProps) {
  const folderName = projectPath ? projectPath.split(/[\\/]/).pop() : null;
  const [openDropdown, setOpenDropdown] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpenDropdown(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // Show amber dot on shield when license grace period is running low (≤5 days)
  const showGraceAlert = graceDaysLeft !== null && graceDaysLeft !== undefined && graceDaysLeft <= 5;

  return (
    <header className="flex items-center gap-2 px-3 py-2 bg-surface-1 border-b border-surface-3 flex-shrink-0 h-11">

      {/* Logo — real icon image, imported as module so it works in packaged asar */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <img
          src={iconUrl}
          alt="SenCode"
          className="w-7 h-7 rounded-lg object-cover flex-shrink-0"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
        <span className="text-sm font-semibold text-ink-high tracking-tight">SenCode</span>
      </div>

      <div className="w-px h-5 bg-surface-3 flex-shrink-0" />

      {/* Mode switcher */}
      <div className="flex items-center bg-surface-2 border border-surface-3 rounded-md p-0.5 flex-shrink-0"
        role="tablist" aria-label="App mode">
        <button role="tab" aria-selected={mode === 'programming'}
          onClick={() => onModeChange('programming')}
          title="Full IDE: file tree, editor, terminal, chat"
          className={`flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded transition-colors ${
            mode === 'programming' ? 'bg-primary-600 text-white' : 'text-ink-mid hover:text-ink-high'}`}>
          <Code2 size={12} /> Programming
        </button>
        <button role="tab" aria-selected={mode === 'chat'}
          onClick={() => onModeChange('chat')}
          title="Casual conversation"
          className={`flex items-center gap-1.5 px-2.5 py-1 text-2xs font-medium rounded transition-colors ${
            mode === 'chat' ? 'bg-primary-600 text-white' : 'text-ink-mid hover:text-ink-high'}`}>
          <MessageCircle size={12} /> Chat
        </button>
      </div>

      <div className="w-px h-5 bg-surface-3 flex-shrink-0" />

      {/* New Project button */}
      <button
        onClick={onNewProject}
        title="Create New Project"
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-2xs font-medium text-ink-mid hover:text-ink-high bg-surface-2 border border-surface-3 rounded-md hover:border-primary-500/40 transition-colors flex-shrink-0">
        <FolderPlus size={13} /> New Project
      </button>

      {/* Combined Open button */}
      <div ref={dropRef} className="relative flex-shrink-0">
        <div className="flex items-stretch bg-surface-2 border border-surface-3 rounded-md overflow-hidden">
          <button
            onClick={() => { onOpenFolder(); setOpenDropdown(false); }}
            title={folderName ? `Project: ${projectPath}` : 'Open Folder (Ctrl+Shift+O)'}
            className="flex items-center gap-1.5 px-2.5 py-1 text-2xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors"
          >
            <FolderOpen size={13} />
            <span>{folderName ?? 'Open'}</span>
          </button>
          <button
            onClick={() => setOpenDropdown(v => !v)}
            className="px-1.5 border-l border-surface-3 text-ink-low hover:text-ink-high hover:bg-surface-3 transition-colors"
            title="More open options"
          >
            <ChevronDown size={11} />
          </button>
        </div>

        {openDropdown && (
          <div className="absolute top-full left-0 mt-1 w-44 bg-surface-2 border border-surface-3 rounded-lg shadow-xl z-50 py-1 animate-fade-in">
            <button
              onClick={() => { onOpenFolder(); setOpenDropdown(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors text-left"
            >
              <FolderOpen size={13} /> Open Folder
              <span className="ml-auto text-2xs text-ink-low">Ctrl+Shift+O</span>
            </button>
            <button
              onClick={() => { onOpenFile(); setOpenDropdown(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink-mid hover:text-ink-high hover:bg-surface-3 transition-colors text-left"
            >
              <FileCode2 size={13} /> Open File(s)
              <span className="ml-auto text-2xs text-ink-low">Ctrl+O</span>
            </button>
            {folderName && (
              <>
                <div className="my-1 border-t border-surface-3" />
                <button onClick={() => { onCloseFolder(); setOpenDropdown(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-error-400 hover:bg-error-600/10 transition-colors text-left">
                  <FolderX size={13} /> Close Folder
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Close Folder shortcut button (only when folder is open) */}
      {folderName && (
        <button
          onClick={onCloseFolder}
          title={`Close folder: ${projectPath}`}
          className="flex items-center gap-1 px-2 py-1.5 text-2xs text-ink-low hover:text-error-400 hover:bg-error-600/10 border border-surface-3 hover:border-error-600/30 rounded-md transition-colors flex-shrink-0">
          <FolderX size={12} />
        </button>
      )}

      <div className="flex-1" />

      <ModelSelector
        models={models} activeModel={activeModel} connected={connected}
        hardwareInfo={hardwareInfo ?? null}
        onSelect={onModelSelect} onRefresh={onRefreshModels}
        onOpenRuntimes={onOpenRuntimeLibrary}
      />

      <div className="flex items-center flex-shrink-0">
        {connected
          ? <span className="w-2 h-2 rounded-full bg-success-500 animate-pulse-soft" />
          : <span className="w-2 h-2 rounded-full bg-warning-500" />}
      </div>

      {/* License & Device button */}
      <button
        onClick={onOpenLicense}
        title={showGraceAlert ? `License & Device — grace period: ${graceDaysLeft}d left` : 'License & Device'}
        className="relative p-1.5 text-ink-mid hover:text-ink-high hover:bg-surface-2 rounded-md transition-colors flex-shrink-0"
      >
        <Shield size={16} />
        {showGraceAlert && (
          <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-warning-400" />
        )}
      </button>

      {/* Preferences */}
      <button
        onClick={onOpenSettings}
        title="Preferences (Ctrl+,)"
        className="p-1.5 text-ink-mid hover:text-ink-high hover:bg-surface-2 rounded-md transition-colors flex-shrink-0"
      >
        <SlidersHorizontal size={16} />
      </button>
    </header>
  );
}
