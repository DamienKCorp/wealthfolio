import { Button, DataGrid, Icons, useDataGrid } from "@wealthfolio/ui";
import type { CellValidationState } from "@wealthfolio/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createColumnHelper } from "@tanstack/react-table";
import type { Quote } from "@/lib/types";
import { ValueHistoryToolbar } from "./value-history-toolbar";
import {
  EarlyRepaymentDialog,
  CloseLoanDialog,
  type EarlyRepaymentResult,
  type CloseLoanResult,
} from "./loan-action-dialogs";
import { format, addMonths, differenceInMonths } from "date-fns";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MIDNIGHT_REGEX = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.\d+)?Z$/;

// Parse YYYY-MM-DD as local midnight to avoid timezone shifts in date-only values.
const parseLocalDate = (dateOnly: string): Date => new Date(dateOnly + "T00:00:00");

// Preserve legacy non-midnight timestamps while treating canonical midnight UTC as date-only.
const parseCalendarDate = (value: string): Date => {
  const trimmed = value.trim();
  if (DATE_ONLY_REGEX.test(trimmed)) return parseLocalDate(trimmed);
  if (UTC_MIDNIGHT_REGEX.test(trimmed)) return parseLocalDate(trimmed.substring(0, 10));
  return new Date(trimmed);
};

// Helper to normalize date values (handles both Date objects and strings from DateCell)
const normalizeDate = (value: Date | string): Date => {
  if (value instanceof Date) return value;
  return parseCalendarDate(value);
};

// Round number to 2 decimal places (standard for alternative assets)
const roundToDecimals = (value: number): number => {
  return Math.round(value * 100) / 100;
};

/**
 * Metadata needed to compute an amortization schedule for a liability.
 */
export interface LiabilityAmortizationMeta {
  originalAmount: number;
  annualInterestRate: number;
  originationDate: Date;
  /** Total number of months in the loan */
  termMonths: number;
  /**
   * The loan's original principal (used to compute repaid% milestones).
   * Defaults to originalAmount when not set (standard full-schedule case).
   * Must be set when generating a post-repayment segment so milestones
   * reflect total repayment progress, not just progress within the segment.
   */
  totalLoanAmount?: number;
}

/**
 * One row of a computed amortization schedule.
 * autoNote stores machine tokens (e.g. "repaid:10|crossover") — never translated text.
 */
export interface AmortizationRow {
  date: Date;
  balance: number;
  interest: number;
  principal: number;
  autoNote: string;
}

/**
 * Translate a pipe-separated autoNote token string into a human-readable string.
 * Called at render time so it reacts to language changes.
 */
function translateAutoNote(
  token: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!token) return "";
  return token
    .split("|")
    .map((tok) => {
      if (tok.startsWith("repaid:")) {
        return t("asset:valueHistory.note_repaid", { percent: tok.slice(7) });
      }
      if (tok === "crossover") return t("asset:valueHistory.note_crossover");
      if (tok.startsWith("early_repayment:")) {
        return t("asset:valueHistory.note_early_repayment", { amount: tok.slice(16) });
      }
      if (tok.startsWith("saved_months:")) {
        return t("asset:valueHistory.note_saved_months", { months: tok.slice(13) });
      }
      if (tok.startsWith("new_payment:")) {
        return t("asset:valueHistory.note_new_payment", { amount: tok.slice(12) });
      }
      if (tok === "loan_closed") return t("asset:valueHistory.note_loan_closed");
      return tok;
    })
    .join(" · ");
}

/**
 * Compute a French amortization schedule (constant monthly payment).
 * Returns one row per monthly anniversary, starting from month 1.
 * autoNote stores machine tokens, not translated text.
 */
export function computeAmortizationSchedule(
  meta: LiabilityAmortizationMeta,
  /** Next milestone % to check (pass the value returned by the previous segment). */
  initialNextMilestone = 10,
): AmortizationRow[] {
  const { originalAmount, annualInterestRate, originationDate, termMonths } = meta;
  // totalLoanAmount drives the repaid-% milestones so they always measure progress
  // relative to the loan's original principal, not just the current segment balance.
  const totalLoanAmount = meta.totalLoanAmount ?? originalAmount;
  const monthlyRate = annualInterestRate / 100 / 12;
  const rows: AmortizationRow[] = [];

  const monthlyPayment =
    monthlyRate === 0
      ? originalAmount / termMonths
      : (originalAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));

  let balance = originalAmount;
  let nextMilestonePercent = initialNextMilestone;

  // Pre-check: if principal already exceeds interest on month 1, the crossover
  // already happened before this schedule segment — don't emit it again.
  const firstInterest = roundToDecimals(balance * monthlyRate);
  const firstPrincipal = roundToDecimals(Math.min(monthlyPayment - firstInterest, balance));
  let principalCrossoverDone = firstPrincipal > firstInterest;

  for (let m = 1; m <= termMonths; m++) {
    const interest = roundToDecimals(balance * monthlyRate);
    const principal = roundToDecimals(Math.min(monthlyPayment - interest, balance));
    balance = roundToDecimals(balance - principal);
    if (m === termMonths) balance = 0;

    const tokens: string[] = [];

    // Measure repaid-% against the total original loan amount, not the segment balance.
    const repaidPercent = ((totalLoanAmount - balance) / totalLoanAmount) * 100;
    while (nextMilestonePercent <= 100 && repaidPercent >= nextMilestonePercent) {
      tokens.push(`repaid:${nextMilestonePercent}`);
      nextMilestonePercent += 10;
    }

    if (!principalCrossoverDone && principal > interest) {
      tokens.push("crossover");
      principalCrossoverDone = true;
    }

    rows.push({
      date: addMonths(originationDate, m - 1),
      balance,
      interest,
      principal,
      autoNote: tokens.join("|"),
    });
  }

  return rows;
}

/**
 * Local representation of a value history entry for the data grid.
 * Maps from Quote but with simplified fields for alternative assets.
 */
export interface ValueHistoryEntry {
  id: string;
  date: Date;
  value: number;
  interest: number | null;
  principal: number | null;
  /** Machine tokens for auto-generated notes (e.g. "repaid:10|crossover"). Never translated text. */
  autoNote: string;
  /** User-written notes */
  notes: string;
  currency: string;
  isNew?: boolean;
}

interface ValueHistoryDataGridProps {
  /** Quote data from the backend */
  data: Quote[];
  /** Currency for the asset */
  currency: string;
  /** Whether this is a liability (changes "Value" to "Balance" label) */
  isLiability?: boolean;
  /** Amortization metadata — when present enables schedule generation and computed columns */
  liabilityMeta?: LiabilityAmortizationMeta;
  /** Callback to save a quote */
  onSaveQuote: (quote: Quote) => void;
  /** Callback to delete a quote */
  onDeleteQuote: (quoteId: string) => void;
}

// Generate a temporary ID for new entries
const generateTempId = () => `temp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

// Parse amortization data stored in quote notes.
// Full format:  "__amort:interest=X;principal=Y;auto=TOKENS__"
// Auto-only:    "__amort:auto=TOKENS__"
export const parseAmortizationNotes = (
  notes: string | null | undefined,
): { interest: number | null; principal: number | null; autoNote: string; userNotes: string } => {
  if (!notes) return { interest: null, principal: null, autoNote: "", userNotes: "" };
  // Full format (interest + principal + optional auto)
  const full = /^__amort:interest=([\d.]+);principal=([\d.]+)(?:;auto=(.*?))?__\n?(.*)/s.exec(
    notes,
  );
  if (full) {
    return {
      interest: parseFloat(full[1]),
      principal: parseFloat(full[2]),
      autoNote: full[3] ?? "",
      userNotes: full[4] ?? "",
    };
  }
  // Auto-only format (no interest/principal breakdown)
  const autoOnly = /^__amort:auto=(.*?)__\n?(.*)/s.exec(notes);
  if (autoOnly) {
    return { interest: null, principal: null, autoNote: autoOnly[1], userNotes: autoOnly[2] ?? "" };
  }
  return { interest: null, principal: null, autoNote: "", userNotes: notes };
};

// Serialize amortization data back into the notes field
export const serializeAmortizationNotes = (
  interest: number | null,
  principal: number | null,
  autoNote: string,
  userNotes: string,
): string | undefined => {
  if (interest === null || principal === null) {
    // No amort breakdown, but still encode autoNote if present
    if (!autoNote) return userNotes || undefined;
    const prefix = `__amort:auto=${autoNote}__`;
    return userNotes ? `${prefix}\n${userNotes}` : prefix;
  }
  const autoSegment = autoNote ? `;auto=${autoNote}` : "";
  const prefix = `__amort:interest=${interest};principal=${principal}${autoSegment}__`;
  return userNotes ? `${prefix}\n${userNotes}` : prefix;
};

// Convert Quote to ValueHistoryEntry with rounding
const toValueHistoryEntry = (quote: Quote): ValueHistoryEntry => {
  const { interest, principal, autoNote, userNotes } = parseAmortizationNotes(quote.notes);
  return {
    id: quote.id,
    date: parseCalendarDate(quote.timestamp),
    value: roundToDecimals(quote.close),
    interest,
    principal,
    autoNote,
    notes: userNotes,
    currency: quote.currency,
    isNew: false,
  };
};

// Convert ValueHistoryEntry back to Quote for saving
const toQuote = (entry: ValueHistoryEntry, symbol: string): Quote => {
  const datePart = format(entry.date, "yyyy-MM-dd").replace(/-/g, "");
  return {
    id: entry.id.startsWith("temp-") ? `${datePart}_${symbol.toUpperCase()}` : entry.id,
    createdAt: new Date().toISOString(),
    dataSource: "MANUAL",
    timestamp: format(entry.date, "yyyy-MM-dd'T'00:00:00'Z'"),
    assetId: symbol,
    open: entry.value,
    high: entry.value,
    low: entry.value,
    volume: 0,
    close: entry.value,
    adjclose: entry.value,
    currency: entry.currency,
    notes: serializeAmortizationNotes(entry.interest, entry.principal, entry.autoNote, entry.notes),
  };
};

// Create draft entry
const createDraftEntry = (currency: string): ValueHistoryEntry => ({
  id: generateTempId(),
  date: new Date(),
  value: 0,
  interest: null,
  principal: null,
  autoNote: "",
  notes: "",
  currency,
  isNew: true,
});

export function ValueHistoryDataGrid({
  data,
  currency,
  isLiability = false,
  liabilityMeta,
  onSaveQuote,
  onDeleteQuote,
}: ValueHistoryDataGridProps) {
  const { t } = useTranslation();
  // Convert quotes to local entries
  const initialEntries = useMemo(
    () => data.map(toValueHistoryEntry).sort((a, b) => b.date.getTime() - a.date.getTime()),
    [data],
  );

  const [localEntries, setLocalEntries] = useState<ValueHistoryEntry[]>(initialEntries);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // Ref mirrors dirty/deleted state so the sync effect can read it without
  // adding those sets as deps (which would re-run the effect on every edit).
  const hasPendingChangesRef = useRef(false);
  hasPendingChangesRef.current = dirtyIds.size > 0 || deletedIds.size > 0;

  // Sync with external data changes — only when there are no local edits in flight.
  useEffect(() => {
    if (hasPendingChangesRef.current) return;
    setLocalEntries(initialEntries);
  }, [initialEntries]);

  // Track if there are unsaved changes
  const hasUnsavedChanges = dirtyIds.size > 0 || deletedIds.size > 0;

  // Get assetId from first quote or use empty string
  const symbol = data[0]?.assetId ?? "";

  // Whether amortization schedule can be generated
  const canGenerateSchedule = isLiability && liabilityMeta !== undefined;

  // Generate full amortization schedule — resets the loan from scratch using
  // original metadata, discarding any early repayments.
  const handleGenerateSchedule = useCallback(() => {
    if (!liabilityMeta) return;
    const schedule = computeAmortizationSchedule(liabilityMeta);
    const generated: ValueHistoryEntry[] = schedule.map((row) => ({
      id: generateTempId(),
      date: row.date,
      value: row.balance,
      interest: row.interest,
      principal: row.principal,
      autoNote: row.autoNote,
      notes: "",
      currency,
      isNew: true,
    }));
    // Mark every persisted quote for deletion so the backend is fully reset.
    const toDelete = new Set(localEntries.filter((e) => !e.isNew).map((e) => e.id));
    setLocalEntries(generated);
    setDirtyIds(new Set(generated.map((e) => e.id)));
    setDeletedIds(toDelete);
  }, [liabilityMeta, currency, localEntries]);

  // Dialog open states
  const [earlyRepaymentOpen, setEarlyRepaymentOpen] = useState(false);
  const [closeLoanOpen, setCloseLoanOpen] = useState(false);

  // Handle early repayment: insert a row with reduced balance + regenerate future schedule
  const handleEarlyRepayment = useCallback(
    (result: EarlyRepaymentResult) => {
      if (!liabilityMeta) return;

      const monthlyRate = liabilityMeta.annualInterestRate / 100 / 12;

      // --- 1. Find balance at the repayment date ---
      // Use the last scheduled entry on or before the repayment date.
      const sorted = [...localEntries].sort((a, b) => a.date.getTime() - b.date.getTime());
      const prevEntry = sorted.filter((e) => e.date <= result.date).at(-1);
      const balanceBeforeRepayment = prevEntry?.value ?? liabilityMeta.originalAmount;
      const newBalance = Math.max(0, balanceBeforeRepayment - result.amount);

      // --- 2. Find the next scheduled anniversary AFTER the repayment date ---
      // The schedule resumes from that date so day-of-month never shifts.
      // monthsElapsed counts whole months from origination to repayment date.
      const monthsElapsed = differenceInMonths(result.date, liabilityMeta.originationDate);
      // Next anniversary = origination + (elapsed + 1) months
      const nextAnniversary = addMonths(liabilityMeta.originationDate, monthsElapsed + 1);
      // Months remaining in the original schedule from that next anniversary
      const originalRemainingFromNext = liabilityMeta.termMonths - (monthsElapsed + 1);

      // --- 3. Compute new schedule parameters ---
      // The current scheduled monthly payment (based on original amount/term, unchanged)
      const scheduledMonthlyPayment =
        monthlyRate === 0
          ? liabilityMeta.originalAmount / liabilityMeta.termMonths
          : (liabilityMeta.originalAmount * monthlyRate) /
            (1 - Math.pow(1 + monthlyRate, -liabilityMeta.termMonths));

      let newTermMonths: number;
      let newMonthlyPayment: number;

      if (result.mode === "reduce_payment") {
        // Same remaining duration, recalculate payment from new balance
        newTermMonths = Math.max(1, originalRemainingFromNext);
        newMonthlyPayment =
          monthlyRate === 0
            ? newBalance / newTermMonths
            : (newBalance * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -newTermMonths));
      } else {
        // reduce_duration: keep same payment, shorten the term
        if (monthlyRate === 0 || newBalance <= 0) {
          newTermMonths = Math.max(1, Math.ceil(newBalance / scheduledMonthlyPayment));
        } else {
          newTermMonths = Math.max(
            1,
            Math.ceil(
              -Math.log(1 - (newBalance * monthlyRate) / scheduledMonthlyPayment) /
                Math.log(1 + monthlyRate),
            ),
          );
        }
        newMonthlyPayment = scheduledMonthlyPayment;
      }

      // --- 4. Impact token for the note ---
      const savedMonths = Math.max(0, originalRemainingFromNext - newTermMonths);
      const impactToken =
        result.mode === "reduce_payment"
          ? `new_payment:${Math.round(newMonthlyPayment)}`
          : `saved_months:${savedMonths}`;

      // --- 5. Regenerate the future schedule starting from nextAnniversary ---
      const totalLoanAmount = liabilityMeta.totalLoanAmount ?? liabilityMeta.originalAmount;
      // Pick up milestone tracking where the pre-repayment schedule left off.
      const repaidSoFar = ((totalLoanAmount - newBalance) / totalLoanAmount) * 100;
      const initialNextMilestone = Math.ceil(repaidSoFar / 10) * 10;

      const newMeta: LiabilityAmortizationMeta = {
        ...liabilityMeta,
        originalAmount: newBalance,
        originationDate: nextAnniversary,
        termMonths: newTermMonths,
        annualInterestRate: liabilityMeta.annualInterestRate,
        totalLoanAmount,
      };
      const futureSchedule = computeAmortizationSchedule(newMeta, initialNextMilestone);

      // Tag the first future entry with the repayment annotation so it appears
      // on a proper monthly date and the chart stays a smooth curve.
      const futureEntries: ValueHistoryEntry[] = futureSchedule.map((row) => ({
        id: generateTempId(),
        date: row.date,
        value: row.balance,
        interest: row.interest,
        principal: row.principal,
        autoNote: row.autoNote,
        notes: "",
        currency,
        isNew: true,
      }));

      // --- 6. Balance snapshot at the repayment date ---
      // This quote becomes the "latest as-of-today" value the backend reads for
      // the header and detail panel. It carries no interest/principal breakdown
      // so it is treated as a plain balance update, not a scheduled instalment.
      // If an existing entry already sits on that exact date (e.g. the monthly
      // instalment fell on the same day), replace it rather than duplicating
      // (two quotes with the same date produce the same SQLite ID, causing a collision).
      const repaymentDateMs = result.date.getTime();
      const repaymentEntry: ValueHistoryEntry = {
        id: generateTempId(),
        date: result.date,
        value: newBalance,
        interest: null,
        principal: null,
        autoNote: [`early_repayment:${result.amount}`, impactToken].join("|"),
        notes: "",
        currency,
        isNew: true,
      };

      // --- 7. Assemble ---
      // Keep every existing entry strictly before the repayment date (those are
      // unaffected history). Any entry on or after the repayment date is replaced
      // by: repaymentEntry (balance snapshot) + regenerated schedule.
      const beforeRepayment = localEntries.filter((e) => e.date.getTime() < repaymentDateMs);
      const newEntries = [...beforeRepayment, repaymentEntry, ...futureEntries];

      setLocalEntries(newEntries);
      setDirtyIds(new Set(newEntries.filter((e) => e.isNew).map((e) => e.id)));

      // Delete all existing (non-new) entries from the repayment date onward.
      const removedIds = localEntries
        .filter((e) => !e.isNew && e.date.getTime() >= repaymentDateMs)
        .map((e) => e.id);
      setDeletedIds(new Set(removedIds));
    },
    [liabilityMeta, localEntries, currency],
  );

  // Handle loan closure: insert balance=0 row and drop all future entries
  const handleCloseLoan = useCallback(
    (result: CloseLoanResult) => {
      // Cap the closure date to today so the quote is always the most recent one
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const closureDate = result.date > today ? today : result.date;

      const closureEntry: ValueHistoryEntry = {
        id: generateTempId(),
        date: closureDate,
        value: 0,
        interest: null,
        principal: null,
        autoNote: "loan_closed",
        notes: "",
        currency,
        isNew: true,
      };

      const pastEntries = localEntries.filter((e) => e.date < closureDate);
      const newEntries = [...pastEntries, closureEntry];

      setLocalEntries(newEntries);
      setDirtyIds(new Set(newEntries.filter((e) => e.isNew).map((e) => e.id)));
      const removedIds = localEntries
        .filter((e) => !e.isNew && e.date >= closureDate)
        .map((e) => e.id);
      setDeletedIds(new Set(removedIds));
    },
    [localEntries, currency],
  );

  // Column definitions
  const columnHelper = createColumnHelper<ValueHistoryEntry>();

  // Delete a single row
  const handleDeleteRow = useCallback((entry: ValueHistoryEntry) => {
    if (entry.isNew) {
      // Remove new entries immediately
      setLocalEntries((prev) => prev.filter((e) => e.id !== entry.id));
      setDirtyIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    } else {
      // Mark existing entries for deletion
      setDeletedIds((prev) => new Set(prev).add(entry.id));
      setLocalEntries((prev) => prev.filter((e) => e.id !== entry.id));
    }
  }, []);

  const columns = useMemo(
    () => [
      columnHelper.accessor("date", {
        header: t("asset:valueHistory.date"),
        size: 140,
        meta: { cell: { variant: "date-input" } },
      }),
      columnHelper.accessor("value", {
        header: isLiability ? t("asset:valueHistory.balance") : t("asset:valueHistory.value"),
        size: 180,
        meta: { cell: { variant: "number", min: 0 } },
      }),
      ...(isLiability
        ? [
            columnHelper.accessor("interest", {
              header: t("asset:valueHistory.interest"),
              size: 150,
              enableSorting: false,
              cell: ({ getValue }) => {
                const v = getValue();
                return v !== null && v !== undefined ? (
                  <span className="flex size-full items-center justify-end tabular-nums">
                    {v.toFixed(2)}
                  </span>
                ) : (
                  <span className="text-muted-foreground flex size-full items-center justify-end text-xs">
                    —
                  </span>
                );
              },
            }),
            columnHelper.accessor("principal", {
              header: t("asset:valueHistory.principal"),
              size: 150,
              enableSorting: false,
              cell: ({ getValue }) => {
                const v = getValue();
                return v !== null && v !== undefined ? (
                  <span className="flex size-full items-center justify-end tabular-nums">
                    {v.toFixed(2)}
                  </span>
                ) : (
                  <span className="text-muted-foreground flex size-full items-center justify-end text-xs">
                    —
                  </span>
                );
              },
            }),
          ]
        : []),
      // Read-only column showing auto-generated annotations (autoNote tokens).
      columnHelper.display({
        id: "autoNote",
        header: () => t("asset:valueHistory.auto_note"),
        size: 220,
        enableSorting: false,
        enableResizing: false,
        cell: ({ row }) => {
          const label = translateAutoNote(row.original.autoNote, t);
          if (!label) return null;
          return (
            <span className="text-muted-foreground flex size-full items-center px-2 text-sm italic">
              {label}
            </span>
          );
        },
      }),
      // Editable user notes column — uses LongTextCell so the grid's inline
      // editing (popover textarea) works normally.
      columnHelper.accessor("notes", {
        header: t("asset:valueHistory.notes"),
        size: 220,
        meta: { cell: { variant: "long-text" } },
      }),
      // Actions column with delete button
      columnHelper.display({
        id: "actions",
        header: () => null,
        size: 50,
        enableSorting: false,
        enableResizing: false,
        enableHiding: false,
        cell: ({ row }) => (
          <div className="flex size-full items-center justify-center">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-7 w-7"
              onClick={() => handleDeleteRow(row.original)}
            >
              <Icons.X className="h-4 w-4" />
            </Button>
          </div>
        ),
      }),
    ],
    [columnHelper, isLiability, handleDeleteRow, t],
  );

  // Handle data changes from the grid
  const onDataChange = useCallback((nextData: ValueHistoryEntry[]) => {
    setLocalEntries((prev) => {
      const prevById = new Map(prev.map((e) => [e.id, e]));
      const changedIds: string[] = [];

      const updated = nextData.map((entry) => {
        const previous = prevById.get(entry.id);
        const normalizedDate = normalizeDate(entry.date);

        if (!previous) {
          changedIds.push(entry.id);
          return { ...entry, date: normalizedDate };
        }

        // Check if any editable field changed
        const dateChanged = normalizedDate.getTime() !== previous.date.getTime();
        const valueChanged = entry.value !== previous.value;
        const notesChanged = entry.notes !== previous.notes;

        if (dateChanged || valueChanged || notesChanged) {
          changedIds.push(entry.id);
          // Merge onto previous to preserve non-column fields (autoNote, interest, principal, currency, isNew)
          return {
            ...previous,
            date: normalizedDate,
            value: entry.value,
            notes: entry.notes,
          };
        }

        return previous;
      });

      if (changedIds.length > 0) {
        setDirtyIds((prev) => {
          const next = new Set(prev);
          changedIds.forEach((id) => next.add(id));
          return next;
        });
      }

      return updated;
    });
  }, []);

  // Add a new row
  const onRowAdd = useCallback(() => {
    const draft = createDraftEntry(currency);
    setLocalEntries((prev) => [draft, ...prev]);
    setDirtyIds((prev) => new Set(prev).add(draft.id));
    return { rowIndex: 0, columnId: "date" };
  }, [currency]);

  // Add multiple rows
  const onRowsAdd = useCallback(
    (count: number) => {
      if (count <= 0) return;
      const drafts = Array.from({ length: count }, () => createDraftEntry(currency));
      setLocalEntries((prev) => [...drafts, ...prev]);
      setDirtyIds((prev) => {
        const next = new Set(prev);
        drafts.forEach((d) => next.add(d.id));
        return next;
      });
    },
    [currency],
  );

  // Delete rows
  const onRowsDelete = useCallback((rowsToDelete: ValueHistoryEntry[]) => {
    if (rowsToDelete.length === 0) return;

    const newIds = rowsToDelete.filter((r) => r.isNew).map((r) => r.id);
    const existingIds = rowsToDelete.filter((r) => !r.isNew).map((r) => r.id);

    // Remove new entries immediately
    if (newIds.length > 0) {
      setLocalEntries((prev) => prev.filter((e) => !newIds.includes(e.id)));
      setDirtyIds((prev) => {
        const next = new Set(prev);
        newIds.forEach((id) => next.delete(id));
        return next;
      });
    }

    // Mark existing entries for deletion
    if (existingIds.length > 0) {
      setDeletedIds((prev) => {
        const next = new Set(prev);
        existingIds.forEach((id) => next.add(id));
        return next;
      });
      setLocalEntries((prev) => prev.filter((e) => !existingIds.includes(e.id)));
    }
  }, []);

  // Initialize data grid
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  // Stable ref so getCellState can read the table without a circular dep
  const tableRef = useRef<ReturnType<typeof useDataGrid<ValueHistoryEntry>>["table"] | null>(null);

  const getCellState = useCallback(
    (rowIndex: number, _columnId: string): CellValidationState | null => {
      const row = tableRef.current?.getRowModel().rows[rowIndex];
      if (!row) return null;
      if (row.original.date < today) return { type: "success", messages: [] };
      return null;
    },
    [today],
  );

  const dataGrid = useDataGrid<ValueHistoryEntry>({
    data: localEntries,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableMultiRowSelection: true,
    enableSorting: true,
    enableSearch: true,
    enablePaste: true,
    onDataChange,
    onRowAdd,
    onRowsAdd,
    onRowsDelete,
    meta: { getCellState },
    initialState: {
      sorting: [{ id: "date", desc: true }],
    },
  });

  // Keep ref in sync after each render
  tableRef.current = dataGrid.table;

  const selectedRowCount = dataGrid.table.getSelectedRowModel().rows.length;

  // Delete selected rows
  const handleDeleteSelected = useCallback(() => {
    const selected = dataGrid.table.getSelectedRowModel().rows;
    if (selected.length === 0) return;
    onRowsDelete(selected.map((row) => row.original));
    dataGrid.table.resetRowSelection();
  }, [dataGrid.table, onRowsDelete]);

  // Save all changes
  const handleSave = useCallback(() => {
    // Collect the IDs that the new entries will claim after save
    const incomingIds = new Set(
      localEntries
        .filter((e) => dirtyIds.has(e.id))
        .map((e) => {
          if (e.id.startsWith("temp-")) {
            const datePart = format(e.date, "yyyy-MM-dd").replace(/-/g, "");
            return `${datePart}_${symbol.toUpperCase()}`;
          }
          return e.id;
        }),
    );

    // Delete first — skip any old entry whose ID will be re-created by a new entry
    // to avoid a delete-after-upsert race that wipes the freshly saved quote.
    for (const id of deletedIds) {
      if (!id.startsWith("temp-") && !incomingIds.has(id)) {
        onDeleteQuote(id);
      }
    }

    // Then upsert
    for (const entry of localEntries) {
      if (dirtyIds.has(entry.id)) {
        const quote = toQuote(entry, symbol);
        onSaveQuote(quote);
      }
    }

    // Reset state
    setDirtyIds(new Set());
    setDeletedIds(new Set());
  }, [localEntries, dirtyIds, deletedIds, symbol, onSaveQuote, onDeleteQuote]);

  // Cancel changes
  const handleCancel = useCallback(() => {
    setLocalEntries(initialEntries);
    setDirtyIds(new Set());
    setDeletedIds(new Set());
    dataGrid.table.resetRowSelection();
  }, [initialEntries, dataGrid.table]);

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-3">
      <ValueHistoryToolbar
        selectedRowCount={selectedRowCount}
        hasUnsavedChanges={hasUnsavedChanges}
        dirtyCount={dirtyIds.size}
        deletedCount={deletedIds.size}
        onAddRow={() => dataGrid.onRowAdd?.()}
        onDeleteSelected={handleDeleteSelected}
        onSave={handleSave}
        onCancel={handleCancel}
        isLiability={isLiability}
        canGenerateSchedule={canGenerateSchedule}
        onGenerateSchedule={handleGenerateSchedule}
        onEarlyRepayment={
          isLiability && liabilityMeta ? () => setEarlyRepaymentOpen(true) : undefined
        }
        onCloseLoan={isLiability ? () => setCloseLoanOpen(true) : undefined}
      />

      <EarlyRepaymentDialog
        open={earlyRepaymentOpen}
        onOpenChange={setEarlyRepaymentOpen}
        onConfirm={handleEarlyRepayment}
      />

      <CloseLoanDialog
        open={closeLoanOpen}
        onOpenChange={setCloseLoanOpen}
        onConfirm={handleCloseLoan}
      />

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border">
        <DataGrid {...dataGrid} stretchColumns height="calc(100vh - 340px)" />
      </div>
    </div>
  );
}

export default ValueHistoryDataGrid;
