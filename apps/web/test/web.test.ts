import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DashboardStats } from '../src/components/DashboardStats.js';
import { Header } from '../src/components/Header.js';
import { ThemeProvider } from '../src/context/ThemeContext.js';
import { BackupCenterView } from '../src/components/BackupCenterView.js';

describe('@cost-core/web - UI Components Server-Side Render Tests', () => {
  it('should render DashboardStats without errors', () => {
    const summary = {
      totalExpense: 125000,
      totalIncome: 300000,
      netBalance: 175000,
      transactionCount: 14,
      categoryBreakdown: [{ name: 'Kaba Yapı', amount: 125000 }],
    };

    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(DashboardStats, { summary })
      )
    );

    expect(html).toContain('Toplam Maliyet &amp; Gider');
    expect(html).toContain('Net Kasa &amp; Bakiye');
    expect(html).toContain('14');
    expect(html).toContain('Kalem');
  });

  it('should render Header with security verification badge', () => {
    const html = renderToString(
      React.createElement(
        ThemeProvider,
        null,
        React.createElement(Header, {
          onOpenSettings: () => {},
          onOpen2FA: () => {},
          onLogout: () => {},
          auditVerified: true,
          userName: 'Patron',
        })
      )
    );

    expect(html).toContain('Kriptografik Bütünlük: Mühürlü');
    expect(html).toContain('2FA Güvenlik');
    expect(html).toContain('Patron');
  });


  it('offers V2 export and accurately describes offline restore and operator-managed backups', () => {
    const html = renderToString(
      React.createElement(BackupCenterView)
    );

    expect(html).toContain('Tam Sistem Yedeği V2');
    expect(html).toContain('çevrimdışı');
    expect(html).not.toContain('Otomatik Yedek Aktif');
    expect(html).not.toContain('V1 Kısmi Geri Yükleme');
    expect(html).not.toContain('%100 KVKK/GDPR');
  });
});
