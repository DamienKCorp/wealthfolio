import { Button, Icons } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

interface ValueHistoryToolbarProps {
  selectedRowCount: number;
  hasUnsavedChanges: boolean;
  dirtyCount: number;
  deletedCount: number;
  onAddRow: () => void;
  onDeleteSelected: () => void;
  onSave: () => void;
  onCancel: () => void;
  isLiability?: boolean;
  canGenerateSchedule?: boolean;
  onGenerateSchedule?: () => void;
  onEarlyRepayment?: () => void;
  onCloseLoan?: () => void;
}

export function ValueHistoryToolbar({
  selectedRowCount,
  hasUnsavedChanges,
  dirtyCount,
  deletedCount,
  onAddRow,
  onDeleteSelected,
  onSave,
  onCancel,
  isLiability = false,
  canGenerateSchedule = false,
  onGenerateSchedule,
  onEarlyRepayment,
  onCloseLoan,
}: ValueHistoryToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={onAddRow}>
          <Icons.Plus className="mr-2 h-4 w-4" />
          {isLiability ? t("asset:valueToolbar.add_balance") : t("asset:valueToolbar.add_value")}
        </Button>

        {canGenerateSchedule && onGenerateSchedule && (
          <Button variant="outline" size="sm" onClick={onGenerateSchedule}>
            <Icons.RefreshCw className="mr-2 h-4 w-4" />
            {t("asset:valueToolbar.generate_schedule")}
          </Button>
        )}

        {isLiability && onEarlyRepayment && (
          <Button variant="outline" size="sm" onClick={onEarlyRepayment}>
            <Icons.ArrowDown className="mr-2 h-4 w-4" />
            {t("asset:valueToolbar.early_repayment")}
          </Button>
        )}

        {isLiability && onCloseLoan && (
          <Button variant="outline" size="sm" onClick={onCloseLoan}>
            <Icons.CheckCircle className="mr-2 h-4 w-4" />
            {t("asset:valueToolbar.close_loan")}
          </Button>
        )}

        {selectedRowCount > 0 && (
          <Button variant="outline" size="sm" onClick={onDeleteSelected}>
            <Icons.Trash className="mr-2 h-4 w-4" />
            {t("asset:valueToolbar.delete_count", { count: selectedRowCount })}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        {hasUnsavedChanges && (
          <>
            <span className="text-muted-foreground text-sm">
              {dirtyCount > 0 && t("asset:valueToolbar.modified", { count: dirtyCount })}
              {dirtyCount > 0 && deletedCount > 0 && ", "}
              {deletedCount > 0 && t("asset:valueToolbar.to_delete", { count: deletedCount })}
            </span>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("common:cancel")}
            </Button>
            <Button variant="default" size="sm" onClick={onSave}>
              <Icons.Save className="mr-2 h-4 w-4" />
              {t("asset:valueToolbar.save_changes")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
