import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousDataDir = process.env.FUNGIBLE_DATA_DIR;
const testDataDir = mkdtempSync(join(tmpdir(), 'fungible-budget-db-'));
process.env.FUNGIBLE_DATA_DIR = testDataDir;

const { db, initDb } = await import('../core/db.js');

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.FUNGIBLE_DATA_DIR;
  else process.env.FUNGIBLE_DATA_DIR = previousDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

describe('personal budget database migration', () => {
  it('seeds the approved limits and aliases on first initialization', async () => {
    await initDb();

    const limits = await db.execute(`
      SELECT name, monthly_limit FROM categories
      WHERE monthly_limit IS NOT NULL ORDER BY name
    `);
    expect(limits.rows).toMatchObject([
      { name: 'Entertainment', monthly_limit: 100 },
      { name: 'Food & Drink', monthly_limit: 180 },
      { name: 'Groceries', monthly_limit: 150 },
      { name: 'Miscellaneous', monthly_limit: 75 },
      { name: 'Shopping', monthly_limit: 125 },
      { name: 'Transportation Energy', monthly_limit: 175 },
    ]);

    const groups = await db.execute(`
      SELECT name, budget_group FROM categories
      WHERE budget_group IS NOT NULL ORDER BY name
    `);
    expect(groups.rows).toMatchObject([
      { name: 'Dining', budget_group: 'Food & Drink' },
      { name: 'EV Charging', budget_group: 'Transportation Energy' },
      { name: 'Gas', budget_group: 'Transportation Energy' },
      { name: 'Grocery', budget_group: 'Groceries' },
      { name: 'Misc', budget_group: 'Miscellaneous' },
    ]);
  });

  it('does not restore defaults over user changes on later initialization', async () => {
    await db.execute("UPDATE categories SET monthly_limit = 210 WHERE name = 'Food & Drink'");
    await initDb();
    const row = (await db.execute("SELECT monthly_limit FROM categories WHERE name = 'Food & Drink'")).rows[0];
    expect(row.monthly_limit).toBe(210);
  });
});
