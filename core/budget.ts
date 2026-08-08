import { db } from './db.js';
import { getPeriodDates, getPeriodStart } from './dateUtils.js';

export type BudgetStatus = 'GOOD' | 'WARNING' | 'OVER_BUDGET';
export type WeeklyBudgetStatus = 'GOOD' | 'WARNING' | 'ESSENTIALS_ONLY' | 'OVER_BUDGET';

export const WEEKLY_CHASE_LIMIT_KEY = 'budget_weekly_chase_limit';
export const DEFAULT_WEEKLY_CHASE_LIMIT = 185;

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
            LEFT JOIN categories c ON c.name = t.category
            WHERE t.date >= ? AND t.date <= ?
              AND t.pending = 0 AND t.ignored = 0
              AND COALESCE(t.manual_classification, t.classification)
                IN ('EXPENSE', 'REFUND', 'REIMBURSEMENT')
              AND LOWER(a.type) = 'credit'
              AND (
                LOWER(COALESCE(a.institution_name, '')) LIKE '%chase%'
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

export async function getMonthlyBudgetStatus(year: number, month: number): Promise<MonthlyBudgetStatus> {
  if (!Number.isInteger(year) || year < 1 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Budget month must use a valid year and month');
  }
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-31`;
  const result = await db.execute({
    sql: `SELECT budget.name AS category, budget.monthly_limit AS monthly_limit,
            COALESCE(SUM(CASE
              WHEN t.classification IN ('EXPENSE', 'REFUND', 'REIMBURSEMENT') THEN t.amount
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

  const categories = (result.rows as unknown as {
    category: string; monthly_limit: number; net_spent: number;
  }[]).map((row): MonthlyBudgetCategory => {
    const limit = money(Number(row.monthly_limit));
    const spent = money(Math.max(0, Number(row.net_spent)));
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
