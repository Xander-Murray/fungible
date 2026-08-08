import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  getWeeklySpendingStatus,
  setWeeklyChaseLimit,
  weeklyBudgetStatus,
} from '../core/budget.js';

const referenceDate = new Date(2026, 7, 5, 12); // Wednesday, August 5
let txId = 0;

async function insertTransaction(options: {
  amount: number;
  category?: string;
  classification?: string;
  manualClassification?: string | null;
  accountId?: string;
  date?: string;
  pending?: number;
  ignored?: number;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions
          (id, account_id, date, name, amount, category, classification,
           manual_classification, pending, ignored)
          VALUES (?, ?, ?, 'Weekly transaction', ?, ?, ?, ?, ?, ?)`,
    args: [
      `weekly-${txId}`,
      options.accountId ?? 'chase-credit',
      options.date ?? '2026-08-05',
      options.amount,
      options.category ?? 'Shopping',
      options.classification ?? 'EXPENSE',
      options.manualClassification ?? null,
      options.pending ?? 0,
      options.ignored ?? 0,
    ],
  });
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM accounts');
  await db.execute('DELETE FROM categories');
  await db.execute('DELETE FROM settings');
  await db.batch([
    { sql: "INSERT INTO accounts (id, name, type, institution_name) VALUES ('chase-credit', 'Freedom Unlimited', 'credit', 'Chase')", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, institution_name) VALUES ('chase-name', 'Chase Sapphire', 'credit', NULL)", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, institution_name) VALUES ('other-credit', 'Blue Cash', 'credit', 'American Express')", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, institution_name) VALUES ('chase-checking', 'Chase Total Checking', 'depository', 'Chase')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Shopping', 'discretionary')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Groceries', 'flexible')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Entertainment', 'discretionary')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Insurance', 'fixed')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Uncategorized', NULL)", args: [] },
  ], 'write');
});

describe('weeklyBudgetStatus', () => {
  it('uses the approved $130, $160, and $185 boundaries', () => {
    expect(weeklyBudgetStatus(0)).toBe('GOOD');
    expect(weeklyBudgetStatus(130)).toBe('GOOD');
    expect(weeklyBudgetStatus(130.01)).toBe('WARNING');
    expect(weeklyBudgetStatus(160)).toBe('WARNING');
    expect(weeklyBudgetStatus(160.01)).toBe('ESSENTIALS_ONLY');
    expect(weeklyBudgetStatus(185)).toBe('ESSENTIALS_ONLY');
    expect(weeklyBudgetStatus(185.01)).toBe('OVER_BUDGET');
  });
});

describe('getWeeklySpendingStatus', () => {
  it('uses a local Monday-through-Sunday week and the default $185 limit', async () => {
    await insertTransaction({ amount: 50, date: '2026-08-03' });
    await insertTransaction({ amount: 80, date: '2026-08-09' });
    await insertTransaction({ amount: 100, date: '2026-08-02' });
    await insertTransaction({ amount: 100, date: '2026-08-10' });

    expect(await getWeeklySpendingStatus(referenceDate)).toEqual({
      from: '2026-08-03',
      to: '2026-08-09',
      spent: 130,
      limit: 185,
      remaining: 55,
      percentage: (130 / 185) * 100,
      status: 'GOOD',
    });
  });

  it('automatically resets each week without rolling unused money forward', async () => {
    await insertTransaction({ amount: 180, date: '2026-08-05' });
    await insertTransaction({ amount: 20, date: '2026-08-12' });

    const firstWeek = await getWeeklySpendingStatus(referenceDate);
    const nextWeek = await getWeeklySpendingStatus(new Date(2026, 7, 12, 12));
    expect(firstWeek).toMatchObject({ spent: 180, remaining: 5, status: 'ESSENTIALS_ONLY' });
    expect(nextWeek).toMatchObject({ spent: 20, limit: 185, remaining: 165, status: 'GOOD' });
  });

  it('excludes non-spending classifications, fixed costs, pending and ignored rows', async () => {
    await insertTransaction({ amount: 25 });
    for (const classification of ['TRANSFER', 'SAVINGS', 'INVESTMENT', 'INCOME', 'NEEDS_REVIEW']) {
      await insertTransaction({ amount: 100, classification });
    }
    await insertTransaction({ amount: 100, category: 'Insurance' });
    await insertTransaction({ amount: 100, pending: 1 });
    await insertTransaction({ amount: 100, ignored: 1 });

    expect(await getWeeklySpendingStatus(referenceDate)).toMatchObject({ spent: 25, remaining: 160 });
  });

  it('counts Chase credit cards only, using institution or account name', async () => {
    await insertTransaction({ amount: 30 });
    await insertTransaction({ amount: 20, accountId: 'chase-name' });
    await insertTransaction({ amount: 100, accountId: 'other-credit' });
    await insertTransaction({ amount: 100, accountId: 'chase-checking' });

    expect(await getWeeklySpendingStatus(referenceDate)).toMatchObject({ spent: 50, remaining: 135 });
  });

  it('nets refunds and reimbursements within their category without negative rollover', async () => {
    await insertTransaction({ amount: 100, category: 'Shopping' });
    await insertTransaction({ amount: -30, category: 'Shopping', classification: 'REFUND' });
    await insertTransaction({ amount: -20, category: 'Shopping', classification: 'REIMBURSEMENT' });
    await insertTransaction({ amount: 20, category: 'Groceries' });
    await insertTransaction({ amount: -100, category: 'Entertainment', classification: 'REFUND' });

    expect(await getWeeklySpendingStatus(referenceDate)).toMatchObject({ spent: 70, remaining: 115 });
  });

  it('honors manual classification overrides', async () => {
    await insertTransaction({ amount: 100, classification: 'EXPENSE', manualClassification: 'TRANSFER' });
    await insertTransaction({ amount: 35, classification: 'TRANSFER', manualClassification: 'EXPENSE' });

    expect(await getWeeklySpendingStatus(referenceDate)).toMatchObject({ spent: 35, remaining: 150 });
  });

  it('persists a customized weekly limit and rejects invalid limits', async () => {
    await setWeeklyChaseLimit(200);
    await insertTransaction({ amount: 50 });
    expect(await getWeeklySpendingStatus(referenceDate)).toMatchObject({ limit: 200, remaining: 150 });
    await expect(setWeeklyChaseLimit(-1)).rejects.toThrow(/non-negative/);
  });
});
