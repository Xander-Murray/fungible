import { db } from './db.js';
import { getPeriodDates, getPeriodStart } from './dateUtils.js';

export type BudgetStatus = 'GOOD' | 'WARNING' | 'OVER_BUDGET';
export type WeeklyBudgetStatus = 'GOOD' | 'WARNING' | 'ESSENTIALS_ONLY' | 'OVER_BUDGET';

export const WEEKLY_CHASE_LIMIT_KEY = 'budget_weekly_chase_limit';
export const DEFAULT_WEEKLY_CHASE_LIMIT = 185;
export const ROTH_WEEKLY_TARGET_KEY = 'budget_roth_weekly_target';
export const SAVINGS_WEEKLY_TARGET_KEY = 'budget_savings_weekly_target';
export const TESLA_PAYMENT_TARGET_KEY = 'budget_tesla_payment_target';
export const TESLA_INSURANCE_TARGET_KEY = 'budget_tesla_insurance_target';
export const EV_CHARGING_TARGET_KEY = 'budget_ev_charging_target';

export type WeeklySpendingSummary = {
  from: string;
  to: string;
  spent: number;
  limit: number;
  remaining: number;
  percentage: number;
  status: WeeklyBudgetStatus;
};

export type MonthlyBudgetCategory = {
  category: string;
  spent: number;
  limit: number;
  remaining: number;
  percentage: number;
  status: BudgetStatus;
};

export type MonthlyBudgetStatus = {
  year: number;
  month: number;
  spent: number;
  limit: number;
  remaining: number;
  percentage: number;
  status: BudgetStatus;
  categories: MonthlyBudgetCategory[];
};

export type SavingsGoalProgress = {
  key: 'roth' | 'savings';
  label: string;
  weeklyTarget: number;
  monthlyTarget: number;
  contributed: number;
  expectedToDate: number;
  completedWeeks: number;
  missedWeeks: number;
  weeks: Array<{ from: string; to: string; contributed: number; complete: boolean }>;
  status: 'ON_TRACK' | 'OFF_TRACK';
};

export type SavingsGoalsStatus = {
  from: string;
  to: string;
  combinedMonthlyTarget: number;
  goals: SavingsGoalProgress[];
};

export type FixedObligation = {
  key: 'tesla-payment' | 'tesla-insurance' | 'ev-charging';
  label: string;
  target: number | null;
  spent: number;
};

export type BudgetDashboardStatus = {
  weekly: WeeklySpendingSummary;
  monthly: MonthlyBudgetStatus;
  goals: SavingsGoalsStatus;
  verifiedIncome: number;
  fixedObligations: FixedObligation[];
};

const money = (value: number): number => Math.round(value * 100) / 100;

function requireNonNegativeAmount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative amount`);
}

export function budgetStatus(spent: number, limit: number): BudgetStatus {
  if (spent > limit) return 'OVER_BUDGET';
  if (limit === 0) return spent === 0 ? 'GOOD' : 'OVER_BUDGET';
  return spent / limit >= 0.8 ? 'WARNING' : 'GOOD';
}

function percentage(spent: number, limit: number): number {
  if (limit === 0) return spent === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (spent / limit) * 100;
}

export function weeklyBudgetStatus(
  spent: number,
  limit = DEFAULT_WEEKLY_CHASE_LIMIT,
): WeeklyBudgetStatus {
  requireNonNegativeAmount(spent, 'Weekly spending');
  requireNonNegativeAmount(limit, 'Weekly limit');
  if (limit === 0) return spent === 0 ? 'GOOD' : 'OVER_BUDGET';

  // Scale the warning bands if the configured limit changes while preserving
  // the requested $130 / $160 / $185 boundaries at the default limit.
  const scale = limit / DEFAULT_WEEKLY_CHASE_LIMIT;
  if (spent > limit) return 'OVER_BUDGET';
  if (spent > 160 * scale) return 'ESSENTIALS_ONLY';
  if (spent > 130 * scale) return 'WARNING';
  return 'GOOD';
}

export async function getWeeklyChaseLimit(): Promise<number> {
  const result = await db.execute({
    sql: 'SELECT value FROM settings WHERE key = ?',
    args: [WEEKLY_CHASE_LIMIT_KEY],
  });
  if (result.rows.length === 0) return DEFAULT_WEEKLY_CHASE_LIMIT;
  const limit = Number((result.rows[0] as unknown as { value: string }).value);
  requireNonNegativeAmount(limit, 'Weekly Chase limit');
  return money(limit);
}

export async function setWeeklyChaseLimit(limit: number): Promise<void> {
  requireNonNegativeAmount(limit, 'Weekly Chase limit');
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [WEEKLY_CHASE_LIMIT_KEY, String(money(limit))],
  });
}

async function getConfiguredAmount(key: string, fallback: number | null): Promise<number | null> {
  const result = await db.execute({ sql: 'SELECT value FROM settings WHERE key = ?', args: [key] });
  if (result.rows.length === 0) return fallback;
  const amount = Number((result.rows[0] as unknown as { value: string }).value);
  requireNonNegativeAmount(amount, 'Budget setting');
  return money(amount);
}

export async function setBudgetAmount(key: string, amount: number | null): Promise<void> {
  const allowed = new Set([
    WEEKLY_CHASE_LIMIT_KEY, ROTH_WEEKLY_TARGET_KEY, SAVINGS_WEEKLY_TARGET_KEY,
    TESLA_PAYMENT_TARGET_KEY, TESLA_INSURANCE_TARGET_KEY, EV_CHARGING_TARGET_KEY,
  ]);
  if (!allowed.has(key)) throw new Error(`Unknown budget setting: ${key}`);
  if (amount === null) {
    await db.execute({ sql: 'DELETE FROM settings WHERE key = ?', args: [key] });
    return;
  }
  requireNonNegativeAmount(amount, 'Budget setting');
  await db.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, String(money(amount))],
  });
}

export async function getWeeklySpendingStatus(referenceDate = new Date()): Promise<WeeklySpendingSummary> {
  if (Number.isNaN(referenceDate.getTime())) throw new Error('Weekly budget requires a valid reference date');
  const weekStart = getPeriodStart('week', referenceDate);
  const { from, to } = getPeriodDates('week', weekStart);
  const [limit, result] = await Promise.all([
    getWeeklyChaseLimit(),
    db.execute({
      sql: `SELECT t.category, COALESCE(SUM(t.amount), 0) AS net_spent
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            LEFT JOIN plaid_items pi ON pi.item_id = a.item_id
            LEFT JOIN categories c ON c.name = t.category
            WHERE t.date >= ? AND t.date <= ?
              AND t.pending = 0 AND t.ignored = 0
              AND COALESCE(t.manual_classification, t.classification)
                IN ('EXPENSE', 'REFUND', 'REIMBURSEMENT')
              AND LOWER(a.type) = 'credit'
              AND (
                LOWER(COALESCE(a.institution_name, '')) LIKE '%chase%'
                OR LOWER(COALESCE(pi.institution_name, '')) LIKE '%chase%'
                OR LOWER(a.name) LIKE '%chase%'
              )
              AND COALESCE(c.flexibility, '') <> 'fixed'
            GROUP BY t.category`,
      args: [from, to],
    }),
  ]);
  const spent = money((result.rows as unknown as { net_spent: number }[])
    .reduce((sum, row) => sum + Math.max(0, Number(row.net_spent)), 0));
  return {
    from,
    to,
    spent,
    limit,
    remaining: money(limit - spent),
    percentage: percentage(spent, limit),
    status: weeklyBudgetStatus(spent, limit),
  };
}

async function getFlexibleCategorySpending(from: string, to: string): Promise<Array<{
  category: string;
  limit: number;
  spent: number;
}>> {
  const result = await db.execute({
    sql: `SELECT budget.name AS category, budget.monthly_limit AS monthly_limit,
            COALESCE(SUM(CASE
              WHEN COALESCE(t.manual_classification, t.classification) IN ('EXPENSE', 'REFUND', 'REIMBURSEMENT') THEN t.amount
              ELSE 0
            END), 0) AS net_spent
          FROM categories budget
          LEFT JOIN categories member
            ON COALESCE(member.budget_group, member.name) = budget.name
          LEFT JOIN transactions t
            ON t.category = member.name
            AND t.date >= ? AND t.date <= ?
            AND t.pending = 0 AND t.ignored = 0
          WHERE budget.monthly_limit IS NOT NULL AND budget.budget_group IS NULL
          GROUP BY budget.name, budget.monthly_limit
          ORDER BY budget.name`,
    args: [from, to],
  });
  return (result.rows as unknown as {
    category: string; monthly_limit: number; net_spent: number;
  }[]).map((row) => ({
    category: row.category,
    limit: money(Number(row.monthly_limit)),
    spent: money(Math.max(0, Number(row.net_spent))),
  }));
}

export async function getMonthlyBudgetStatus(year: number, month: number): Promise<MonthlyBudgetStatus> {
  if (!Number.isInteger(year) || year < 1 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Budget month must use a valid year and month');
  }
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-31`;
  const categories = (await getFlexibleCategorySpending(from, to)).map((row): MonthlyBudgetCategory => {
    const { limit, spent } = row;
    return {
      category: row.category,
      spent,
      limit,
      remaining: money(limit - spent),
      percentage: percentage(spent, limit),
      status: budgetStatus(spent, limit),
    };
  });
  const limit = money(categories.reduce((sum, row) => sum + row.limit, 0));
  const spent = money(categories.reduce((sum, row) => sum + row.spent, 0));
  return {
    year,
    month,
    spent,
    limit,
    remaining: money(limit - spent),
    percentage: percentage(spent, limit),
    status: budgetStatus(spent, limit),
    categories,
  };
}

type GoalTransaction = {
  id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  category: string | null;
  classification: string;
  account_name: string;
  account_nickname: string | null;
  account_type: string;
  account_subtype: string | null;
};

function goalKey(row: GoalTransaction): 'roth' | 'savings' | null {
  const text = `${row.name} ${row.merchant_name ?? ''} ${row.category ?? ''} ${row.account_name} ${row.account_nickname ?? ''} ${row.account_subtype ?? ''}`;
  const amount = Number(row.amount);
  if (row.category === 'Roth IRA' && amount > 0) return 'roth';
  if ((row.classification === 'INVESTMENT' || row.classification === 'TRANSFER')
    && amount < 0 && row.account_type === 'investment' && /\broth(?: ira)?\b/i.test(text)) return 'roth';
  if (row.category === 'General Savings' && amount > 0) return 'savings';
  if ((row.classification === 'SAVINGS' || row.classification === 'TRANSFER')
    && amount < 0 && row.account_subtype?.toLowerCase() === 'savings') return 'savings';
  return null;
}

function contributionEvents(rows: GoalTransaction[]): Array<{ goal: 'roth' | 'savings'; date: string; amount: number }> {
  const candidates = rows
    .map((row) => ({ row, goal: goalKey(row) }))
    .filter((entry): entry is { row: GoalTransaction; goal: 'roth' | 'savings' } => entry.goal !== null);
  const incoming = candidates.filter(({ row }) => Number(row.amount) < 0);
  const matchedIncoming = new Set<string>();
  const events = incoming.map(({ row, goal }) => ({ goal, date: row.date, amount: Math.abs(Number(row.amount)) }));

  for (const { row, goal } of candidates.filter(({ row }) => Number(row.amount) > 0)) {
    const cents = Math.round(Number(row.amount) * 100);
    const day = Date.parse(`${row.date}T00:00:00Z`);
    const match = incoming.find(({ row: candidate, goal: candidateGoal }) =>
      candidateGoal === goal
      && !matchedIncoming.has(candidate.id)
      && Math.round(Math.abs(Number(candidate.amount)) * 100) === cents
      && Math.abs(Date.parse(`${candidate.date}T00:00:00Z`) - day) / 86_400_000 <= 3,
    );
    if (match) matchedIncoming.add(match.row.id);
    else events.push({ goal, date: row.date, amount: Number(row.amount) });
  }
  return events;
}

export async function getSavingsGoalsStatus(referenceDate = new Date()): Promise<SavingsGoalsStatus> {
  if (Number.isNaN(referenceDate.getTime())) throw new Error('Savings goals require a valid reference date');
  const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1, 12);
  const firstWeek = getPeriodStart('week', monthStart);
  const currentWeek = getPeriodStart('week', referenceDate);
  const weeks: Array<{ from: string; to: string }> = [];
  for (let cursor = new Date(firstWeek); cursor <= currentWeek; cursor.setDate(cursor.getDate() + 7)) {
    weeks.push(getPeriodDates('week', cursor));
  }
  const from = weeks[0].from;
  const to = weeks[weeks.length - 1].to;
  const [rothTarget, savingsTarget, result] = await Promise.all([
    getConfiguredAmount(ROTH_WEEKLY_TARGET_KEY, 50),
    getConfiguredAmount(SAVINGS_WEEKLY_TARGET_KEY, 75),
    db.execute({
      sql: `SELECT t.id, t.date, t.name, t.merchant_name, t.amount, t.category,
              COALESCE(t.manual_classification, t.classification) AS classification,
              a.name AS account_name, a.nickname AS account_nickname,
              a.type AS account_type, a.subtype AS account_subtype
            FROM transactions t JOIN accounts a ON a.id = t.account_id
            WHERE t.date >= ? AND t.date <= ? AND t.pending = 0 AND t.ignored = 0
              AND COALESCE(t.manual_classification, t.classification) IN ('TRANSFER', 'SAVINGS', 'INVESTMENT')`,
      args: [from, to],
    }),
  ]);
  const events = contributionEvents(result.rows as unknown as GoalTransaction[]);
  const definitions = [
    { key: 'roth' as const, label: 'Roth IRA', weeklyTarget: rothTarget ?? 0 },
    { key: 'savings' as const, label: 'General savings', weeklyTarget: savingsTarget ?? 0 },
  ];
  const goals = definitions.map(({ key, label, weeklyTarget }): SavingsGoalProgress => {
    const weekRows = weeks.map((week) => {
      const contributed = money(events
        .filter((event) => event.goal === key && event.date >= week.from && event.date <= week.to)
        .reduce((sum, event) => sum + event.amount, 0));
      return { ...week, contributed, complete: contributed >= weeklyTarget };
    });
    const completedWeeks = weekRows.filter((week) => week.complete).length;
    const contributed = money(weekRows.reduce((sum, week) => sum + week.contributed, 0));
    return {
      key,
      label,
      weeklyTarget,
      monthlyTarget: Math.round((weeklyTarget * 52) / 12),
      contributed,
      expectedToDate: money(weeklyTarget * weekRows.length),
      completedWeeks,
      missedWeeks: weekRows.length - completedWeeks,
      weeks: weekRows,
      status: completedWeeks === weekRows.length ? 'ON_TRACK' : 'OFF_TRACK',
    };
  });
  return {
    from,
    to,
    combinedMonthlyTarget: goals.reduce((sum, goal) => sum + goal.monthlyTarget, 0),
    goals,
  };
}

export async function getVerifiedIncome(year: number, month: number): Promise<number> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-31`;
  const result = await db.execute({
    sql: `SELECT COALESCE(-SUM(amount), 0) AS income FROM transactions
          WHERE date >= ? AND date <= ? AND amount < 0 AND pending = 0 AND ignored = 0
            AND COALESCE(manual_classification, classification) = 'INCOME'`,
    args: [from, to],
  });
  return money(Number((result.rows[0] as unknown as { income: number }).income));
}

export async function getFixedObligations(year: number, month: number): Promise<FixedObligation[]> {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-31`;
  const [tesla, insurance, charging, result] = await Promise.all([
    getConfiguredAmount(TESLA_PAYMENT_TARGET_KEY, 466),
    getConfiguredAmount(TESLA_INSURANCE_TARGET_KEY, null),
    getConfiguredAmount(EV_CHARGING_TARGET_KEY, null),
    db.execute({
      sql: `SELECT category, COALESCE(SUM(CASE
              WHEN category = 'Tesla Payment' AND amount > 0
                AND COALESCE(manual_classification, classification) IN ('TRANSFER', 'EXPENSE') THEN amount
              WHEN category != 'Tesla Payment'
                AND COALESCE(manual_classification, classification) IN ('EXPENSE', 'REFUND', 'REIMBURSEMENT') THEN amount
              ELSE 0 END), 0) AS spent
            FROM transactions
            WHERE date >= ? AND date <= ? AND pending = 0 AND ignored = 0
              AND category IN ('Tesla Payment', 'Tesla Insurance', 'EV Charging')
            GROUP BY category`,
      args: [from, to],
    }),
  ]);
  const actuals = new Map((result.rows as unknown as { category: string; spent: number }[])
    .map((row) => [row.category, money(Math.max(0, Number(row.spent)))]));
  return [
    { key: 'tesla-payment', label: 'Tesla payment', target: tesla, spent: actuals.get('Tesla Payment') ?? 0 },
    { key: 'tesla-insurance', label: 'Tesla insurance', target: insurance, spent: actuals.get('Tesla Insurance') ?? 0 },
    { key: 'ev-charging', label: 'EV charging', target: charging, spent: actuals.get('EV Charging') ?? 0 },
  ];
}

export async function getBudgetDashboardStatus(referenceDate = new Date()): Promise<BudgetDashboardStatus> {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth() + 1;
  const [weekly, monthly, goals, verifiedIncome, fixedObligations] = await Promise.all([
    getWeeklySpendingStatus(referenceDate),
    getMonthlyBudgetStatus(year, month),
    getSavingsGoalsStatus(referenceDate),
    getVerifiedIncome(year, month),
    getFixedObligations(year, month),
  ]);
  return { weekly, monthly, goals, verifiedIncome, fixedObligations };
}
