import { getPlaidClient, plaidErrorMessage } from './plaid.js';
import { db } from './db.js';
import { categorizeWithRules, loadCategoryRules } from './categorize.js';
import { applyNameRulesWithRules, loadNameRules } from './rename.js';
import { applyTagRules } from './tag-rules.js';
import { deduplicateCsvVsPlaid } from './dedup.js';
import { decryptToken } from './crypto.js';
import type { Transaction } from 'plaid';
import { classifyTransaction } from './transaction-classification.js';
import { reconcileOwnedTransfers } from './classification-store.js';

export async function syncTransactions(accessToken: string, itemId: string) {
  const cursorRes = await db.execute({
    sql: 'SELECT cursor FROM sync_state WHERE account_id = ?',
    args: [itemId],
  });
  let cursor = cursorRes.rows.length > 0
    ? (cursorRes.rows[0] as unknown as { cursor: string }).cursor
    : undefined;

  let added: Transaction[] = [];
  let modified: Transaction[] = [];
  let removedIds: string[] = [];
  let hasMore = true;

  while (hasMore) {
    const response = await getPlaidClient().transactionsSync({ access_token: accessToken, cursor });
    const data = response.data;
    added = added.concat(data.added);
    modified = modified.concat(data.modified);
    removedIds = removedIds.concat(data.removed.map((r) => r.transaction_id));
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }

  // Upsert accounts and snapshot balances
  const accountsResponse = await getPlaidClient().accountsGet({ access_token: accessToken });
  const today = new Date().toISOString().slice(0, 10);
  await db.batch(
    accountsResponse.data.accounts.flatMap((acct) => {
      const rows: { sql: string; args: (string | number | null)[] }[] = [
        {
          sql: `INSERT INTO accounts (id, name, type, subtype, mask, item_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name=excluded.name, type=excluded.type, subtype=excluded.subtype,
                  mask=excluded.mask, item_id=excluded.item_id`,
          args: [acct.account_id, acct.name, acct.type, acct.subtype ?? null, acct.mask ?? null, itemId],
        },
      ];
      const balance = acct.balances.current;
      if (balance !== null && balance !== undefined) {
        rows.push({
          sql: `INSERT INTO balance_history (account_id, balance, date) VALUES (?, ?, ?)
                ON CONFLICT(account_id, date) DO UPDATE SET balance=excluded.balance`,
          args: [acct.account_id, balance, today],
        });
      }
      return rows;
    }),
    'write',
  );

  // Load rules once for the batch
  const [catRules, nameRules] = await Promise.all([loadCategoryRules(), loadNameRules()]);
  const accounts = new Map(accountsResponse.data.accounts.map((account) => [account.account_id, account]));

  // Upsert added + modified
  if (added.length > 0 || modified.length > 0) {
    await db.batch(
      [...added, ...modified].map((tx) => {
        const rawCategory = tx.personal_finance_category?.primary ?? null;
        const rawCategoryDetail = tx.personal_finance_category?.detailed ?? null;
        const category = categorizeWithRules(catRules, tx.name, tx.merchant_name ?? null, rawCategory, tx.amount, tx.account_id, rawCategoryDetail);
        const displayName = applyNameRulesWithRules(nameRules, tx.name, tx.amount, tx.account_id);
        const account = accounts.get(tx.account_id);
        const classification = classifyTransaction({
          amount: tx.amount,
          name: tx.name,
          merchantName: tx.merchant_name ?? null,
          category,
          plaidPrimary: rawCategory,
          plaidDetailed: rawCategoryDetail,
          accountType: account?.type ?? null,
          accountSubtype: account?.subtype ?? null,
        });
        return {
          sql: `INSERT INTO transactions (id, account_id, date, name, merchant_name, amount, category, raw_category, raw_category_detail, pending, display_name, classification)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  date=excluded.date, name=excluded.name, merchant_name=excluded.merchant_name,
                  amount=excluded.amount,
                  category=COALESCE(manual_category, excluded.category),
                  raw_category=excluded.raw_category,
                  raw_category_detail=excluded.raw_category_detail,
                  pending=excluded.pending,
                  display_name=excluded.display_name,
                  classification=COALESCE(manual_classification, excluded.classification)`,
          args: [
            tx.transaction_id, tx.account_id, tx.date, tx.name,
            tx.merchant_name ?? null, tx.amount, category, rawCategory,
            rawCategoryDetail, tx.pending ? 1 : 0,
            displayName !== tx.name ? displayName : null,
            classification,
          ],
        };
      }),
      'write',
    );

    // Apply tag rules to new/changed rows. Suppression keeps removed tags gone,
    // so re-asserting on modified/existing rows is safe.
    await applyTagRules({ txIds: [...added, ...modified].map((tx) => tx.transaction_id) });
    await reconcileOwnedTransfers();
  }

  // Remove deleted. Clear child rows first: transaction_tags has a FK
  // (transaction_id → transactions.id), so deleting a tagged transaction
  // directly fails with a FOREIGN KEY constraint. tag_rule_suppressions is
  // keyed by transaction_id too (no FK, but clearing it avoids orphan rows).
  // One batch keeps the three deletes atomic.
  if (removedIds.length > 0) {
    const placeholders = removedIds.map(() => '?').join(',');
    await db.batch([
      { sql: `DELETE FROM transaction_tags WHERE transaction_id IN (${placeholders})`, args: removedIds },
      { sql: `DELETE FROM tag_rule_suppressions WHERE transaction_id IN (${placeholders})`, args: removedIds },
      { sql: `DELETE FROM transactions WHERE id IN (${placeholders})`, args: removedIds },
    ], 'write');
  }

  // Save cursor and last_synced_at
  await db.batch([
    {
      sql: `INSERT INTO sync_state (account_id, cursor) VALUES (?, ?)
            ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor`,
      args: [itemId, cursor ?? null],
    },
    {
      sql: 'UPDATE plaid_items SET last_synced_at = ? WHERE item_id = ?',
      args: [Date.now(), itemId],
    },
  ], 'write');

  const dupes = await deduplicateCsvVsPlaid();
  return { added: added.length, modified: modified.length, removed: removedIds.length, dupes };
}

const DEBOUNCE_MS = 15 * 60 * 1000;

export type SyncItemResult = {
  itemId: string;
  added: number; modified: number; removed: number; dupes: number;
  skipped: boolean;
  // Set when this item failed to sync; carries the extracted Plaid/error message
  // so callers can report which item broke and why. One item failing does not
  // abort the others.
  error?: string;
};

export async function syncAll(force = false): Promise<SyncItemResult[]> {
  const itemsRes = await db.execute('SELECT item_id, access_token, last_synced_at FROM plaid_items');
  const items = itemsRes.rows as unknown as {
    item_id: string; access_token: string; last_synced_at: number | null;
  }[];

  const results: SyncItemResult[] = [];
  for (const item of items) {
    if (!force && item.last_synced_at && Date.now() - Number(item.last_synced_at) < DEBOUNCE_MS) {
      results.push({ itemId: item.item_id, added: 0, modified: 0, removed: 0, dupes: 0, skipped: true });
      continue;
    }
    try {
      const result = await syncTransactions(decryptToken(item.access_token), item.item_id);
      results.push({ itemId: item.item_id, ...result, skipped: false });
    } catch (err) {
      results.push({
        itemId: item.item_id, added: 0, modified: 0, removed: 0, dupes: 0,
        skipped: false, error: plaidErrorMessage(err),
      });
    }
  }
  return results;
}
