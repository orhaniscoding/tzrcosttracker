import React, { createContext, useContext, useEffect, useState } from 'react';
import { ApiClient } from '../api/client.js';
import type { WhiteLabelConfig } from '@cost-core/types';

interface ThemeContextType {
  settings: WhiteLabelConfig;
  refreshSettings: () => Promise<void>;
  updateSettings: (newSettings: Partial<WhiteLabelConfig>) => Promise<void>;
}

const defaultSettings: WhiteLabelConfig = {
  companyName: 'TZRCoster Finance',
  appTitle: 'TZRCoster Maliyet & Finans',
  primaryColor: '#2563EB',
  secondaryColor: '#1E40AF',
  defaultTheme: 'dark',
  baseCurrency: 'TRY',
  dateFormat: 'DD.MM.YYYY',
};

const ThemeContext = createContext<ThemeContextType>({
  settings: defaultSettings,
  refreshSettings: async () => {},
  updateSettings: async () => {},
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<WhiteLabelConfig>(defaultSettings);

  const applyStyles = (cfg: WhiteLabelConfig) => {
    if (typeof document === 'undefined') return;

    document.documentElement.style.setProperty('--primary-color', cfg.primaryColor || '#2563EB');
    document.documentElement.style.setProperty('--secondary-color', cfg.secondaryColor || '#1E40AF');

    if (cfg.backgroundUrl) {
      document.body.style.backgroundImage = `url("${cfg.backgroundUrl}")`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundAttachment = 'fixed';
    } else {
      document.body.style.backgroundImage = 'none';
    }

    if (cfg.defaultTheme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  };

  const refreshSettings = async () => {
    try {
      const data = await ApiClient.getWhiteLabel();
      setSettings(data);
      applyStyles(data);
    } catch (e) {
      // Offline or network error
    }
  };

  const updateSettings = async (newSettings: Partial<WhiteLabelConfig>) => {
    const updated = await ApiClient.updateWhiteLabel(newSettings);
    setSettings(updated);
    applyStyles(updated);
  };

  useEffect(() => {
    refreshSettings();
  }, []);

  return (
    <ThemeContext.Provider value={{ settings, refreshSettings, updateSettings }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
