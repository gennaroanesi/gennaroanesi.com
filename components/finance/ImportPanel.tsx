import React, { useState, useMemo, useRef } from "react";
import {
  client,
  AccountRecord, TransactionRecord, HoldingLotRecord, RecurringRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, amountColor,
  inputCls, labelCls,
  SaveButton,
  parseBankCsv, type ParsedTransaction,
  type TxType,
  listAll,
  findRecurringMatches, applyRecurringMatch,
  RECURRING_MATCH_AUTO_THRESHOLD,
  splitCsvRow,
} from "@/components/finance/_shared";
import { inferCategory } from "@/components/finance/categories";
import {
  parseSchwabActivityCsv, labelForSchwabAction,
  type SchwabRow, type SchwabAction,
} from "@/components/finance/schwab";

// Two import shapes, sharing the same outer chrome (account selector,
// date range, "delete existing in range first"). The panel detects which
// kind of CSV is loaded and renders the matching preview + commit path.
type Mode = "bank" | "schwab" | "";

type BankPreviewRow = ParsedTransaction & {
  selected:  boolean;
  duplicate: boolean;
};

type SchwabPreviewRow = SchwabRow & {
  selected:  boolean;
  duplicate: boolean;
  note?:     string;   // unknown action / missing data — shown inline
};

export type ImportPanelProps = {
  accounts:     AccountRecord[];
  transactions: TransactionRecord[];
  recurrings:   RecurringRecord[];
  lots:         HoldingLotRecord[];

  defaultAccountId?: string;
  lockAccount?:      boolean;

  onClose: () => void;
  onSetTransactions: React.Dispatch<React.SetStateAction<TransactionRecord[]>>;
  onSetAccounts:     React.Dispatch<React.SetStateAction<AccountRecord[]>>;
  onSetLots:         React.Dispatch<React.SetStateAction<HoldingLotRecord[]>>;
};

const SCHWAB_ACTION_COLOR: Record<SchwabAction, string> = {
  BANK_INTEREST:        "#06b6d4",
  BANK_TRANSFER:        "#94a3b8",
  MONEYLINK_TRANSFER:   "#94a3b8",
  BUY:                  "#10b981",
  SELL:                 "#f59e0b",
  REINVEST_SHARES:      "#10b981",
  REINVEST_DIVIDEND:    "#06b6d4",
  QUAL_DIV_REINVEST:    "#06b6d4",
  QUALIFIED_DIVIDEND:   "#06b6d4",
  STOCK_PLAN_ACTIVITY:  "#a855f7",
  UNKNOWN:              "#ef4444",
};

// Sniffs a CSV's first line and decides which parser to use. We recognize
// Schwab by its "Action" + "Fees & Comm" pair; everything else falls into
// the generic bank flow.
function detectMode(headerLine: string): Mode {
  const headers = splitCsvRow(headerLine).map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  if (headers.includes("action") && headers.includes("fees & comm")) return "schwab";
  if (headers.length > 1) return "bank";
  return "";
}

export function ImportPanel(props: ImportPanelProps) {
  const {
    accounts, transactions, recurrings, lots,
    defaultAccountId, lockAccount,
    onClose, onSetTransactions, onSetAccounts, onSetLots,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const [saving,            setSaving]            = useState(false);
  const [mode,              setMode]              = useState<Mode>("");
  const [bankFormat,        setBankFormat]        = useState("");
  const [bankRows,          setBankRows]          = useState<BankPreviewRow[]>([]);
  const [schwabRows,        setSchwabRows]        = useState<SchwabPreviewRow[]>([]);
  const [unknownActions,    setUnknownActions]    = useState<string[]>([]);
  const [importAccountId,   setImportAccountId]   = useState<string>(defaultAccountId ?? accounts[0]?.id ?? "");
  const [importReverse,     setImportReverse]     = useState(false);
  const [importStartDate,   setImportStartDate]   = useState<string>("");
  const [importEndDate,     setImportEndDate]     = useState<string>("");
  const [importDeleteRange, setImportDeleteRange] = useState(false);

  // Reverse-sign is meaningful only for bank CSVs (some exports invert
  // sign vs our convention). Schwab is consistent, so we never flip there.
  function effectiveAmount(raw: number): number {
    return mode === "bank" && importReverse ? -raw : raw;
  }

  // Unified "what rows are in the chosen window" view — works for both
  // modes since each preview row carries a `date` field.
  const inRangeBank = useMemo(() => {
    if (mode !== "bank") return [];
    if (!importStartDate && !importEndDate) return bankRows;
    return bankRows.filter((r) =>
      (!importStartDate || r.date >= importStartDate) &&
      (!importEndDate   || r.date <= importEndDate),
    );
  }, [mode, bankRows, importStartDate, importEndDate]);

  const inRangeSchwab = useMemo(() => {
    if (mode !== "schwab") return [];
    if (!importStartDate && !importEndDate) return schwabRows;
    return schwabRows.filter((r) =>
      (!importStartDate || r.date >= importStartDate) &&
      (!importEndDate   || r.date <= importEndDate),
    );
  }, [mode, schwabRows, importStartDate, importEndDate]);

  const totalRows  = mode === "schwab" ? schwabRows.length : bankRows.length;
  const inRangeLen = mode === "schwab" ? inRangeSchwab.length : inRangeBank.length;

  // Existing tx in range — relevant to both modes for the "delete existing
  // in range first" replace flow.
  const inRangeExistingTx = useMemo(() => {
    if (!importAccountId || !importStartDate || !importEndDate) return [];
    return transactions.filter((t) =>
      t.accountId === importAccountId &&
      (t.date ?? "") >= importStartDate &&
      (t.date ?? "") <= importEndDate,
    );
  }, [transactions, importAccountId, importStartDate, importEndDate]);

  async function adjustBalance(accountId: string, delta: number) {
    const acc = accounts.find((a) => a.id === accountId);
    if (acc) {
      const newBal = (acc.currentBalance ?? 0) + delta;
      await client.models.financeAccount.update({ id: accountId, currentBalance: newBal });
      onSetAccounts((p) => p.map((a) => a.id === accountId ? { ...a, currentBalance: newBal } : a));
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      const detected = detectMode(firstLine);
      setMode(detected);
      // Reset both row sets so the previous file's preview doesn't bleed
      // into the new mode.
      setBankRows([]);
      setSchwabRows([]);
      setUnknownActions([]);

      if (detected === "schwab") {
        const { rows, unknownActions } = parseSchwabActivityCsv(text);
        const existingHashes = new Set(transactions.map((t) => t.importHash).filter(Boolean));
        const previewed: SchwabPreviewRow[] = rows.map((r) => {
          const duplicate = existingHashes.has(r.hash);
          let note: string | undefined;
          if (r.action === "UNKNOWN")
            note = `Unknown action: ${r.rawAction}`;
          else if (r.action === "STOCK_PLAN_ACTIVITY" && (r.quantity == null || r.quantity <= 0))
            note = "RSU vest with missing quantity";
          else if ((r.action === "BUY" || r.action === "SELL" || r.action === "REINVEST_SHARES") && (r.quantity == null || r.quantity <= 0))
            note = "Trade row missing quantity";
          return { ...r, selected: !duplicate && r.action !== "UNKNOWN", duplicate, note };
        });
        setSchwabRows(previewed);
        setUnknownActions(unknownActions);
        setBankFormat("Schwab Activity");
        const dates = rows.map((r) => r.date).filter(Boolean).sort();
        setImportStartDate(dates[0] ?? "");
        setImportEndDate(dates[dates.length - 1] ?? "");
      } else {
        const { format, rows } = parseBankCsv(text);
        setBankFormat(format);
        const existingHashes = new Set(transactions.map((t) => t.importHash).filter(Boolean));
        setBankRows(
          rows.map((r) => ({
            ...r,
            selected:  !existingHashes.has(r.hash),
            duplicate: existingHashes.has(r.hash),
          })),
        );
        const dates = rows.map((r) => r.date).filter(Boolean).sort();
        setImportStartDate(dates[0] ?? "");
        setImportEndDate(dates[dates.length - 1] ?? "");
      }
    };
    reader.readAsText(file);
  }

  // ── Bank commit (existing behavior preserved) ──────────────────────────
  async function commitBank() {
    const toImport = importDeleteRange
      ? inRangeBank.filter((r) => r.selected)
      : inRangeBank.filter((r) => r.selected && !r.duplicate);
    if (toImport.length === 0 && (!importDeleteRange || inRangeExistingTx.length === 0)) return;

    let deletedDelta = 0;
    const deletedIds = new Set<string>();
    if (importDeleteRange) {
      for (const tx of inRangeExistingTx) {
        await client.models.financeTransaction.delete({ id: tx.id });
        deletedDelta -= tx.amount ?? 0;
        deletedIds.add(tx.id);
      }
    }

    const created: TransactionRecord[] = [];
    for (const row of toImport) {
      const amt: number  = effectiveAmount(row.amount);
      const type: TxType = amt >= 0 ? "INCOME" : "EXPENSE";
      const { data: tx } = await client.models.financeTransaction.create({
        accountId:   importAccountId,
        amount:      amt,
        type:        type as any,
        category:    row.category || inferCategory({ description: row.description, type, amount: amt }) || null,
        description: row.description,
        date:        row.date,
        status:      "POSTED" as any,
        goalId:      null,
        toAccountId: null,
        importHash:  row.hash,
      });
      if (tx) {
        const candidates = findRecurringMatches(tx, recurrings);
        if (candidates[0] && candidates[0].score >= RECURRING_MATCH_AUTO_THRESHOLD) {
          await applyRecurringMatch(client, tx, candidates[0].rule);
          created.push({ ...tx, recurringId: candidates[0].rule.id } as unknown as TransactionRecord);
        } else {
          created.push(tx);
        }
      }
    }

    const insertedDelta = toImport.reduce((s, r) => s + effectiveAmount(r.amount), 0);
    const netDelta      = deletedDelta + insertedDelta;
    if (netDelta !== 0) await adjustBalance(importAccountId, netDelta);

    onSetTransactions((p) => [...created, ...p.filter((t) => !deletedIds.has(t.id))]);
    const accs = await listAll(client.models.financeAccount);
    onSetAccounts(accs);
  }

  // ── Schwab commit (per-action dispatch) ────────────────────────────────
  async function commitSchwab() {
    const toImport = importDeleteRange
      ? inRangeSchwab.filter((r) => r.selected)
      : inRangeSchwab.filter((r) => r.selected && !r.duplicate);
    if (toImport.length === 0 && (!importDeleteRange || inRangeExistingTx.length === 0)) return;
    if (!importAccountId) return;

    // Replace-mode: drop any existing tx in the chosen window before the
    // CSV rows land. Same semantics as the bank flow.
    let deletedDelta = 0;
    const deletedIds = new Set<string>();
    if (importDeleteRange) {
      for (const tx of inRangeExistingTx) {
        await client.models.financeTransaction.delete({ id: tx.id });
        deletedDelta -= tx.amount ?? 0;
        deletedIds.add(tx.id);
      }
    }

    const created:  TransactionRecord[] = [];
    const newLots:  HoldingLotRecord[] = [];
    const errors:   string[] = [];
    let netInserted = 0;
    // Mutable lot mirror so SELL/Reinvest Shares ordering picks up BUYs
    // earlier in the same batch.
    const runningLots = [...lots];

    // Oldest first so SELLs find their BUYs within the same CSV.
    const sorted = [...toImport].sort((a, b) => a.date.localeCompare(b.date));

    for (const row of sorted) {
      try {
        if (row.action === "BANK_INTEREST" || row.action === "QUALIFIED_DIVIDEND" || row.action === "REINVEST_DIVIDEND" || row.action === "QUAL_DIV_REINVEST") {
          const amount = row.amount ?? 0;
          const category = row.action === "BANK_INTEREST" ? "Interest" : "Dividends";
          const { data: tx } = await client.models.financeTransaction.create({
            accountId:   importAccountId,
            amount,
            type:        "INCOME" as any,
            category,
            description: row.description || labelForSchwabAction(row.action),
            date:        row.date,
            status:      "POSTED" as any,
            goalId:      null,
            toAccountId: null,
            importHash:  row.hash,
            ticker:      row.symbol || null,
          });
          if (tx) created.push(tx);
          netInserted += amount;
        } else if (row.action === "BANK_TRANSFER" || row.action === "MONEYLINK_TRANSFER") {
          const amount = row.amount ?? 0;
          const { data: tx } = await client.models.financeTransaction.create({
            accountId:   importAccountId,
            amount,
            type:        "EXPENSE" as any,
            category:    "Transfers",
            description: row.description || labelForSchwabAction(row.action),
            date:        row.date,
            status:      "POSTED" as any,
            goalId:      null,
            toAccountId: null,
            importHash:  row.hash,
          });
          if (tx) created.push(tx);
          netInserted += amount;
        } else if (row.action === "BUY" || row.action === "REINVEST_SHARES") {
          const qty   = row.quantity ?? 0;
          const price = row.price    ?? 0;
          const fees  = row.fees     ?? 0;
          const amount = row.amount ?? -(qty * price + fees);
          const basis  = Math.abs(amount) || (qty * price + fees) || null;
          const { data: lot } = await client.models.financeHoldingLot.create({
            accountId:    importAccountId,
            ticker:       row.symbol,
            assetType:    "STOCK" as any,
            quantity:     qty,
            costBasis:    basis,
            purchaseDate: row.date,
            isVested:     true,
            notes:        row.action === "REINVEST_SHARES" ? "Reinvested dividend" : null,
          });
          const { data: tx } = await client.models.financeTransaction.create({
            accountId:   importAccountId,
            amount,
            type:        "BUY" as any,
            category:    row.action === "REINVEST_SHARES" ? "Dividend reinvestment" : "Investments",
            description: row.description || `Buy ${qty} ${row.symbol}`,
            date:        row.date,
            status:      "POSTED" as any,
            goalId:      null,
            toAccountId: null,
            importHash:  row.hash,
            ticker:      row.symbol,
            quantity:    qty,
            price:       price || null,
            fees:        fees > 0 ? fees : null,
            lotId:       lot?.id ?? null,
          } as any);
          if (tx) created.push(tx);
          if (lot) { newLots.push(lot); runningLots.push(lot); }
          netInserted += amount;
        } else if (row.action === "SELL") {
          const qty    = row.quantity ?? 0;
          const price  = row.price    ?? 0;
          const fees   = row.fees     ?? 0;
          const amount = row.amount   ?? (qty * price - fees);
          if (qty <= 0) { errors.push(`${row.date} ${row.symbol}: missing quantity`); continue; }
          const candidates = runningLots
            .filter((l) => l.accountId === importAccountId && (l.ticker ?? "").toUpperCase() === row.symbol && (l.quantity ?? 0) > 0)
            .sort((a, b) => (a.purchaseDate ?? "").localeCompare(b.purchaseDate ?? ""));
          const totalAvail = candidates.reduce((s, l) => s + (l.quantity ?? 0), 0);
          if (totalAvail + 1e-6 < qty) {
            errors.push(`${row.date} ${row.symbol}: only ${totalAvail.toFixed(4)} sh on hand for sell of ${qty}`);
            continue;
          }
          let remaining   = qty;
          let runningCost = 0;
          const breakdown: { lotId: string; qty: number; costBasis: number }[] = [];
          for (const lot of candidates) {
            if (remaining <= 1e-6) break;
            const lotQty   = lot.quantity ?? 0;
            const takeQty  = Math.min(remaining, lotQty);
            const fraction = takeQty / lotQty;
            const consumed = lot.costBasis != null ? lot.costBasis * fraction : 0;
            breakdown.push({ lotId: lot.id, qty: takeQty, costBasis: consumed });
            runningCost += consumed;
            remaining   -= takeQty;
            const leftover = lotQty - takeQty;
            if (leftover < 1e-6) {
              await client.models.financeHoldingLot.delete({ id: lot.id });
              const idx = runningLots.findIndex((l) => l.id === lot.id);
              if (idx >= 0) runningLots.splice(idx, 1);
            } else {
              const newCost = lot.costBasis != null ? lot.costBasis - consumed : null;
              await client.models.financeHoldingLot.update({ id: lot.id, quantity: leftover, costBasis: newCost });
              const idx = runningLots.findIndex((l) => l.id === lot.id);
              if (idx >= 0) runningLots[idx] = { ...runningLots[idx], quantity: leftover, costBasis: newCost ?? null };
            }
          }
          const { data: tx } = await client.models.financeTransaction.create({
            accountId:         importAccountId,
            amount,
            type:              "SELL" as any,
            category:          "Investments",
            description:       row.description || `Sell ${qty} ${row.symbol}`,
            date:              row.date,
            status:            "POSTED" as any,
            goalId:            null,
            toAccountId:       null,
            importHash:        row.hash,
            ticker:            row.symbol,
            quantity:          qty,
            price:             price || null,
            fees:              fees > 0 ? fees : null,
            lotId:             breakdown[0]?.lotId ?? null,
            consumedCostBasis: runningCost || null,
            lotConsumptions:   breakdown.length > 0 ? JSON.stringify(breakdown) : null,
          } as any);
          if (tx) created.push(tx);
          netInserted += amount;
        } else if (row.action === "STOCK_PLAN_ACTIVITY") {
          const qty = row.quantity ?? 0;
          if (qty <= 0) continue;
          const { data: lot } = await client.models.financeHoldingLot.create({
            accountId:    importAccountId,
            ticker:       row.symbol,
            assetType:    "STOCK" as any,
            quantity:     qty,
            costBasis:    null,
            purchaseDate: row.date,
            isVested:     true,
            notes:        "RSU vest — fill in cost basis from 1099-B",
          });
          if (lot) { newLots.push(lot); runningLots.push(lot); }
        }
      } catch (e: any) {
        console.error("[schwab-import] row failed", row, e);
        errors.push(`${row.date} ${labelForSchwabAction(row.action)} ${row.symbol}: ${e?.message ?? String(e)}`);
      }
    }

    const netDelta = deletedDelta + netInserted;
    if (netDelta !== 0) await adjustBalance(importAccountId, netDelta);

    onSetTransactions((p) => [...created, ...p.filter((t) => !deletedIds.has(t.id))]);
    // Refetch lots + accounts so SELL partial-consumption updates land in
    // local state without a manual reconcile.
    const [freshLots, freshAccs] = await Promise.all([
      listAll(client.models.financeHoldingLot),
      listAll(client.models.financeAccount),
    ]);
    onSetLots(freshLots);
    onSetAccounts(freshAccs);

    if (errors.length > 0) {
      alert(`Imported ${created.length} rows with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n\n${errors.slice(0, 10).join("\n")}${errors.length > 10 ? `\n…and ${errors.length - 10} more (see console)` : ""}`);
    }
  }

  async function handleImport() {
    if (!importAccountId) return;
    setSaving(true);
    try {
      if (mode === "schwab") await commitSchwab();
      else                   await commitBank();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  // ── Schwab action tally (for the chips above the preview) ──────────────
  const schwabCounts = useMemo(() => {
    if (mode !== "schwab") return new Map<SchwabAction, number>();
    const c = new Map<SchwabAction, number>();
    for (const r of inRangeSchwab) {
      if (!r.selected) continue;
      c.set(r.action, (c.get(r.action) ?? 0) + 1);
    }
    return c;
  }, [mode, inRangeSchwab]);

  // ── Predicted-balance preview (works for both modes) ───────────────────
  const balancePreview = useMemo(() => {
    if (!importAccountId || totalRows === 0) return null;
    const tgt = accounts.find((a) => a.id === importAccountId);
    if (!tgt) return null;
    let insertedDelta = 0;
    if (mode === "bank") {
      const selected = importDeleteRange
        ? inRangeBank.filter((r) => r.selected)
        : inRangeBank.filter((r) => r.selected && !r.duplicate);
      insertedDelta = selected.reduce((s, r) => s + effectiveAmount(r.amount), 0);
    } else {
      const selected = importDeleteRange
        ? inRangeSchwab.filter((r) => r.selected)
        : inRangeSchwab.filter((r) => r.selected && !r.duplicate);
      insertedDelta = selected.reduce((s, r) => s + (r.amount ?? 0), 0);
    }
    const deletedDelta = importDeleteRange
      ? -inRangeExistingTx.reduce((s, t) => s + (t.amount ?? 0), 0)
      : 0;
    const delta = insertedDelta + deletedDelta;
    return {
      currency:     tgt.currency ?? "USD",
      currentBal:   tgt.currentBalance ?? 0,
      delta,
      predictedBal: (tgt.currentBalance ?? 0) + delta,
    };
  }, [mode, importAccountId, totalRows, importDeleteRange, inRangeBank, inRangeSchwab, inRangeExistingTx, accounts, importReverse]);

  const selectedCount = mode === "schwab"
    ? inRangeSchwab.filter((r) => r.selected && !r.duplicate).length
    : inRangeBank.filter((r) => r.selected && !r.duplicate).length;

  return (
    <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-[28rem] border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
        <h2 className="text-base font-semibold dark:text-rose text-purple">Import CSV</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        <p className="text-xs text-gray-400">
          Auto-detects Chase, Bank of America, Amex, generic bank CSV, or Schwab brokerage activity.
          Duplicates are detected by hash.
        </p>

        <div>
          <label className={labelCls}>Target Account</label>
          <select className={inputCls} value={importAccountId}
            disabled={!!lockAccount}
            onChange={(e) => setImportAccountId(e.target.value)}>
            <option value="">Select account…</option>
            {accounts.filter((a) => a.active !== false).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls}>CSV File</label>
          <input ref={fileRef} type="file" accept=".csv,text/csv"
            className="text-sm text-gray-600 dark:text-gray-300 file:mr-2 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-semibold file:cursor-pointer"
            style={{ ["--file-bg" as any]: FINANCE_COLOR + "22" }}
            onChange={handleFileChange} />
        </div>

        {mode === "bank" && (
          <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={importReverse}
              onChange={(e) => setImportReverse(e.target.checked)} />
            Reverse sign
            <span className="text-gray-400">— flip all amounts if this file's convention is inverted</span>
          </label>
        )}

        {totalRows > 0 && (
          <div>
            <label className={labelCls}>Date range (inclusive)</label>
            <div className="flex items-center gap-2">
              <input type="date" value={importStartDate}
                onChange={(e) => setImportStartDate(e.target.value)} className={inputCls} />
              <span className="text-xs text-gray-400">to</span>
              <input type="date" value={importEndDate}
                onChange={(e) => setImportEndDate(e.target.value)} className={inputCls} />
            </div>
            <p className="text-[10px] text-gray-400 mt-1">Rows outside this range are excluded from the import.</p>
          </div>
        )}

        {totalRows > 0 && importAccountId && importStartDate && importEndDate && (
          <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={importDeleteRange}
              onChange={(e) => setImportDeleteRange(e.target.checked)}
              className="mt-0.5" />
            <span>
              <span className="font-medium">Delete existing transactions in range first</span>
              <span className="text-gray-400 ml-1">
                — {inRangeExistingTx.length} existing transaction{inRangeExistingTx.length === 1 ? "" : "s"} would be deleted, then {inRangeLen} replaced.
              </span>
            </span>
          </label>
        )}

        {bankFormat && (
          <p className="text-xs text-gray-400">
            Detected format: <span className="font-medium text-gray-600 dark:text-gray-300">{bankFormat}</span>
            {" · "}{totalRows} rows
            {inRangeLen !== totalRows && (
              <> · <span className="text-gray-500">{inRangeLen} in range</span></>
            )}
            {" · "}<span style={{ color: FINANCE_COLOR }}>{selectedCount} selected</span>
          </p>
        )}

        {unknownActions.length > 0 && (
          <p className="text-[11px] text-amber-500">
            Unknown Schwab actions in this CSV (skipped): {unknownActions.join(", ")}.
          </p>
        )}

        {/* Schwab-specific action tally — gives a quick "what's about to happen" */}
        {mode === "schwab" && schwabCounts.size > 0 && (
          <div className="flex flex-wrap gap-1">
            {Array.from(schwabCounts.entries()).map(([action, n]) => (
              <span key={action} className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                style={{ backgroundColor: SCHWAB_ACTION_COLOR[action] + "22", color: SCHWAB_ACTION_COLOR[action] }}>
                {labelForSchwabAction(action)} × {n}
              </span>
            ))}
          </div>
        )}

        {balancePreview && (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Current balance</span>
              <span className="tabular-nums font-medium" style={{ color: amountColor(balancePreview.currentBal) }}>
                {fmtCurrency(balancePreview.currentBal, balancePreview.currency)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-400">Net change</span>
              <span className="tabular-nums font-medium" style={{ color: amountColor(balancePreview.delta) }}>
                {fmtCurrency(balancePreview.delta, balancePreview.currency, true)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm pt-1 border-t border-gray-200 dark:border-gray-700">
              <span className="text-gray-500 dark:text-gray-400 font-medium">Predicted balance</span>
              <span className="tabular-nums font-bold" style={{ color: amountColor(balancePreview.predictedBal) }}>
                {fmtCurrency(balancePreview.predictedBal, balancePreview.currency)}
              </span>
            </div>
          </div>
        )}

        {totalRows > 0 && (
          <>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (mode === "schwab") {
                    setSchwabRows((r) => r.map((row) => ({ ...row, selected: !row.duplicate && row.action !== "UNKNOWN" })));
                  } else {
                    setBankRows((r) => r.map((row) => ({ ...row, selected: importDeleteRange ? true : !row.duplicate })));
                  }
                }}
                className="text-xs underline" style={{ color: FINANCE_COLOR }}>
                {mode === "schwab"
                  ? "Select all new"
                  : importDeleteRange ? "Select all in range" : "Select all new"}
              </button>
              <button
                onClick={() => {
                  if (mode === "schwab") setSchwabRows((r) => r.map((row) => ({ ...row, selected: false })));
                  else                   setBankRows((r) => r.map((row) => ({ ...row, selected: false })));
                }}
                className="text-xs underline text-gray-400">Deselect all</button>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden max-h-[420px] overflow-y-auto">
              {mode === "schwab" ? (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-darkElevated sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 w-6" />
                      <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Date</th>
                      <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Action</th>
                      <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Detail</th>
                      <th className="px-2 py-1.5 text-right text-gray-400 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {inRangeSchwab.map((row) => {
                      const idx = schwabRows.indexOf(row);
                      const disabled = (row.duplicate && !importDeleteRange) || row.action === "UNKNOWN";
                      return (
                        <tr key={`${row.hash}-${idx}`}
                          className={disabled ? "opacity-50" : ""}
                          onClick={() => !disabled && setSchwabRows((r) =>
                            r.map((x, i) => i === idx ? { ...x, selected: !x.selected } : x))}>
                          <td className="px-2 py-1">
                            <input type="checkbox" checked={row.selected} readOnly className="pointer-events-none" />
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-gray-500">{fmtDate(row.date)}</td>
                          <td className="px-2 py-1">
                            <span className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide"
                              style={{ backgroundColor: SCHWAB_ACTION_COLOR[row.action] + "22", color: SCHWAB_ACTION_COLOR[row.action] }}>
                              {labelForSchwabAction(row.action)}
                            </span>
                          </td>
                          <td className="px-2 py-1 text-gray-700 dark:text-gray-300">
                            {row.symbol && <span className="font-semibold mr-1">{row.symbol}</span>}
                            {row.quantity != null && <span className="text-gray-400">{row.quantity} sh </span>}
                            {row.price != null && <span className="text-gray-400">@ {fmtCurrency(row.price, "USD")}</span>}
                            {!row.symbol && row.description && (
                              <span className="text-gray-500 truncate inline-block max-w-[160px] align-middle">{row.description}</span>
                            )}
                            {row.note && <p className="text-[10px] text-amber-500 mt-0.5">{row.note}</p>}
                            {row.duplicate && !importDeleteRange && <p className="text-[10px] text-amber-500 mt-0.5">(dup)</p>}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium"
                            style={{ color: row.amount != null ? amountColor(row.amount) : undefined }}>
                            {row.amount != null ? fmtCurrency(row.amount, "USD", true) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-darkElevated sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 w-6" />
                      <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Date</th>
                      <th className="px-2 py-1.5 text-left text-gray-400 font-medium">Description</th>
                      <th className="px-2 py-1.5 text-right text-gray-400 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {inRangeBank.map((row) => {
                      const idx = bankRows.indexOf(row);
                      const showAsDuplicate = row.duplicate && !importDeleteRange;
                      return (
                        <tr key={idx} className={showAsDuplicate ? "opacity-40" : ""}
                          onClick={() => !showAsDuplicate && setBankRows((r) =>
                            r.map((x, i) => i === idx ? { ...x, selected: !x.selected } : x))}>
                          <td className="px-2 py-1">
                            <input type="checkbox" checked={row.selected} readOnly className="pointer-events-none" />
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-gray-500">{fmtDate(row.date)}</td>
                          <td className="px-2 py-1 truncate max-w-[180px] text-gray-700 dark:text-gray-300">
                            {row.description}
                            {showAsDuplicate && <span className="ml-1 text-amber-500">(dup)</span>}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium"
                            style={{ color: amountColor(effectiveAmount(row.amount)) }}>
                            {fmtCurrency(effectiveAmount(row.amount), "USD", true)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <SaveButton saving={saving} onSave={handleImport}
              label={
                importDeleteRange
                  ? `Replace ${inRangeExistingTx.length} with ${selectedCount}`
                  : `Import ${selectedCount} rows`
              } />
          </>
        )}
      </div>
    </div>
  );
}
