import { describe, expect, it } from "vitest";
import {
  classifyLoanBalance,
  getConfirmedLoanBalances,
  getProjectedLoanBalances,
  isConfirmedLoanBalance,
  loanEventProvenance,
} from "./loan-balance";

const entry = (notes?: string) => ({
  timestamp: "2026-01-01T00:00:00Z",
  close: 100,
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
});
