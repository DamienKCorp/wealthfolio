import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@wealthfolio/ui/components/ui/dialog";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { MoneyInput, DatePickerInput } from "@wealthfolio/ui";

// ─── Early Repayment ────────────────────────────────────────────────────────

export type EarlyRepaymentMode = "reduce_duration" | "reduce_payment";

export interface EarlyRepaymentResult {
  date: Date;
  amount: number;
  mode: EarlyRepaymentMode;
}

interface EarlyRepaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: EarlyRepaymentResult) => void;
}

export function EarlyRepaymentDialog({ open, onOpenChange, onConfirm }: EarlyRepaymentDialogProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Date>(new Date());
  const [amount, setAmount] = useState<number | undefined>(undefined);
  const [mode, setMode] = useState<EarlyRepaymentMode>("reduce_duration");

  const handleConfirm = () => {
    if (!amount || amount <= 0) return;
    onConfirm({ date, amount, mode });
    onOpenChange(false);
    // Reset
    setAmount(undefined);
    setMode("reduce_duration");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.earlyRepayment.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Date */}
          <div className="space-y-2">
            <Label>{t("asset:loanActions.earlyRepayment.date")}</Label>
            <DatePickerInput value={date} onChange={(d: Date | undefined) => d && setDate(d)} />
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <Label>{t("asset:loanActions.earlyRepayment.amount")}</Label>
            <MoneyInput
              value={amount}
              onValueChange={(v: number | undefined) => setAmount(v)}
              placeholder="0"
            />
          </div>

          {/* Mode toggle */}
          <div className="space-y-2">
            <Label>{t("asset:loanActions.earlyRepayment.mode_label")}</Label>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setMode("reduce_duration")}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  mode === "reduce_duration"
                    ? "border-primary bg-primary/10 font-medium"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="font-medium">
                  {t("asset:loanActions.earlyRepayment.reduce_duration")}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t("asset:loanActions.earlyRepayment.reduce_duration_desc")}
                </div>
              </button>
              <button
                type="button"
                onClick={() => setMode("reduce_payment")}
                className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  mode === "reduce_payment"
                    ? "border-primary bg-primary/10 font-medium"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="font-medium">
                  {t("asset:loanActions.earlyRepayment.reduce_payment")}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t("asset:loanActions.earlyRepayment.reduce_payment_desc")}
                </div>
              </button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!amount || amount <= 0}>
            {t("asset:loanActions.earlyRepayment.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Close Loan ──────────────────────────────────────────────────────────────

export interface CloseLoanResult {
  date: Date;
}

interface CloseLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: CloseLoanResult) => void;
}

export function CloseLoanDialog({ open, onOpenChange, onConfirm }: CloseLoanDialogProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Date>(new Date());

  const handleConfirm = () => {
    onConfirm({ date });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.closeLoan.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-muted-foreground text-sm">
            {t("asset:loanActions.closeLoan.description")}
          </p>
          <div className="space-y-2">
            <Label>{t("asset:loanActions.closeLoan.date")}</Label>
            <DatePickerInput value={date} onChange={(d: Date | undefined) => d && setDate(d)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {t("asset:loanActions.closeLoan.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
