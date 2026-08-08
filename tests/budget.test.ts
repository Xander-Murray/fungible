import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import { budgetStatus, getMonthlyBudgetStatus } from '../core/budget.js';

const limits: Array<[string, number]> = [
  ['Food & Drink', 180],
  ['Shopping', 125],
  ['Entertainment', 100],
  ['Groceries', 150],
  ['Transportation Energy', 175],
  ['Miscellaneous', 75],
];

let txId = 0;

async function insertTransaction(options: {
  amount: number;
  category: string;
  classification: string;
  date?: string;
  pending?: number;
  ignored?: number;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions
          (id, account_id, date, name, amount, category, classification, pending, ignored)
          VALUES (?, 'account', ?, 'Budget transaction', ?, ?, ?, ?, ?)`,
    args: [
      `budget-${txId}`,
      options.date ?? '2026-08-15',
      options.amount,
      options.category,
      options.classification,
      options.pending ?? 0,
      options.ignored ?? 0,
    ],
  });
}

beforeEach(async () => {
  txId = 0;
  await db.execute('DELETE FROM transactions');
  await db.execute('DELETE FROM categories');
  await db.batch([
    ...limits.map(([name, limit]) => ({
      sql: 'INSERT INTO categories (name, monthly_limit) VALUES (?, ?)',
      args: [name, limit],
    })),
    { sql: "INSERT INTO categories (name, budget_group) VALUES ('Dining', 'Food & Drink')", args: [] },
    { sql: "INSERT INTO categories (name, budget_group) VALUES ('Grocery', 'Groceries')", args: [] },
    { sql: "INSERT INTO categories (name, budget_group) VALUES ('Gas', 'Transportation Energy')", args: [] },
    { sql: "INSERT INTO categories (name, budget_group) VALUES ('EV Charging', 'Transportation Energy')", args: [] },
    { sql: "INSERT INTO categories (name, budget_group) VALUES ('Misc', 'Miscellaneous')", args: [] },
  ], 'write');
});

describe('getMonthlyBudgetStatus', () => {
  it('returns the initial $805 target and aggregates historical category aliases', async () => {
    await insertTransaction({ amount: 45, category: 'Dining', classification: 'EXPENSE' });
    await insertTransaction({ amount: 60, category: 'Food & Drink', classification: 'EXPENSE' });
    await insertTransaction({ amount: 80, category: 'Grocery', classification: 'EXPENSE' });

    const result = await getMonthlyBudgetStatus(2026, 8);

    expect(result.limit).toBe(805);
    expect(result.spent).toBe(185);
    expect(result.categories.find((row) => row.category === 'Food & Drink')?.spent).toBe(105);
    expect(result.categories.find((row) => row.category === 'Groceries')?.spent).toBe(80);
  });

  it('combines Gas and EV Charging under one Transportation Energy limit', async () => {
    await insertTransaction({ amount: 65, category: 'Gas', classification: 'EXPENSE' });
    await insertTransaction({ amount: 40, category: 'EV Charging', classification: 'EXPENSE' });

    const energy = (await getMonthlyBudgetStatus(2026, 8)).categories
      .find((row) => row.category === 'Transportation Energy');
    expect(energy).toMatchObject({ spent: 105, limit: 175, remaining: 70, status: 'GOOD' });
  });

  it('excludes non-spending classifications, pending, ignored, and other months', async () => {
    await insertTransaction({ amount: 25, category: 'Shopping', classification: 'EXPENSE' });
    for (const classification of ['TRANSFER', 'SAVINGS', 'INVESTMENT', 'INCOME', 'NEEDS_REVIEW']) {
      await insertTransaction({ amount: 100, category: 'Shopping', classification });
    }
    await insertTransaction({ amount: 100, category: 'Shopping', classification: 'EXPENSE', pending: 1 });
    await insertTransaction({ amount: 100, category: 'Shopping', classification: 'EXPENSE', ignored: 1 });
    await insertTransaction({ amount: 100, category: 'Shopping', classification: 'EXPENSE', date: '2026-07-31' });

    const shopping = (await getMonthlyBudgetStatus(2026, 8)).categories
      .find((row) => row.category === 'Shopping');
    expect(shopping?.spent).toBe(25);
  });

  it('applies refunds and reimbursements in-category and floors net spending at zero', async () => {
    await insertTransaction({ amount: 100, category: 'Entertainment', classification: 'EXPENSE' });
    await insertTransaction({ amount: -30, category: 'Entertainment', classification: 'REFUND' });
    await insertTransaction({ amount: -20, category: 'Entertainment', classification: 'REIMBURSEMENT' });
    await insertTransaction({ amount: -100, category: 'Shopping', classification: 'REFUND' });

    const result = await getMonthlyBudgetStatus(2026, 8);
    expect(result.categories.find((row) => row.category === 'Entertainment')?.spent).toBe(50);
    expect(result.categories.find((row) => row.category === 'Shopping')).toMatchObject({
      spent: 0,
      remaining: 125,
    });
  });

  it('reports warning and over-budget amounts without clamping remaining', async () => {
    await insertTransaction({ amount: 100, category: 'Shopping', classification: 'EXPENSE' });
    await insertTransaction({ amount: 80, category: 'Entertainment', classification: 'EXPENSE' });
    await insertTransaction({ amount: 10, category: 'Entertainment', classification: 'EXPENSE' });
    await insertTransaction({ amount: 30, category: 'Shopping', classification: 'EXPENSE' });

    const result = await getMonthlyBudgetStatus(2026, 8);
    expect(result.categories.find((row) => row.category === 'Entertainment')?.status).toBe('WARNING');
    expect(result.categories.find((row) => row.category === 'Shopping')).toMatchObject({
      status: 'OVER_BUDGET',
      remaining: -5,
      percentage: 104,
    });
  });

  it('rejects invalid month input', async () => {
    await expect(getMonthlyBudgetStatus(2026, 13)).rejects.toThrow(/valid year and month/);
  });
});

describe('budgetStatus', () => {
  it('uses the approved 80% and over-100% boundaries', () => {
    expect(budgetStatus(79.99, 100)).toBe('GOOD');
    expect(budgetStatus(80, 100)).toBe('WARNING');
    expect(budgetStatus(100, 100)).toBe('WARNING');
    expect(budgetStatus(100.01, 100)).toBe('OVER_BUDGET');
  });
});
