import { addMonths } from "date-fns";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AmountDisplay } from "@wealthfolio/ui";
import type { Quote } from "@/lib/types";
import { getLatestCurrentLoanBalance } from "../lib/loan-balance";
import { readLoanEvents, readLoanProjectionMetadata } from "../lib/loan-events";
import { projectLoanFromEvents } from "../lib/loan-calculator";

interface LoanProgressSummaryProps {
  originalAmount: number;
  currentBalance: number;
  totalInterestPaid: number | null;
  quoteHistory: Quote[];
  metadata: Record<string, unknown>;
  currency: string;
}

export function LoanProgressSummary({
  originalAmount,
  currentBalance,
  totalInterestPaid,
  quoteHistory,
  metadata,
  currency,
}: LoanProgressSummaryProps) {
  const { t } = useTranslation();
  const summary = useMemo(() => {
    const paidPrincipal = Math.min(originalAmount, Math.max(0, originalAmount - currentBalance));
    const projection = readLoanProjectionMetadata(metadata);
    const latest = getLatestCurrentLoanBalance(quoteHistory);
    let projectedInterest = 0;
    if (projection && latest && currentBalance > 0) {
      const firstPaymentDate = addMonths(new Date(latest.timestamp), 1);
      const paymentCount = projection.paymentCount ?? 1;
      projectedInterest = projectLoanFromEvents({
        principal: currentBalance,
        annualRate: projection.annualRate,
        paymentAmount: projection.paymentAmount,
        paymentCount,
        frequency: projection.frequency,
        firstPaymentDate,
        events: readLoanEvents(metadata).filter(
          (event) => event.effectiveDate > latest.timestamp.slice(0, 10),
        ),
      }).rows.reduce((sum, row) => sum + row.interest, 0);
    }
    const progress = originalAmount > 0 ? Math.min(1, paidPrincipal / originalAmount) : 0;
    return { paidPrincipal, projectedInterest, progress };
  }, [currentBalance, metadata, originalAmount, quoteHistory]);

  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - summary.progress);

  return (
    <div className="bg-card flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center">
      <div className="relative h-28 w-28 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="10"
            className="text-muted"
          />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="text-primary transition-all"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-lg font-semibold">{Math.round(summary.progress * 100)}%</span>
          <span className="text-muted-foreground text-[10px]">
            {t("asset:valueHistory.capital")}
          </span>
        </div>
      </div>
      <div className="grid flex-1 grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <Metric
          label={t("asset:valueHistory.capital")}
          value={summary.paidPrincipal}
          currency={currency}
        />
        <Metric
          label={t("asset:valueHistory.balance")}
          value={currentBalance}
          currency={currency}
        />
        <Metric
          label={t("asset:valueHistory.interest")}
          value={totalInterestPaid ?? 0}
          currency={currency}
        />
        <Metric
          label={t("asset:loanActions.recalculate_description")}
          value={summary.projectedInterest}
          currency={currency}
        />
      </div>
    </div>
  );
}

function Metric({ label, value, currency }: { label: string; value: number; currency: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="font-medium">
        <AmountDisplay value={value} currency={currency} />
      </div>
    </div>
  );
}
