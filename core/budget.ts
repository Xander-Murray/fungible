import { db } from './db.js';

export type BudgetStatus = 'GOOD' | 'WARNING' | 'OVER_BUDGET';

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

export function budgetStatus(spent: number, limit: number): BudgetStatus {
  if (spent > limit) return 'OVER_BUDGET';
  if (limit === 0) return spent === 0 ? 'GOOD' : 'OVER_BUDGET';
  return spent / limit >= 0.8 ? 'WARNING' : 'GOOD';
}

function percentage(spent: number, limit: number): number {
  if (limit === 0) return spent === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (spent / limit) * 100;
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
