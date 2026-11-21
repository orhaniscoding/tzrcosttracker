export function formatCurrency(locale: string, currency: string, amount: number, maximumFractionDigits?: number): string {
  if (/^[A-Za-z]{3}$/.test(currency)) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits }).format(amount);
  }
  // Keep historical currency labels visible so an operator can identify the
  // affected records. Do not display an invalid code as a different currency.
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: maximumFractionDigits ?? 2 }).format(amount)} ${currency}`;
}
