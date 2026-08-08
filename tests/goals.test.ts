import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/db.js', async () => {
  const { makeTestDb } = await import('./helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { db } from '../core/db.js';
import {
  EV_CHARGING_TARGET_KEY,
  getBudgetDashboardStatus,
  getFixedObligations,
  getSavingsGoalsStatus,
  getVerifiedIncome,
  ROTH_WEEKLY_TARGET_KEY,
  SAVINGS_WEEKLY_TARGET_KEY,
  setBudgetAmount,
  TESLA_INSURANCE_TARGET_KEY,
  TESLA_PAYMENT_TARGET_KEY,
} from '../core/budget.js';

const referenceDate = new Date(2026, 7, 19, 12);
let txId = 0;

async function transaction(options: {
  date: string;
  amount: number;
  classification: string;
  accountId?: string;
  name?: string;
  category?: string;
  pending?: number;
  ignored?: number;
}) {
  txId++;
  await db.execute({
    sql: `INSERT INTO transactions
          (id, account_id, date, name, amount, category, classification, pending, ignored)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      `goal-${txId}`, options.accountId ?? 'checking', options.date,
      options.name ?? 'Contribution', options.amount, options.category ?? 'Transfer',
      options.classification, options.pending ?? 0, options.ignored ?? 0,
    ],
  });
}

beforeEach(async () => {
  txId = 0;
  for (const table of ['transactions', 'accounts', 'categories', 'settings']) await db.execute(`DELETE FROM ${table}`);
  await db.batch([
    { sql: "INSERT INTO accounts (id, name, type, subtype) VALUES ('checking', 'Checking', 'depository', 'checking')", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, subtype) VALUES ('savings', 'High Yield Savings', 'depository', 'savings')", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, subtype) VALUES ('roth', 'Fidelity Roth IRA', 'investment', 'roth')", args: [] },
    { sql: "INSERT INTO accounts (id, name, type, subtype) VALUES ('brokerage', 'Fidelity Brokerage', 'investment', 'brokerage')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility, monthly_limit) VALUES ('Shopping', 'discretionary', 125)", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Tesla Payment', 'fixed')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('Tesla Insurance', 'fixed')", args: [] },
    { sql: "INSERT INTO categories (name, flexibility) VALUES ('EV Charging', 'flexible')", args: [] },
  ], 'write');
});

describe('getSavingsGoalsStatus', () => {
  it('tracks every weekly Roth and savings contribution without double-counting linked transfer legs', async () => {
    for (const date of ['2026-08-01', '2026-08-05', '2026-08-12', '2026-08-19']) {
      await transaction({ date, amount: 50, classification: 'INVESTMENT', name: 'Roth IRA contribution' });
      await transaction({ date, amount: -50, classification: 'INVESTMENT', accountId: 'roth', name: 'Roth IRA contribution' });
      await transaction({ date, amount: 75, classification: 'SAVINGS', name: 'Transfer to savings' });
      await transaction({ date, amount: -75, classification: 'SAVINGS', accountId: 'savings', name: 'Transfer to savings' });
    }

    const result = await getSavingsGoalsStatus(referenceDate);
    expect(result.combinedMonthlyTarget).toBe(542);
    expect(result.goals.find((goal) => goal.key === 'roth')).toMatchObject({
      weeklyTarget: 50, monthlyTarget: 217, contributed: 200,
      expectedToDate: 200, completedWeeks: 4, missedWeeks: 0, status: 'ON_TRACK',
    });
    expect(result.goals.find((goal) => goal.key === 'savings')).toMatchObject({
      weeklyTarget: 75, monthlyTarget: 325, contributed: 300,
      expectedToDate: 300, completedWeeks: 4, missedWeeks: 0, status: 'ON_TRACK',
    });
  });

  it('stays off track when a monthly lump sum does not satisfy each week', async () => {
    await transaction({ date: '2026-08-01', amount: -200, classification: 'INVESTMENT', accountId: 'roth' });
    await transaction({ date: '2026-08-01', amount: -300, classification: 'SAVINGS', accountId: 'savings' });

    const result = await getSavingsGoalsStatus(referenceDate);
    expect(result.goals.find((goal) => goal.key === 'roth')).toMatchObject({
      contributed: 200, completedWeeks: 1, missedWeeks: 3, status: 'OFF_TRACK',
    });
    expect(result.goals.find((goal) => goal.key === 'savings')).toMatchObject({
      contributed: 300, completedWeeks: 1, missedWeeks: 3, status: 'OFF_TRACK',
    });
  });

  it('counts manual one-sided goal transfers but excludes ordinary brokerage transfers', async () => {
    await transaction({ date: '2026-08-05', amount: 50, classification: 'INVESTMENT', category: 'Roth IRA' });
    await transaction({ date: '2026-08-05', amount: 500, classification: 'INVESTMENT', accountId: 'brokerage', name: 'Brokerage transfer' });
    await transaction({ date: '2026-08-05', amount: 75, classification: 'SAVINGS' });

    const result = await getSavingsGoalsStatus(new Date(2026, 7, 5, 12));
    expect(result.goals.find((goal) => goal.key === 'roth')?.contributed).toBe(50);
    expect(result.goals.find((goal) => goal.key === 'savings')?.contributed).toBe(75);
  });

  it('uses configurable weekly goals and fixed-obligation targets', async () => {
    await setBudgetAmount(ROTH_WEEKLY_TARGET_KEY, 25);
    await setBudgetAmount(SAVINGS_WEEKLY_TARGET_KEY, 100);
    await setBudgetAmount(TESLA_PAYMENT_TARGET_KEY, 500);
    await setBudgetAmount(TESLA_INSURANCE_TARGET_KEY, 175);
    await setBudgetAmount(EV_CHARGING_TARGET_KEY, 80);

    const goals = await getSavingsGoalsStatus(new Date(2026, 7, 5, 12));
    expect(goals.goals.find((goal) => goal.key === 'roth')).toMatchObject({ weeklyTarget: 25, monthlyTarget: 108 });
    expect(goals.goals.find((goal) => goal.key === 'savings')).toMatchObject({ weeklyTarget: 100, monthlyTarget: 433 });
    expect(await getFixedObligations(2026, 8)).toEqual([
      { key: 'tesla-payment', label: 'Tesla payment', target: 500, spent: 0 },
      { key: 'tesla-insurance', label: 'Tesla insurance', target: 175, spent: 0 },
      { key: 'ev-charging', label: 'EV charging', target: 80, spent: 0 },
    ]);
  });
});

describe('budget dashboard supporting totals', () => {
  it('counts only verified income and tracks fixed obligation actuals separately', async () => {
    await transaction({ date: '2026-08-01', amount: -2_000, classification: 'INCOME', name: 'H-E-B payroll' });
    await transaction({ date: '2026-08-02', amount: -500, classification: 'NEEDS_REVIEW', name: 'Zelle' });
    await transaction({ date: '2026-08-03', amount: 466, classification: 'TRANSFER', category: 'Tesla Payment' });
    await transaction({ date: '2026-08-04', amount: 40, classification: 'EXPENSE', category: 'EV Charging' });
    await transaction({ date: '2026-08-05', amount: -10, classification: 'REFUND', category: 'EV Charging' });

    expect(await getVerifiedIncome(2026, 8)).toBe(2_000);
    expect(await getFixedObligations(2026, 8)).toEqual([
      { key: 'tesla-payment', label: 'Tesla payment', target: 466, spent: 466 },
      { key: 'tesla-insurance', label: 'Tesla insurance', target: null, spent: 0 },
      { key: 'ev-charging', label: 'EV charging', target: null, spent: 30 },
    ]);
  });

  it('returns every dashboard section through one integrated query surface', async () => {
    const result = await getBudgetDashboardStatus(new Date(2026, 7, 5, 12));
    expect(result).toEqual(expect.objectContaining({
      weekly: expect.any(Object), monthly: expect.any(Object), goals: expect.any(Object),
      verifiedIncome: 0, fixedObligations: expect.any(Array),
    }));
  });
});
