import { describe, expect, it } from "vitest";
import {
  classifyLoanBalance,
  getConfirmedLoanBalances,
  getCurrentLoanBalances,
  getLatestCurrentLoanBalance,
  getProjectedLoanBalances,
  isConfirmedLoanBalance,
  loanEventProvenance,
} from "./loan-balance";

const entry = (notes?: string, timestamp = "2026-01-01T00:00:00Z", close = 100) => ({
  timestamp,
  close,
  notes,
});

describe("loan balance provenance", () => {
  it("distinguishes generated projections from confirmed balances", () => {
    expect(classifyLoanBalance(entry("loan_schedule|rate=3|payment=100"))).toBe(
      "projected_balance",
    );
    expect(classifyLoanBalance(entry("scheduled_payoff"))).toBe("projected_balance");
    expect(classifyLoanBalance(entry())).toBe("confirmed_balance");
    expect(isConfirmedLoanBalance(entry())).toBe(true);
    expect(isConfirmedLoanBalance(entry("loan_schedule"))).toBe(false);
  });

  it("keeps dated corrections and repayments as confirmed inputs", () => {
    expect(classifyLoanBalance(entry(loanEventProvenance("balance_correction")))).toBe(
      "balance_correction",
    );
    expect(classifyLoanBalance(entry(loanEventProvenance("extra_repayment")))).toBe(
      "extra_repayment",
    );
  });

  it("splits confirmed inputs from projections without mutating entries", () => {
    const entries = [entry(), entry("loan_schedule|rate=3|payment=100")];
    expect(getConfirmedLoanBalances(entries)).toHaveLength(1);
    expect(getProjectedLoanBalances(entries)).toHaveLength(1);
    expect(entries).toHaveLength(2);
  });

  it("ignores legacy future schedule rows in the compatibility view", () => {
    const entries = [
      entry(undefined, "2026-09-01T00:00:00Z", 100),
      entry("loan_schedule", "2026-10-01T00:00:00Z", 90),
      entry("loan_schedule", "2026-08-01T00:00:00Z", 110),
    ];
    const now = new Date("2026-09-15T00:00:00Z");

    expect(getCurrentLoanBalances(entries, now)).toHaveLength(2);
    expect(getLatestCurrentLoanBalance(entries, now)?.close).toBe(100);
  });
});
