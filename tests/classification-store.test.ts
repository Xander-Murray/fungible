import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { reclassifyAllTransactions } from '../core/classification-store.js';

beforeEach(async () => {
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM accounts');
  await db.batch([
    { sql: "INSERT INTO accounts (id, name, type, subtype) VALUES ('checking', 'Checking', 'depository', 'checking')", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, subtype) VALUES ('card', 'Credit Card', 'credit', 'credit card')", args: [] },
  ], 'write');
});

describe('reclassifyAllTransactions', () => {
  it('updates stale automatic classifications while preserving manual overrides', async () => {
    await db.batch([
      { sql: "INSERT INTO transactions (id, account_id, date, name, amount, category, raw_category, raw_category_detail, classification) VALUES ('payroll', 'checking', '2026-08-01', 'KBR 1791', -500, 'Income', 'INCOME', 'INCOME_WAGES', 'NEEDS_REVIEW')", args: [] },
      { sql: "INSERT INTO transactions (id, account_id, date, name, amount, category, raw_category, raw_category_detail, classification) VALUES ('payment', 'card', '2026-08-02', 'Payment Thank You-Mobile', -400, 'Uncategorized', 'LOAN_DISBURSEMENTS', 'LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT', 'NEEDS_REVIEW')", args: [] },
      { sql: "INSERT INTO transactions (id, account_id, date, name, amount, category, raw_category, classification) VALUES ('cash-app', 'checking', '2026-08-03', 'Cash App', -100, 'Transfer', 'TRANSFER_IN', 'TRANSFER')", args: [] },
      { sql: "INSERT INTO transactions (id, account_id, date, name, amount, category, classification, manual_classification) VALUES ('manual', 'checking', '2026-08-04', 'Deposit', -25, 'Uncategorized', 'REFUND', 'REFUND')", args: [] },
    ], 'write');

    await reclassifyAllTransactions();

    const rows = await db.execute('SELECT id, classification, manual_classification FROM transactions ORDER BY id');
    expect(rows.rows).toMatchObject([
      { id: 'cash-app', classification: 'NEEDS_REVIEW', manual_classification: null },
      { id: 'manual', classification: 'REFUND', manual_classification: 'REFUND' },
      { id: 'payment', classification: 'TRANSFER', manual_classification: null },
      { id: 'payroll', classification: 'INCOME', manual_classification: null },
    ]);
  });
});
