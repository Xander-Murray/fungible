import { db } from './db.js';
import {
  classifyOwnedTransfer,
  classifyTransaction,
  type TransactionClassification,
} from './transaction-classification.js';

type StoredTransaction = {
  id: string;
  account_id: string;
  date: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  category: string | null;
  raw_category: string | null;
  raw_category_detail: string | null;
  classification: TransactionClassification | null;
  manual_classification: TransactionClassification | null;
  account_type: string | null;
  account_subtype: string | null;
};

export function classifyStoredTransaction(tx: StoredTransaction): TransactionClassification {
  return classifyTransaction({
    amount: Number(tx.amount),
    name: tx.name,
    merchantName: tx.merchant_name,
    category: tx.category,
    plaidPrimary: tx.raw_category,
    plaidDetailed: tx.raw_category_detail,
    accountType: tx.account_type,
    accountSubtype: tx.account_subtype,
  });
}

export async function classifyTransactionById(id: string): Promise<TransactionClassification | null> {
  const result = await db.execute({
    sql: `SELECT t.*, a.type AS account_type, a.subtype AS account_subtype
          FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.id = ?`,
    args: [id],
  });
  const tx = result.rows[0] as unknown as StoredTransaction | undefined;
  return tx ? classifyStoredTransaction(tx) : null;
}

/**
 * Match transfer-like debits and credits across accounts owned by the user.
 * Plaid transactions can post on different days, so exact amounts are paired
 * within a three-day window, preferring the nearest posting date.
 */
export async function reconcileOwnedTransfers(): Promise<number> {
  const result = await db.execute(`
    SELECT t.*, a.type AS account_type, a.subtype AS account_subtype
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.pending = 0
      AND COALESCE(t.manual_classification, t.classification) IN ('TRANSFER', 'SAVINGS', 'INVESTMENT')
    ORDER BY t.date, t.id
  `);
  const rows = result.rows as unknown as StoredTransaction[];
  const used = new Set<string>();
  const updates: { sql: string; args: (string | number)[] }[] = [];

  for (const outgoing of rows) {
    if (used.has(outgoing.id) || Number(outgoing.amount) <= 0) continue;
    const amountInCents = Math.round(Number(outgoing.amount) * 100);
    const outgoingDay = Date.parse(`${outgoing.date}T00:00:00Z`);
    const incoming = rows
      .filter((candidate) => {
        if (used.has(candidate.id) || candidate.account_id === outgoing.account_id || Number(candidate.amount) >= 0) return false;
        if (Math.round(Number(candidate.amount) * 100) !== -amountInCents) return false;
        const dayDifference = Math.abs(Date.parse(`${candidate.date}T00:00:00Z`) - outgoingDay) / 86_400_000;
        return dayDifference <= 3;
      })
      .sort((a, b) => Math.abs(Date.parse(a.date) - outgoingDay) - Math.abs(Date.parse(b.date) - outgoingDay))[0];
    if (!incoming) continue;

    used.add(outgoing.id);
    used.add(incoming.id);
    const classification = classifyOwnedTransfer(
      { accountType: outgoing.account_type, accountSubtype: outgoing.account_subtype },
      { accountType: incoming.account_type, accountSubtype: incoming.account_subtype },
    );
    for (const tx of [outgoing, incoming]) {
      if (tx.manual_classification === null && tx.classification !== classification) {
        updates.push({ sql: 'UPDATE transactions SET classification = ? WHERE id = ?', args: [classification, tx.id] });
      }
    }
  }

  if (updates.length > 0) await db.batch(updates, 'write');
  return updates.length;
}
