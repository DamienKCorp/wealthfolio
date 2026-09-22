import { addMonths, format } from "date-fns";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Quote } from "@/lib/types";
import { AmountDisplay } from "@wealthfolio/ui";
import { readLoanEvents, readLoanProjectionMetadata } from "../lib/loan-events";
import { getLatestCurrentLoanBalance } from "../lib/loan-balance";
import { projectLoanFromEvents } from "../lib/loan-calculator";

interface LoanAmortizationScheduleProps {
  quoteHistory: Quote[];
  metadata: Record<string, unknown>;
  currency: string;
}

export function LoanAmortizationSchedule({
  quoteHistory,
  metadata,
  currency,
}: LoanAmortizationScheduleProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const projection = readLoanProjectionMetadata(metadata);
    if (!projection) return [];
    const latest = getLatestCurrentLoanBalance(quoteHistory);
    if (!latest) return [];
    const balance = Math.abs(latest.close);
    if (balance <= 0) return [];
    const lastDate = new Date(latest.timestamp);
    const firstPaymentDate = addMonths(lastDate, 1);
    const paymentCount = Math.max(
      1,
      projection.paymentCount ??
        Math.ceil(
          (new Date(projection.termEndDate ?? projection.firstPaymentDate).getTime() -
            firstPaymentDate.getTime()) /
            (30 * 24 * 60 * 60 * 1000),
        ),
    );
    const projected = projectLoanFromEvents({
      principal: balance,
      annualRate: projection.annualRate,
      paymentAmount: projection.paymentAmount,
      paymentCount,
      frequency: projection.frequency,
      firstPaymentDate,
      // The current balance already includes events up to the latest quote;
      // replay only events that become effective after that snapshot.
      events: readLoanEvents(metadata).filter(
        (event) => event.effectiveDate > latest.timestamp.slice(0, 10),
      ),
    });
    return [
      ...quoteHistory
        .filter((quote) => new Date(quote.timestamp) <= new Date())
        .sort(
          (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
        )
        .map((quote) => ({
          date: new Date(quote.timestamp),
          payment: undefined,
          principal: undefined,
          interest: undefined,
          balance: Math.abs(quote.close),
          projected: false,
        })),
      ...projected.rows.map((row) => ({
        date: row.paymentDate,
        payment: row.payment,
        principal: row.principal,
        interest: row.interest,
        balance: row.closingBalance,
        projected: true,
      })),
    ];
  }, [metadata, quoteHistory]);

  if (rows.length === 0) return null;

  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="font-semibold">{t("asset:valueHistory.balance")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("asset:loanActions.recalculate_description")}
        </p>
      </div>
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0 z-10">
            <tr className="text-muted-foreground text-left">
              <th className="px-4 py-2">{t("asset:valueHistory.date")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.balance")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.capital")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.interest")}</th>
              <th className="px-4 py-2 text-right">{t("asset:valueHistory.notes")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.date.toISOString()}-${index}`} className="border-t">
                <td className="px-4 py-2">{format(row.date, "dd/MM/yyyy")}</td>
                <td className="px-4 py-2 text-right">
                  <AmountDisplay value={row.balance} currency={currency} />
                </td>
                <td className="px-4 py-2 text-right">
                  {row.principal === undefined ? (
                    "—"
                  ) : (
                    <AmountDisplay value={row.principal} currency={currency} />
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  {row.interest === undefined ? (
                    "—"
                  ) : (
                    <AmountDisplay value={row.interest} currency={currency} />
                  )}
                </td>
                <td className="text-muted-foreground px-4 py-2 text-right">
                  {row.projected
                    ? t("asset:loanActions.recalculate_schedule")
                    : t("asset:valueHistory.notes")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
