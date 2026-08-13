export const TRANSACTION_CLASSIFICATIONS = [
  'INCOME',
  'EXPENSE',
  'TRANSFER',
  'SAVINGS',
  'INVESTMENT',
  'REFUND',
  'REIMBURSEMENT',
  'NEEDS_REVIEW',
] as const;

export type TransactionClassification = typeof TRANSACTION_CLASSIFICATIONS[number];

export type ClassificationInput = {
  amount: number;
  name: string;
  merchantName?: string | null;
  category?: string | null;
  plaidPrimary?: string | null;
  plaidDetailed?: string | null;
  accountType?: string | null;
  accountSubtype?: string | null;
};

const VERIFIED_PAYROLL_SOURCES = [
  /\bh[ -]?e[ -]?b\b/i,
  /\bkbr\b/i,
  /\bnoaa\b/i,
  /city of san antonio/i,
];

const VERIFIED_DEPOSIT_DESCRIPTIONS = [
  /\bh[ -]?e[ -]?b,\s*lp\b/i,
  /\bkbr\b/i,
  /\bnoaa\b/i,
  /city of san antonio/i,
];

const AMBIGUOUS_CREDIT_SOURCES = [
  /\bvenmo\b/i,
  /\bcash ?app\b/i,
  /\bapple cash\b/i,
  /\bzelle\b/i,
  /\bcash deposit\b/i,
  /\b(?:atm|check|mobile) deposit\b/i,
];

const REFUND_TERMS = /\b(refund|reversal|returned purchase|purchase return|credit voucher)\b/i;
const REIMBURSEMENT_TERMS = /\b(reimburse(?:ment|d)?|expense repayment)\b/i;
const CREDIT_CARD_PAYMENT_TERMS = /\b(payment thank you|automatic payment\s*-?\s*thank)\b/i;

function combinedName(input: ClassificationInput): string {
  return `${input.name} ${input.merchantName ?? ''}`.trim();
}

function isTransferSignal(input: ClassificationInput): boolean {
  const primary = input.plaidPrimary ?? '';
  const detailed = input.plaidDetailed ?? '';
  return primary === 'TRANSFER_IN'
    || primary === 'TRANSFER_OUT'
    || detailed.includes('TRANSFER')
    || detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
    || input.category === 'Transfer'
    || input.category === 'Loan Payment';
}

function transferClassification(input: ClassificationInput): TransactionClassification {
  if (input.category === 'Roth IRA') return 'INVESTMENT';
  if (input.category === 'General Savings') return 'SAVINGS';
  if (input.accountType === 'investment') return 'INVESTMENT';
  if (input.accountSubtype?.toLowerCase() === 'savings') return 'SAVINGS';
  return 'TRANSFER';
}

/** Classify one transaction without assuming an equal-and-opposite owned-account match. */
export function classifyTransaction(input: ClassificationInput): TransactionClassification {
  const name = combinedName(input);
  if (input.amount < 0 && input.accountType === 'credit'
    && (CREDIT_CARD_PAYMENT_TERMS.test(name)
      || input.plaidDetailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')) {
    return 'TRANSFER';
  }
  // Payment apps and cash deposits are not evidence of an owned-account
  // transfer, even when Plaid broadly labels them TRANSFER_IN.
  if (input.amount < 0 && AMBIGUOUS_CREDIT_SOURCES.some((source) => source.test(name))) {
    return 'NEEDS_REVIEW';
  }

  if (isTransferSignal(input)) return transferClassification(input);

  if (input.amount < 0) {
    if (REIMBURSEMENT_TERMS.test(name)) return 'REIMBURSEMENT';
    if (REFUND_TERMS.test(name)) return 'REFUND';

    const knownPayrollSource = VERIFIED_PAYROLL_SOURCES.some((source) => source.test(name));
    const verifiedPayroll = knownPayrollSource && (
      (input.plaidPrimary === 'INCOME' && input.plaidDetailed === 'INCOME_WAGES')
      || (input.accountType === 'depository'
        && VERIFIED_DEPOSIT_DESCRIPTIONS.some((source) => source.test(name)))
    );
    if (verifiedPayroll) return 'INCOME';

    if (input.category && !['Income', 'Uncategorized'].includes(input.category)
      && input.plaidPrimary !== 'INCOME') return 'REFUND';
    return 'NEEDS_REVIEW';
  }

  if (input.amount > 0) return 'EXPENSE';
  return 'NEEDS_REVIEW';
}

export function classifyOwnedTransfer(
  outgoing: Pick<ClassificationInput, 'accountType' | 'accountSubtype'>,
  incoming: Pick<ClassificationInput, 'accountType' | 'accountSubtype'>,
): TransactionClassification {
  if (outgoing.accountType === 'investment' || incoming.accountType === 'investment') return 'INVESTMENT';
  if (outgoing.accountSubtype?.toLowerCase() === 'savings'
    || incoming.accountSubtype?.toLowerCase() === 'savings') return 'SAVINGS';
  return 'TRANSFER';
}

export function countsAsSpending(classification: TransactionClassification): boolean {
  return classification === 'EXPENSE' || classification === 'REFUND' || classification === 'REIMBURSEMENT';
}

export function countsAsIncome(classification: TransactionClassification): boolean {
  return classification === 'INCOME';
}
