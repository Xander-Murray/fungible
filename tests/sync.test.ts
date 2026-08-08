import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

vi.mock('../core/plaid.js', () => ({
  getPlaidClient: vi.fn(),
  plaidErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { db } from '../core/db.js';
import { getPlaidClient } from '../core/plaid.js';
import { syncTransactions } from '../core/sync.js';

const mockPlaid = (removed: string[], added: object[] = [], accounts: object[] = [], modified: object[] = []) => {
  vi.mocked(getPlaidClient).mockReturnValue({
    transactionsSync: vi.fn().mockResolvedValue({
      data: {
        added,
        modified,
        removed: removed.map((id) => ({ transaction_id: id })),
        has_more: false,
        next_cursor: 'cursor-1',
      },
    }),
    accountsGet: vi.fn().mockResolvedValue({ data: { accounts } }),
  } as never);
};

beforeEach(async () => {
  for (const t of ['transaction_tags', 'tag_rule_suppressions', 'tag_rules', 'tags', 'transactions', 'accounts', 'sync_state', 'balance_history', 'plaid_items']) {
    await db.execute(`DELETE FROM ${t}`);
  }
});

async function insertTx(id: string) {
  await db.execute({ sql: `INSERT INTO transactions (id, account_id, date, name, amount, category, pending, ignored) VALUES (?, 'acct-1', '2025-01-01', 'Test', 10, 'Food', 0, 0)`, args: [id] });
}

async function insertTag(name: string): Promise<number> {
  await db.execute({ sql: 'INSERT INTO tags (name) VALUES (?)', args: [name] });
  const r = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [name] });
  return Number((r.rows[0] as unknown as { id: number }).id);
}

describe('syncTransactions — removing tagged transactions', () => {
  it('deletes transaction_tags before the transaction to avoid FK constraint failure', async () => {
    await insertTx('tx-1');
    const tagId = await insertTag('groceries');
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-1', tagId] });

    mockPlaid(['tx-1']);
    await expect(syncTransactions('token', 'item-1')).resolves.not.toThrow();

    const tags = await db.execute({ sql: 'SELECT * FROM transaction_tags WHERE transaction_id = ?', args: ['tx-1'] });
    const txs = await db.execute({ sql: 'SELECT * FROM transactions WHERE id = ?', args: ['tx-1'] });
    expect(tags.rows).toHaveLength(0);
    expect(txs.rows).toHaveLength(0);
  });

  it('also clears tag_rule_suppressions for removed transactions', async () => {
    await insertTx('tx-2');
    const tagId = await insertTag('travel');
    await db.execute({ sql: 'INSERT INTO tag_rule_suppressions (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-2', tagId] });

    mockPlaid(['tx-2']);
    await syncTransactions('token', 'item-1');

    const rows = await db.execute({ sql: 'SELECT * FROM tag_rule_suppressions WHERE transaction_id = ?', args: ['tx-2'] });
    expect(rows.rows).toHaveLength(0);
  });

  it('leaves unrelated transactions and tags intact', async () => {
    await insertTx('tx-keep');
    await insertTx('tx-remove');
    const tagId = await insertTag('dining');
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-keep', tagId] });
    await db.execute({ sql: 'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: ['tx-remove', tagId] });

    mockPlaid(['tx-remove']);
    await syncTransactions('token', 'item-1');

    const kept = await db.execute({ sql: 'SELECT * FROM transaction_tags WHERE transaction_id = ?', args: ['tx-keep'] });
    expect(kept.rows).toHaveLength(1);
  });
});

const account = (id: string, type: string, subtype: string) => ({
  account_id: id,
  name: id,
  type,
  subtype,
  mask: id.slice(-4),
  balances: { current: 0 },
});

const transaction = (overrides: Record<string, unknown>) => ({
  transaction_id: 'tx-new',
  account_id: 'checking',
  date: '2026-08-08',
  name: 'Purchase',
  merchant_name: null,
  amount: 10,
  pending: false,
  personal_finance_category: null,
  ...overrides,
});

describe('syncTransactions — classifications', () => {
  it('copies the linked institution onto synced accounts', async () => {
    await db.execute("INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES ('item-1', 'token', 'Chase')");
    mockPlaid([], [], [{ ...account('credit-card', 'credit', 'credit card'), name: 'CREDIT CARD' }]);

    await syncTransactions('token', 'item-1');

    const row = (await db.execute("SELECT institution_name, item_id FROM accounts WHERE id = 'credit-card'")).rows[0];
    expect(row).toMatchObject({ institution_name: 'Chase', item_id: 'item-1' });
  });

  it('stores Plaid detail and verifies only known payroll', async () => {
    mockPlaid([], [
      transaction({
        transaction_id: 'payroll',
        name: 'KBR PAYROLL',
        amount: -2_000,
        personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' },
      }),
      transaction({
        transaction_id: 'venmo',
        name: 'Venmo cashout',
        amount: -200,
        personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' },
      }),
    ], [account('checking', 'depository', 'checking')]);

    await syncTransactions('token', 'item-1');

    const rows = await db.execute('SELECT id, classification, raw_category_detail FROM transactions ORDER BY id');
    expect(rows.rows).toMatchObject([
      { id: 'payroll', classification: 'INCOME', raw_category_detail: 'INCOME_WAGES' },
      { id: 'venmo', classification: 'NEEDS_REVIEW', raw_category_detail: 'INCOME_OTHER_INCOME' },
    ]);
  });

  it.each([
    ['credit', 'credit card', 'TRANSFER'],
    ['depository', 'savings', 'SAVINGS'],
    ['investment', 'brokerage', 'INVESTMENT'],
  ])('reconciles checking transfers to %s accounts as %s', async (type, subtype, expected) => {
    mockPlaid([], [
      transaction({
        transaction_id: 'outgoing',
        account_id: 'checking',
        name: 'Online transfer',
        amount: 500,
        personal_finance_category: { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' },
      }),
      transaction({
        transaction_id: 'incoming',
        account_id: 'destination',
        date: '2026-08-09',
        name: 'Online transfer',
        amount: -500,
        personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER' },
      }),
    ], [account('checking', 'depository', 'checking'), account('destination', type, subtype)]);

    await syncTransactions('token', 'item-1');

    const rows = await db.execute('SELECT classification FROM transactions ORDER BY id');
    expect(rows.rows.map((row) => row.classification)).toEqual([expected, expected]);
  });

  it('preserves a manual classification when Plaid modifies a transaction', async () => {
    await db.execute({
      sql: `INSERT INTO accounts (id, name, type, subtype) VALUES ('checking', 'Checking', 'depository', 'checking')`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO transactions
            (id, account_id, date, name, amount, category, pending, ignored, classification, manual_classification)
            VALUES ('manual', 'checking', '2026-08-08', 'Deposit', -50, 'Uncategorized', 0, 0, 'REIMBURSEMENT', 'REIMBURSEMENT')`,
      args: [],
    });
    mockPlaid([], [], [account('checking', 'depository', 'checking')], [transaction({
      transaction_id: 'manual',
      name: 'Changed deposit',
      amount: -50,
    })]);

    await syncTransactions('token', 'item-1');

    const row = (await db.execute("SELECT classification, manual_classification FROM transactions WHERE id = 'manual'")).rows[0];
    expect(row).toMatchObject({ classification: 'REIMBURSEMENT', manual_classification: 'REIMBURSEMENT' });
  });
});
