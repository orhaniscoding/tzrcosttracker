# User guide

[Turkish version](tr/USER-GUIDE.md)

TZR Cost Tracker helps a team record income, expenses, cash movements, and payments by project. Use synthetic records for your first run. Choose English or Turkish in the language selector. This preference is saved in the browser. The control names in this guide include the Turkish labels where useful. [Installation guide](INSTALL.md)

## First sign-in

1. Open the address from your installation guide. On a new installation, the first-run wizard asks for the setup key (`Kurulum anahtarı`), organization name, base currency, industry template, and administrator account. The setup key is the value your operator provided for `BOOTSTRAP_TOKEN`. Your account password is chosen separately.
2. Choose a starter template or a blank setup, name the initial project, and complete the administrator form. Review the generated project and categories before entering records.
3. Sign in with your username or email and password. A TOTP-enabled account also asks for an authenticator code or an unused recovery code. To enroll, open the two-factor dialog and store the recovery codes in a private location before finishing setup.

Use an individual account for each person. An administrator adds users under **Kullanıcılar & Yetkiler → Yeni Kullanıcı Tanımla** and grants project access from the project membership panel. Administrators manage configuration and users. Managers and accountants can make permitted financial changes within their assigned projects. Auditors and viewers can read in scope. An administrator is required for the audit and backup screens.

## Organize a project

1. Use the top project selector to open a specific project. Administrators can also create a project there. The consolidated option combines the projects visible to the account. Select a project before entering or comparing its figures.
2. Under **Kategori & Kalemler**, review the category tree, then add a category or subcategory if your role permits it. Create a leaf subcategory for records that need a specific cost item.
3. Open **Kasa & Finansman → Likidite & Cüzdanlar Hub'ı** to create a cash or bank account. Choose the correct project, currency, and opening balance. A cash contribution recorded under **Kasa & Nakit Girişleri** is a separate movement and adds to the balance. Enter each opening amount once.

## Record and review a payment

For a synthetic walkthrough, select a project with a cash account whose opening balance is `1,000 TRY`, and choose an eligible category. Open **Maliyet & Harcamalar → Yeni Harcama Ekle**, enter a `125.25 TRY` expense, select the company cash account and matching currency, mark it paid, and save. The expected account balance is `874.75 TRY` if no other movement occurred. Find the entry in **Harcama Tablosu** and compare the result with **Kasa & Finansman → Bilanço & Vade Radarı**.

- Choose a company account when the organization pays. Keep a due expense unpaid until payment occurs and use the payment action for an eligible record.
- Choose **Oto-Kasa (Ortak Kendi Cebinden)** when an individual pays a business expense. Enter the payer's name. The linked contribution is available in **Şahıs / Ortak Bilançosu**. Review both sides of the entry before recording any separate reimbursement.
- Use the wallet transfer action to move existing funds between eligible accounts. Use the cash-entry screen for an actual contribution. An account may become immutable in currency or opening balance after records reference it.
- Use **Çöp Kutusu & Geri Alma** to review deleted entries and restore an eligible record. A deletion or restore can affect balances and linked entries. Compare the financial result after either operation.

## Reports, import, and export

Open **Raporlar & Analiz** for charts, a date range report, daily cash balances, or the 12-month report. Confirm the active project and period and compare like currencies. Opening balances, payments, outstanding expenses, and contributions are separate pieces of the reconciliation. Download a CSV for the permitted scope and store it as financial data.

For any supported workbook import, preview the sheet and column mapping with a small synthetic file. Confirm the date, decimal separator, currency, sign, category, and target project for a known row. Review the reported successes and errors and reconcile the imported totals before continuing. Ask an administrator to run imports. Batch inputs can have their own row or file limits.

Administrators can verify the audit chain under **Denetim & Güvenlik → Mühür Doğrulama (SHA-256)** and export a V2 `.tzrvault` from **Şifreli Yedek (.tzrvault)**. Recovery is performed by an operator with the API stopped. [Operations guide](OPERATIONS.md)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| First-run setup rejects the key | Use the exact bootstrap key from the operator for this installation. Check the web origin and ask the operator whether the administrator already exists. |
| A project or menu is missing | Check the signed-in account, role, assigned project membership, and selected project. Ask an administrator to confirm access. |
| An account is missing when entering a payment | Check the account's project, active status, currency, and the payment source selected in the form. |
| A balance does not match | Confirm the project and report dates, currency, opening balance, whether the transaction is paid, and any linked Oto-Kasa or transfer entries. |
| A request timed out during save | Refresh the transaction list and check the audit or the account effect before submitting again. An API client that sent an `Idempotency-Key` can retry the same body with that same key. |
| Sign-in fails after restore, or the screen is locked | Sign in again after restore. Use the current user's valid credentials or configured PIN to unlock the screen. Ask an administrator about a revoked session or lost recovery codes. |
| V2 export rejects the current data | Verify the passphrase meets the byte limit. Ask the operator to check for unsupported attachments or incompatible relationships before relying on the backup. |
