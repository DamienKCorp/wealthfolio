import { Button, DataGrid, Icons, useDataGrid } from "@wealthfolio/ui";
import type { CellValidationState } from "@wealthfolio/ui";
import { useCallback, useMemo, useRef, useState } from "react";
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
}

/**
 * One row of a computed amortization schedule.
 * autoNote stores machine tokens (e.g. "repaid:10|crossover") — never translated text.
 */
interface AmortizationRow {
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
function computeAmortizationSchedule(meta: LiabilityAmortizationMeta): AmortizationRow[] {
  const { originalAmount, annualInterestRate, originationDate, termMonths } = meta;
  const monthlyRate = annualInterestRate / 100 / 12;
  const rows: AmortizationRow[] = [];

  // Monthly payment (annuité constante). Special-case 0% interest.
  const monthlyPayment =
    monthlyRate === 0
      ? originalAmount / termMonths
      : (originalAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));

  let balance = originalAmount;
  let principalCrossoverDone = false;
  let nextMilestonePercent = 10;

  for (let m = 1; m <= termMonths; m++) {
    const interest = roundToDecimals(balance * monthlyRate);
    const principal = roundToDecimals(Math.min(monthlyPayment - interest, balance));
    balance = roundToDecimals(balance - principal);
    if (m === termMonths) balance = 0;

    const tokens: string[] = [];

    const repaidPercent = ((originalAmount - balance) / originalAmount) * 100;
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

// Parse amortization data stored in quote notes as "__amort:interest=X;principal=Y;auto=TOKENS__"
const parseAmortizationNotes = (
  notes: string | null | undefined,
): { interest: number | null; principal: number | null; autoNote: string; userNotes: string } => {
  if (!notes) return { interest: null, principal: null, autoNote: "", userNotes: "" };
  const match = /^__amort:interest=([\d.]+);principal=([\d.]+)(?:;auto=([^_]*))?__\n?(.*)/s.exec(
    notes,
  );
  if (!match) return { interest: null, principal: null, autoNote: "", userNotes: notes };
  return {
    interest: parseFloat(match[1]),
    principal: parseFloat(match[2]),
    autoNote: match[3] ?? "",
    userNotes: match[4] ?? "",
  };
};

// Serialize amortization data back into the notes field
const serializeAmortizationNotes = (
  interest: number | null,
  principal: number | null,
  autoNote: string,
  userNotes: string,
): string | undefined => {
  if (interest === null || principal === null) return userNotes || undefined;
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

  // Sync with external data changes
  useMemo(() => {
    setLocalEntries(initialEntries);
    setDirtyIds(new Set());
    setDeletedIds(new Set());
  }, [initialEntries]);

  // Track if there are unsaved changes
  const hasUnsavedChanges = dirtyIds.size > 0 || deletedIds.size > 0;

  // Get assetId from first quote or use empty string
  const symbol = data[0]?.assetId ?? "";

  // Whether amortization schedule can be generated
  const canGenerateSchedule = isLiability && liabilityMeta !== undefined;

  // Generate full amortization schedule and replace current entries
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
    setLocalEntries(generated);
    setDirtyIds(new Set(generated.map((e) => e.id)));
    setDeletedIds(new Set());
  }, [liabilityMeta, currency, data]);

  // Dialog open states
  const [earlyRepaymentOpen, setEarlyRepaymentOpen] = useState(false);
  const [closeLoanOpen, setCloseLoanOpen] = useState(false);

  // Handle early repayment: insert a row with reduced balance + regenerate future schedule
  const handleEarlyRepayment = useCallback(
    (result: EarlyRepaymentResult) => {
      if (!liabilityMeta) return;

      // Find the current balance at the repayment date (last entry on or before date)
      const sorted = [...localEntries].sort((a, b) => a.date.getTime() - b.date.getTime());
      const prev = sorted.filter((e) => e.date <= result.date).at(-1);
      const currentBalance = prev?.value ?? liabilityMeta.originalAmount;
      const newBalance = Math.max(0, currentBalance - result.amount);

      // Insert the early repayment row
      const repaymentEntry: ValueHistoryEntry = {
        id: generateTempId(),
        date: result.date,
        value: newBalance,
        interest: null,
        principal: null,
        autoNote: `early_repayment:${result.amount}`,
        notes: "",
        currency,
        isNew: true,
      };

      // Months elapsed from origination to repayment date
      const monthsElapsed = differenceInMonths(result.date, liabilityMeta.originationDate);
      // Remaining months depends on mode
      const originalRemaining = liabilityMeta.termMonths - monthsElapsed;
      let remainingMonths: number;
      if (result.mode === "reduce_payment") {
        // Same remaining duration, smaller payment
        remainingMonths = Math.max(1, originalRemaining);
      } else {
        // Recalculate how many months to pay off newBalance with same monthly payment
        const monthlyRate = liabilityMeta.annualInterestRate / 100 / 12;
        if (monthlyRate === 0 || newBalance <= 0) {
          remainingMonths = Math.max(1, originalRemaining);
        } else {
          const monthlyPayment =
            (liabilityMeta.originalAmount * monthlyRate) /
            (1 - Math.pow(1 + monthlyRate, -liabilityMeta.termMonths));
          remainingMonths = Math.max(
            1,
            Math.ceil(
              -Math.log(1 - (newBalance * monthlyRate) / monthlyPayment) /
                Math.log(1 + monthlyRate),
            ),
          );
        }
      }

      // Regenerate the future schedule from the new balance
      const newMeta: LiabilityAmortizationMeta = {
        ...liabilityMeta,
        originalAmount: newBalance,
        originationDate: result.date,
        termMonths: remainingMonths,
      };
      const futureSchedule = computeAmortizationSchedule(newMeta);
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

      // Keep past entries (before repayment date), drop future ones already generated
      const pastEntries = localEntries.filter((e) => e.date < result.date);
      const newEntries = [...pastEntries, repaymentEntry, ...futureEntries];

      setLocalEntries(newEntries);
      setDirtyIds(new Set(newEntries.filter((e) => e.isNew).map((e) => e.id)));
      // Mark removed future entries (non-new, date >= repayment) for deletion
      const removedIds = localEntries
        .filter((e) => !e.isNew && e.date >= result.date)
        .map((e) => e.id);
      setDeletedIds(new Set(removedIds));
    },
    [liabilityMeta, localEntries, currency],
  );

  // Handle loan closure: insert balance=0 row and drop all future entries
  const handleCloseLoan = useCallback(
    (result: CloseLoanResult) => {
      const closureEntry: ValueHistoryEntry = {
        id: generateTempId(),
        date: result.date,
        value: 0,
        interest: null,
        principal: null,
        autoNote: "loan_closed",
        notes: "",
        currency,
        isNew: true,
      };

      const pastEntries = localEntries.filter((e) => e.date < result.date);
      const newEntries = [...pastEntries, closureEntry];

      setLocalEntries(newEntries);
      setDirtyIds(new Set(newEntries.filter((e) => e.isNew).map((e) => e.id)));
      const removedIds = localEntries
        .filter((e) => !e.isNew && e.date >= result.date)
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
      columnHelper.accessor("notes", {
        header: t("asset:valueHistory.notes"),
        size: 300,
        meta: { cell: { variant: "long-text" } },
        cell: ({ row }) => {
          const autoLabel = translateAutoNote(row.original.autoNote, t);
          const userNotes = row.original.notes;
          return (
            <span className="flex size-full items-center px-2 text-sm">
              {autoLabel && <span className="text-muted-foreground mr-1 italic">{autoLabel}</span>}
              {autoLabel && userNotes && <span className="text-muted-foreground mr-1">·</span>}
              {userNotes && <span>{userNotes}</span>}
            </span>
          );
        },
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
        // Normalize date (DateCell returns string, we need Date)
        const normalizedEntry = {
          ...entry,
          date: normalizeDate(entry.date),
        };

        if (!previous) {
          changedIds.push(entry.id);
          return normalizedEntry;
        }

        // Check if any field changed
        const dateChanged = normalizedEntry.date.getTime() !== previous.date.getTime();
        const valueChanged = entry.value !== previous.value;
        const notesChanged = entry.notes !== previous.notes;

        if (dateChanged || valueChanged || notesChanged) {
          changedIds.push(entry.id);
          return normalizedEntry;
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
    // Save dirty entries
    for (const entry of localEntries) {
      if (dirtyIds.has(entry.id)) {
        const quote = toQuote(entry, symbol);
        onSaveQuote(quote);
      }
    }

    // Delete marked entries
    for (const id of deletedIds) {
      if (!id.startsWith("temp-")) {
        onDeleteQuote(id);
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
