import { isValid, parseISO } from "date-fns";

export const LOAN_EVENTS_METADATA_KEY = "loan_events";

export type LoanPaymentFrequency = "monthly" | "biweekly" | "accelerated_biweekly";

export interface LoanBalanceCorrectionEvent {
  type: "balance_correction";
  effectiveDate: string;
  balance: number;
  note?: string;
}

export interface LoanExtraRepaymentEvent {
  type: "extra_repayment";
  effectiveDate: string;
  amount: number;
  note?: string;
}

export interface LoanRateChangeEvent {
  type: "rate_change";
  effectiveDate: string;
  annualRate: number;
  note?: string;
}

export interface LoanPaymentChangeEvent {
  type: "payment_change";
  effectiveDate: string;
  paymentAmount: number;
  note?: string;
}

export interface LoanFrequencyChangeEvent {
  type: "payment_frequency_change";
  effectiveDate: string;
  frequency: LoanPaymentFrequency;
  note?: string;
}

export interface LoanRenewalEvent {
  type: "renewal";
  effectiveDate: string;
  annualRate: number;
  paymentAmount?: number;
  frequency?: LoanPaymentFrequency;
  termEndDate?: string;
  note?: string;
}

export type LoanEvent =
  | LoanBalanceCorrectionEvent
  | LoanExtraRepaymentEvent
  | LoanRateChangeEvent
  | LoanPaymentChangeEvent
  | LoanFrequencyChangeEvent
  | LoanRenewalEvent;

export type LoanMetadata = Record<string, unknown>;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isValid(parseISO(value));
}

function isFrequency(value: unknown): value is LoanPaymentFrequency {
  return value === "monthly" || value === "biweekly" || value === "accelerated_biweekly";
}

/** Validate persisted loan events before they are used by the calculation engine. */
export function isLoanEvent(value: unknown): value is LoanEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isIsoDate(event.effectiveDate)) return false;

  switch (event.type) {
    case "balance_correction":
      return isFiniteNonNegative(event.balance);
    case "extra_repayment":
      return isFiniteNonNegative(event.amount) && event.amount > 0;
    case "rate_change":
      return isFiniteNonNegative(event.annualRate);
    case "payment_change":
      return isFiniteNonNegative(event.paymentAmount) && event.paymentAmount > 0;
    case "payment_frequency_change":
      return isFrequency(event.frequency);
    case "renewal":
      return (
        isFiniteNonNegative(event.annualRate) &&
        (event.paymentAmount === undefined ||
          (isFiniteNonNegative(event.paymentAmount) && event.paymentAmount > 0)) &&
        (event.frequency === undefined || isFrequency(event.frequency)) &&
        (event.termEndDate === undefined || isIsoDate(event.termEndDate))
      );
    default:
      return false;
  }
}

/** Read only valid events, keeping malformed legacy metadata out of calculations. */
export function readLoanEvents(metadata: LoanMetadata | null | undefined): LoanEvent[] {
  const raw = metadata?.[LOAN_EVENTS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];

  return raw
    .filter(isLoanEvent)
    .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
}

/** Return metadata with a validated event appended without mutating the input. */
export function appendLoanEvent(metadata: LoanMetadata, event: LoanEvent): LoanMetadata {
  if (!isLoanEvent(event)) {
    throw new Error("Invalid loan event");
  }

  return {
    ...metadata,
    [LOAN_EVENTS_METADATA_KEY]: [...readLoanEvents(metadata), event].sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate),
    ),
  };
}
