import { addDays, addMonths, endOfMonth, isLastDayOfMonth } from "date-fns";
import { isLoanEvent, type LoanEvent, type LoanPaymentFrequency } from "./loan-events";

export const LOAN_PERIODS_PER_YEAR: Record<LoanPaymentFrequency, number> = {
  monthly: 12,
  biweekly: 26,
  accelerated_biweekly: 26,
};

export interface LoanProjectionInput {
  principal: number;
  annualRate: number;
  paymentCount: number;
  paymentAmount?: number;
  frequency?: LoanPaymentFrequency;
}

export interface LoanProjectionRow {
  paymentNumber: number;
  openingBalance: number;
  interest: number;
  principal: number;
  payment: number;
  closingBalance: number;
}

export interface DatedLoanProjectionRow extends LoanProjectionRow {
  paymentDate: Date;
}

export interface LoanProjection {
  rows: DatedLoanProjectionRow[];
  remainingPayments: number;
  endDate: Date | null;
  finalPayment: DatedLoanProjectionRow | null;
}

export interface EventDrivenLoanProjectionInput extends LoanProjectionInput {
  firstPaymentDate: Date;
  events: LoanEvent[];
}

export function getLoanPeriodsPerYear(frequency: LoanPaymentFrequency = "monthly"): number {
  return LOAN_PERIODS_PER_YEAR[frequency];
}

export function calculatePaymentCount(
  termYears: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  if (!Number.isFinite(termYears) || termYears <= 0) return null;
  const count = Math.round(termYears * getLoanPeriodsPerYear(frequency));
  return count > 0 ? count : null;
}

function validInput({ principal, annualRate, paymentCount }: LoanProjectionInput): boolean {
  return (
    Number.isFinite(principal) &&
    principal >= 0 &&
    Number.isFinite(annualRate) &&
    annualRate >= 0 &&
    Number.isInteger(paymentCount) &&
    paymentCount > 0
  );
}

/** Calculate a constant-payment amount without any UI or persistence concerns. */
export function calculateLoanPayment({
  principal,
  annualRate,
  paymentCount,
  frequency,
}: LoanProjectionInput): number | null {
  if (!validInput({ principal, annualRate, paymentCount })) return null;
  if (principal === 0) return 0;

  if (frequency === "accelerated_biweekly") {
    const monthlyPayment = calculateLoanPayment({
      principal,
      annualRate,
      paymentCount: Math.round((paymentCount * 12) / 26),
      frequency: "monthly",
    });
    return monthlyPayment === null ? null : monthlyPayment / 2;
  }

  const periodicRate = annualRate / 100 / getLoanPeriodsPerYear(frequency);
  return periodicRate === 0
    ? principal / paymentCount
    : (principal * periodicRate) / (1 - Math.pow(1 + periodicRate, -paymentCount));
}

/** Calculate the number of payments required for a balance at a fixed payment. */
export function calculateRemainingPayments(
  balance: number,
  annualRate: number,
  paymentAmount: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  if (
    !Number.isFinite(balance) ||
    balance < 0 ||
    !Number.isFinite(annualRate) ||
    annualRate < 0 ||
    !Number.isFinite(paymentAmount) ||
    paymentAmount <= 0
  ) {
    return null;
  }
  if (balance === 0) return 0;

  const periodicRate = annualRate / 100 / getLoanPeriodsPerYear(frequency);
  if (periodicRate === 0) return Math.ceil(balance / paymentAmount);
  if (paymentAmount <= balance * periodicRate) return null;

  const exactCount =
    -Math.log(1 - (balance * periodicRate) / paymentAmount) / Math.log(1 + periodicRate);
  return Number.isFinite(exactCount) && exactCount > 0 ? Math.ceil(exactCount) : null;
}

/** Calculate the contractual date of the last payment. */
export function calculateLoanEndDate(
  firstPaymentDate: Date,
  paymentCount: number,
  frequency: LoanPaymentFrequency = "monthly",
): Date | null {
  if (!(firstPaymentDate instanceof Date) || Number.isNaN(firstPaymentDate.getTime())) return null;
  if (!Number.isInteger(paymentCount) || paymentCount <= 0) return null;

  const nominalDate =
    frequency === "monthly"
      ? addMonths(firstPaymentDate, paymentCount - 1)
      : addDays(firstPaymentDate, (paymentCount - 1) * 14);
  return frequency === "monthly" && isLastDayOfMonth(firstPaymentDate)
    ? endOfMonth(nominalDate)
    : nominalDate;
}

/**
 * Project a constant-payment loan and expose the full accounting breakdown.
 * Rounding is applied only to the reported closing balance so the calculation
 * retains full precision until the final value is presented.
 */
export function projectLoan(input: LoanProjectionInput): LoanProjectionRow[] {
  if (!validInput(input)) return [];

  const payment = input.paymentAmount ?? calculateLoanPayment(input);
  if (payment === null || !Number.isFinite(payment) || payment <= 0) return [];

  const periodicRate = input.annualRate / 100 / getLoanPeriodsPerYear(input.frequency ?? "monthly");
  let balance = input.principal;

  return Array.from({ length: input.paymentCount }, (_, index) => {
    const openingBalance = balance;
    const interest = openingBalance * periodicRate;
    const principal = Math.min(openingBalance, Math.max(0, payment - interest));
    balance = Math.max(0, openingBalance - principal);
    const closingBalance = index === input.paymentCount - 1 ? 0 : balance;

    return {
      paymentNumber: index + 1,
      openingBalance,
      interest,
      principal,
      payment,
      closingBalance: Math.round(closingBalance * 100) / 100,
    };
  });
}

/**
 * Project a loan with contractual dates and summary values needed by the UI.
 * This function is pure: it does not access React, metadata, or persistence.
 */
export function projectLoanSchedule(
  input: LoanProjectionInput & { firstPaymentDate: Date },
): LoanProjection {
  const rows = projectLoan(input);
  if (rows.length === 0) {
    return { rows: [], remainingPayments: 0, endDate: null, finalPayment: null };
  }

  const frequency = input.frequency ?? "monthly";
  const preserveEndOfMonth = frequency === "monthly" && isLastDayOfMonth(input.firstPaymentDate);
  const datedRows = rows.map((row, index) => {
    const nominalDate =
      frequency === "monthly"
        ? addMonths(input.firstPaymentDate, index)
        : addDays(input.firstPaymentDate, index * 14);
    return {
      ...row,
      paymentDate: preserveEndOfMonth ? endOfMonth(nominalDate) : nominalDate,
    };
  });

  return {
    rows: datedRows,
    remainingPayments: datedRows.length,
    endDate: datedRows.at(-1)?.paymentDate ?? null,
    finalPayment: datedRows.at(-1) ?? null,
  };
}

/**
 * Project a loan from its initial terms and dated lifecycle events.
 * Events are applied before the payment on their effective date, so the
 * recorded history remains untouched and only the forward projection changes.
 */
export function projectLoanFromEvents(input: EventDrivenLoanProjectionInput): LoanProjection {
  if (!(input.firstPaymentDate instanceof Date) || Number.isNaN(input.firstPaymentDate.getTime())) {
    return { rows: [], remainingPayments: 0, endDate: null, finalPayment: null };
  }

  const events = [...input.events]
    .filter((event) => isLoanEvent(event))
    .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
  let balance = input.principal;
  let annualRate = input.annualRate;
  let paymentAmount = input.paymentAmount;
  let frequency = input.frequency ?? "monthly";
  let paymentDate = input.firstPaymentDate;
  let eventIndex = 0;
  const rows: DatedLoanProjectionRow[] = [];
  const maxPayments = input.paymentCount;

  for (let index = 0; index < maxPayments && balance > 0; index += 1) {
    const paymentDay = formatProjectionDate(paymentDate);
    while (eventIndex < events.length && events[eventIndex].effectiveDate <= paymentDay) {
      const event = events[eventIndex];
      switch (event.type) {
        case "balance_correction":
          balance = event.balance;
          break;
        case "extra_repayment":
          balance = Math.max(0, balance - event.amount);
          break;
        case "rate_change":
          annualRate = event.annualRate;
          break;
        case "payment_change":
          paymentAmount = event.paymentAmount;
          break;
        case "payment_frequency_change":
          frequency = event.frequency;
          break;
        case "renewal":
          annualRate = event.annualRate;
          paymentAmount = event.paymentAmount ?? paymentAmount;
          frequency = event.frequency ?? frequency;
          break;
      }
      eventIndex += 1;
    }

    if (balance <= 0) break;
    const remainingPayments = Math.max(1, maxPayments - index);
    const payment =
      paymentAmount ??
      calculateLoanPayment({
        principal: balance,
        annualRate,
        paymentCount: remainingPayments,
        frequency,
      });
    if (payment === null || payment <= 0) break;

    const periodicRate = annualRate / 100 / getLoanPeriodsPerYear(frequency);
    const openingBalance = balance;
    const interest = openingBalance * periodicRate;
    const principal = Math.min(openingBalance, Math.max(0, payment - interest));
    balance = Math.max(0, openingBalance - principal);
    const row: DatedLoanProjectionRow = {
      paymentNumber: index + 1,
      openingBalance,
      interest,
      principal,
      payment,
      closingBalance: Math.round(balance * 100) / 100,
      paymentDate,
    };
    rows.push(row);

    paymentDate = nextProjectionDate(paymentDate, frequency);
  }

  return {
    rows,
    remainingPayments: rows.length,
    endDate: rows.at(-1)?.paymentDate ?? null,
    finalPayment: rows.at(-1) ?? null,
  };
}

function formatProjectionDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nextProjectionDate(date: Date, frequency: LoanPaymentFrequency): Date {
  if (frequency === "monthly") {
    const next = addMonths(date, 1);
    return isLastDayOfMonth(date) ? endOfMonth(next) : next;
  }
  return addDays(date, 14);
}
