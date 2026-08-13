import { createClient, type Client } from '@libsql/client';
import path from 'node:path';
import fs from 'node:fs';
import { encryptToken } from './crypto.js';
import { DATA_DIR } from './paths.js';

const DB_PATH = path.join(DATA_DIR, 'fungible.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db: Client = createClient({ url: `file:${DB_PATH}` });

export async function initDb() {
  // Create all tables (idempotent)
  await db.batch([
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      institution_name TEXT,
      mask TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      merchant_name TEXT,
      amount REAL NOT NULL,
      category TEXT,
      raw_category TEXT,
      pending INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id)`,
    `CREATE TABLE IF NOT EXISTS category_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL DEFAULT 0,
      match_type TEXT NOT NULL CHECK(match_type IN ('name', 'regex')),
      pattern TEXT NOT NULL,
      category TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sync_state (
      account_id TEXT PRIMARY KEY,
      cursor TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS plaid_items (
      item_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      institution_name TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS hidden_categories (
      category TEXT PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS name_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT NOT NULL CHECK(match_type IN ('name', 'regex')),
      pattern TEXT NOT NULL,
      replacement TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (transaction_id, tag_id),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id),
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    )`,
    `CREATE TABLE IF NOT EXISTS tag_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL DEFAULT 0,
      match_type TEXT NOT NULL CHECK(match_type IN ('name','regex','all')),
      pattern TEXT NOT NULL DEFAULT '',
      tag_id INTEGER NOT NULL,
      account_id TEXT,
      min_amount REAL,
      max_amount REAL,
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    )`,
    `CREATE TABLE IF NOT EXISTS tag_rule_suppressions (
      transaction_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (transaction_id, tag_id)
    )`,
    `CREATE TABLE IF NOT EXISTS balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      balance REAL NOT NULL,
      date TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_history_acct_date
      ON balance_history(account_id, date)`,
    `CREATE TABLE IF NOT EXISTS household_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      birth_year INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
  ], 'write');

  // Idempotent column migrations (each may fail if column exists — that's fine)
  const migrations = [
    'ALTER TABLE transactions ADD COLUMN manual_category TEXT',
    'ALTER TABLE transactions ADD COLUMN display_name TEXT',
    'ALTER TABLE transactions ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE transactions ADD COLUMN classification TEXT',
    'ALTER TABLE transactions ADD COLUMN manual_classification TEXT',
    'ALTER TABLE transactions ADD COLUMN raw_category_detail TEXT',
    'ALTER TABLE category_rules ADD COLUMN min_amount REAL',
    'ALTER TABLE category_rules ADD COLUMN max_amount REAL',
    'ALTER TABLE name_rules ADD COLUMN min_amount REAL',
    'ALTER TABLE name_rules ADD COLUMN max_amount REAL',
    "ALTER TABLE categories ADD COLUMN flexibility TEXT CHECK(flexibility IN ('fixed','flexible','discretionary'))",
    'ALTER TABLE categories ADD COLUMN monthly_limit REAL',
    'ALTER TABLE categories ADD COLUMN budget_group TEXT',
    'ALTER TABLE plaid_items ADD COLUMN last_synced_at INTEGER',
    'ALTER TABLE plaid_items ADD COLUMN days_requested INTEGER',
    'ALTER TABLE accounts ADD COLUMN nickname TEXT',
    'ALTER TABLE accounts ADD COLUMN owner TEXT',
    'ALTER TABLE accounts ADD COLUMN apr REAL',
    'ALTER TABLE accounts ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE accounts ADD COLUMN item_id TEXT',
    'ALTER TABLE category_rules ADD COLUMN account_id TEXT',
    'ALTER TABLE name_rules ADD COLUMN account_id TEXT',
  ];
  for (const sql of migrations) {
    try {
      await db.execute(sql);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes('duplicate column name') && !msg.includes('already exists')) throw e;
    }
  }

  // Existing rows lack Plaid's detailed category, so credits cannot safely be
  // promoted to verified income. Leave them for review until a sync or manual
  // classification supplies stronger evidence.
  await db.execute(`UPDATE transactions
    SET classification = CASE
      WHEN category IN ('Transfer', 'Loan Payment') THEN 'TRANSFER'
      WHEN amount > 0 THEN 'EXPENSE'
      ELSE 'NEEDS_REVIEW'
    END
    WHERE classification IS NULL`);

  // Seed categories before applying defaults so a brand-new database receives
  // its flexibility and budget configuration on the first launch.
  const defaultCategories = [
    'Income', 'Transfer', 'Food & Drink', 'Dining', 'Shopping',
    'Transportation', 'Transportation Energy', 'Gas', 'EV Charging',
    'Grocery', 'Groceries', 'Misc', 'Miscellaneous', 'Travel',
    'Roth IRA', 'General Savings', 'Tesla Payment', 'Tesla Insurance',
    'Bills & Utilities', 'Insurance', 'Medical', 'Personal Care',
    'Childcare', 'Entertainment', 'Home', 'Services', 'Fees',
    'Government', 'Taxes', 'Loan Payment', 'Subscriptions', 'Uncategorized',
  ];
  await db.batch(
    defaultCategories.map((cat) => ({
      sql: 'INSERT OR IGNORE INTO categories (name) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  // Seed default flexibility tiers (only where not already set)
  const flexDefaults: [string, string][] = [
    ['Rent', 'fixed'], ['Insurance', 'fixed'], ['Childcare', 'fixed'],
    ['Roth IRA', 'fixed'], ['General Savings', 'fixed'],
    ['Tesla Payment', 'fixed'], ['Tesla Insurance', 'fixed'],
    ['Loan Payment', 'fixed'], ['Taxes', 'fixed'], ['Government', 'fixed'],
    ['Bills & Utilities', 'fixed'], ['Medical', 'fixed'],
    ['Food & Drink', 'flexible'], ['Grocery', 'flexible'], ['Groceries', 'flexible'],
    ['Transportation', 'flexible'], ['Transportation Energy', 'flexible'],
    ['Gas', 'flexible'], ['EV Charging', 'flexible'], ['Misc', 'flexible'], ['Miscellaneous', 'flexible'],
    ['Personal Care', 'flexible'], ['Home', 'flexible'], ['Services', 'flexible'],
    ['Subscriptions', 'discretionary'],
    ['Shopping', 'discretionary'], ['Entertainment', 'discretionary'],
    ['Travel', 'discretionary'], ['Dining', 'discretionary'], ['Fees', 'discretionary'],
  ];
  await db.batch(
    flexDefaults.map(([cat, flex]) => ({
      sql: 'UPDATE categories SET flexibility = ? WHERE name = ? AND flexibility IS NULL',
      args: [flex, cat],
    })),
    'write',
  );

  // Apply the initial personal budget once. The marker lets users later clear
  // or change a limit without initDb restoring the defaults on every launch.
  const budgetSeed = await db.execute("SELECT value FROM settings WHERE key = 'personal_budget_defaults_v1'");
  if (budgetSeed.rows.length === 0) {
    const limits: [string, number][] = [
      ['Food & Drink', 180],
      ['Shopping', 125],
      ['Entertainment', 100],
      ['Groceries', 150],
      ['Transportation Energy', 175],
      ['Miscellaneous', 75],
    ];
    const groups: [string, string][] = [
      ['Dining', 'Food & Drink'],
      ['Grocery', 'Groceries'],
      ['Gas', 'Transportation Energy'],
      ['EV Charging', 'Transportation Energy'],
      ['Misc', 'Miscellaneous'],
    ];
    await db.batch([
      ...limits.map(([name, limit]) => ({
        sql: 'UPDATE categories SET monthly_limit = ?, budget_group = NULL WHERE name = ? AND monthly_limit IS NULL AND budget_group IS NULL',
        args: [limit, name],
      })),
      ...groups.map(([name, group]) => ({
        sql: 'UPDATE categories SET budget_group = ? WHERE name = ? AND monthly_limit IS NULL AND budget_group IS NULL',
        args: [group, name],
      })),
      {
        sql: "INSERT INTO settings (key, value) VALUES ('personal_budget_defaults_v1', '1')",
        args: [],
      },
    ], 'write');
  }

  await db.execute(`INSERT OR IGNORE INTO settings (key, value)
    VALUES ('budget_weekly_chase_limit', '185')`);
  await db.batch([
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('budget_roth_weekly_target', '50')",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('budget_savings_weekly_target', '75')",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('budget_tesla_payment_target', '466')",
  ], 'write');

  // Migrate plaintext Plaid access tokens to encrypted form (idempotent)
  const itemsRes = await db.execute('SELECT item_id, access_token FROM plaid_items');
  const plainItems = (itemsRes.rows as unknown as { item_id: string; access_token: string }[])
    .filter((r) => !r.access_token.includes(':'));
  if (plainItems.length > 0) {
    await db.batch(
      plainItems.map((item) => ({
        sql: 'UPDATE plaid_items SET access_token = ? WHERE item_id = ?',
        args: [encryptToken(item.access_token), item.item_id],
      })),
      'write',
    );
  }

  // Seed default hidden categories
  await db.batch(
    ['Transfer', 'Loan Payment'].map((cat) => ({
      sql: 'INSERT OR IGNORE INTO hidden_categories (category) VALUES (?)',
      args: [cat],
    })),
    'write',
  );

  // One-time migration: seed household_members from profile.json if table is empty
  const hmCount = await db.execute('SELECT COUNT(*) as n FROM household_members');
  if (Number(hmCount.rows[0].n) === 0) {
    type ProfileJson = { self: { name: string; birthYear: number }; spouse?: { name: string; birthYear: number }; children: { name: string; birthYear: number }[] };
    let p: ProfileJson | null = null;
    try { p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'profile.json'), 'utf8')) as ProfileJson; } catch {}
    const self = p?.self ?? { name: '', birthYear: 0 };
    const rows: { sql: string; args: (string | number)[] }[] = [
      { sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,0)', args: ['self', self.name, self.birthYear] },
    ];
    if (p?.spouse) rows.push({ sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,1)', args: ['spouse', p.spouse.name, p.spouse.birthYear] });
    for (let i = 0; i < (p?.children ?? []).length; i++) {
      const c = p!.children[i];
      rows.push({ sql: 'INSERT INTO household_members (id, name, birth_year, sort_order) VALUES (?,?,?,?)', args: [`child-${i}`, c.name, c.birthYear, i + 2] });
    }
    await db.batch(rows, 'write');
  }

  const classificationVersion = await db.execute(
    "SELECT value FROM settings WHERE key = 'classification_rules_version'",
  );
  if (classificationVersion.rows[0]?.value !== '2') {
    const { reclassifyAllTransactions } = await import('./classification-store.js');
    await reclassifyAllTransactions();
    await db.execute(`INSERT INTO settings (key, value) VALUES ('classification_rules_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  }

}
