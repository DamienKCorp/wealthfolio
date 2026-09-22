import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
  calculateLoanEndDate,
  calculateLoanPayment,
  calculateRemainingPayments,
  projectLoan,
  projectLoanSchedule,
} from "./loan-calculator";

describe("loan calculator", () => {
  it("calculates a fixed monthly payment", () => {
    expect(
      calculateLoanPayment({ principal: 100_000, annualRate: 3.6, paymentCount: 240 }),
    ).toBeCloseTo(585.11, 2);
  });

  it("returns the full principal and interest breakdown", () => {
    const projection = projectLoan({ principal: 1_200, annualRate: 0, paymentCount: 3 });

    expect(projection).toHaveLength(3);
    expect(projection.map((row) => row.closingBalance)).toEqual([800, 400, 0]);
    expect(projection.reduce((sum, row) => sum + row.principal, 0)).toBe(1_200);
    expect(projection.reduce((sum, row) => sum + row.interest, 0)).toBe(0);
  });

  it("uses an explicit payment while keeping the accounting invariant", () => {
    const projection = projectLoan({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 3,
      paymentAmount: 400,
    });

    expect(projection.map((row) => row.closingBalance)).toEqual([600, 200, 0]);
    expect(projection.every((row) => row.payment === 400)).toBe(true);
  });

  it("rejects invalid inputs", () => {
    expect(projectLoan({ principal: -1, annualRate: 3, paymentCount: 12 })).toEqual([]);
    expect(calculateLoanPayment({ principal: 1_000, annualRate: 3, paymentCount: 0 })).toBeNull();
  });

  it("calculates remaining payments and contractual end dates", () => {
    expect(calculateRemainingPayments(10_000, 0, 500)).toBe(20);
    expect(calculateRemainingPayments(100_000, 12, 500)).toBeNull();
    expect(format(calculateLoanEndDate(new Date(2026, 0, 31), 3)!, "yyyy-MM-dd")).toBe(
      "2026-03-31",
    );
  });

  it("returns dated rows, the end date, and the final payment", () => {
    const projection = projectLoanSchedule({
      principal: 1_200,
      annualRate: 0,
      paymentCount: 3,
      firstPaymentDate: new Date(2026, 0, 31),
    });

    expect(projection.remainingPayments).toBe(3);
    expect(projection.rows.map((row) => format(row.paymentDate, "yyyy-MM-dd"))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(format(projection.endDate!, "yyyy-MM-dd")).toBe("2026-03-31");
    expect(projection.finalPayment?.closingBalance).toBe(0);
  });
});
