import { describe, expect, it } from 'vitest';
import {
  classifyOwnedTransfer,
  classifyTransaction,
  countsAsIncome,
  countsAsSpending,
} from '../core/transaction-classification.js';

describe('classifyTransaction', () => {
  it.each(['H-E-B', 'KBR PAYROLL', 'NOAA DIRECT DEP', 'City of San Antonio'])('verifies known payroll source %s', (name) => {
    expect(classifyTransaction({
      amount: -1_000,
      name,
      plaidPrimary: 'INCOME',
      plaidDetailed: 'INCOME_WAGES',
    })).toBe('INCOME');
  });

  it('does not verify an unknown payroll source from an income category alone', () => {
    expect(classifyTransaction({
      amount: -1_000,
      name: 'ACME DIRECT DEPOSIT',
      plaidPrimary: 'INCOME',
      plaidDetailed: 'INCOME_WAGES',
    })).toBe('NEEDS_REVIEW');
  });

  it.each(['Venmo', 'Cash App', 'Apple Cash', 'Zelle', 'Cash Deposit'])('flags ambiguous credit from %s', (name) => {
    expect(classifyTransaction({ amount: -100, name, plaidPrimary: 'TRANSFER_IN' })).toBe('NEEDS_REVIEW');
  });

  it('classifies purchases, refunds, and reimbursements', () => {
    expect(classifyTransaction({ amount: 25, name: 'CAVA' })).toBe('EXPENSE');
    expect(classifyTransaction({ amount: -25, name: 'CAVA purchase refund' })).toBe('REFUND');
    expect(classifyTransaction({ amount: -25, name: 'Travel reimbursement' })).toBe('REIMBURSEMENT');
    expect(classifyTransaction({ amount: -25, name: 'CAVA', category: 'Food & Drink', plaidPrimary: 'FOOD_AND_DRINK' })).toBe('REFUND');
  });

  it('recognizes Plaid transfers and credit-card payments', () => {
    expect(classifyTransaction({ amount: 500, name: 'Online transfer', plaidPrimary: 'TRANSFER_OUT' })).toBe('TRANSFER');
    expect(classifyTransaction({ amount: 500, name: 'Payment', plaidDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' })).toBe('TRANSFER');
  });

  it('uses the account destination to distinguish owned transfers', () => {
    const checking = { accountType: 'depository', accountSubtype: 'checking' };
    expect(classifyOwnedTransfer(checking, { accountType: 'credit', accountSubtype: 'credit card' })).toBe('TRANSFER');
    expect(classifyOwnedTransfer(checking, { accountType: 'depository', accountSubtype: 'savings' })).toBe('SAVINGS');
    expect(classifyOwnedTransfer(checking, { accountType: 'investment', accountSubtype: 'brokerage' })).toBe('INVESTMENT');
  });

  it('only counts expense corrections in spending and verified payroll in income', () => {
    expect(countsAsSpending('EXPENSE')).toBe(true);
    expect(countsAsSpending('REFUND')).toBe(true);
    expect(countsAsSpending('REIMBURSEMENT')).toBe(true);
    expect(countsAsSpending('TRANSFER')).toBe(false);
    expect(countsAsSpending('SAVINGS')).toBe(false);
    expect(countsAsSpending('INVESTMENT')).toBe(false);
    expect(countsAsIncome('INCOME')).toBe(true);
    expect(countsAsIncome('NEEDS_REVIEW')).toBe(false);
  });
});
