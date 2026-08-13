/** SQL expression for the effective classification used by every financial summary. */
export function effectiveClassification(alias = 't'): string {
  return `COALESCE(${alias}.manual_classification, ${alias}.classification,
    CASE
      WHEN ${alias}.category IN ('Transfer', 'Loan Payment') THEN 'TRANSFER'
      WHEN ${alias}.amount < 0 AND ${alias}.category NOT IN ('Income', 'Uncategorized') THEN 'REFUND'
      WHEN ${alias}.amount < 0 THEN 'INCOME'
      ELSE 'EXPENSE'
    END)`;
}

export function spendingClassification(alias = 't'): string {
  return `${effectiveClassification(alias)} IN ('EXPENSE', 'REFUND', 'REIMBURSEMENT')`;
}

export function incomeClassification(alias = 't'): string {
  return `${effectiveClassification(alias)} = 'INCOME'`;
}
