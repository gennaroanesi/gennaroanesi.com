import React, { useState, useMemo, useRef } from "react";
import {
  client,
  AccountRecord, TransactionRecord, HoldingLotRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, amountColor,
  inputCls, labelCls,
  SaveButton,
  listAll,
} from "@/components/finance/_shared";
import {
  parseSchwabActivityCsv, labelForSchwabAction,
  type SchwabRow, type SchwabAction,
} from "@/components/finance/schwab";

type PreviewRow = SchwabRow & {
  selected:  boolean;
  duplicate: boolean;
  note?:     string;   // surfaced warning (unknown action, missing data)
};

export type SchwabImportPanelProps = {
  accounts:     AccountRecord[];
  transactions: TransactionRecord[];
  lots:         HoldingLotRecord[];

  defaultAccountId?: string;
  lockAccount?:      boolean;

  onClose: () => void;
  onSetTransactions: React.Dispatch<React.SetStateAction<TransactionRecord[]>>;
  onSetAccounts:     React.Dispatch<React.SetStateAction<AccountRecord[]>>;
  onSetLots:         React.Dispatch<React.SetStateAction<HoldingLotRecord[]>>;
};

// Colors per action — keeps the preview readable when 50+ rows land at once.
const ACTION_COLOR: Record<SchwabAction, string> = {
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

export function SchwabImportPanel(props: SchwabImportPanelProps) {
  const {
    accounts, transactions, lots,
    defaultAccountId, lockAccount,
    onClose, onSetTransactions, onSetAccounts, onSetLots,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const [saving,          setSaving]          = useState(false);
  const [importRows,      setImportRows]      = useState<PreviewRow[]>([]);
  const [unknownActions,  setUnknownActions]  = useState<string[]>([]);
  const [importAccountId, setImportAccountId] = useState<string>(defaultAccountId ?? accounts[0]?.id ?? "");
  const [importStartDate, setImportStartDate] = useState<string>("");
  const [importEndDate,   setImportEndDate]   = useState<string>("");

  // Rows within the chosen date range (inclusive). Anything outside the
  // range is excluded entirely — keeps the user's window as source of truth.
  const inRangeRows = useMemo(() => {
    if (!importStartDate && !importEndDate) return importRows;
    return importRows.filter((r) => {
      if (importStartDate && r.date < importStartDate) return false;
      if (importEndDate   && r.date > importEndDate)   return false;
      return true;
    });
  }, [importRows, importStartDate, importEndDate]);

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
      const { rows, unknownActions } = parseSchwabActivityCsv(text);
      const existingHashes = new Set(transactions.map((t) => t.importHash).filter(Boolean));
      const previewed: PreviewRow[] = rows.map((r) => {
        const duplicate = existingHashes.has(r.hash);
        let note: string | undefined;
        if (r.action === "UNKNOWN")               note = `Unknown action: ${r.rawAction}`;
        else if (r.action === "STOCK_PLAN_ACTIVITY" && (r.quantity == null || r.quantity <= 0))
          note = "RSU vest with missing quantity";
        else if ((r.action === "BUY" || r.action === "SELL" || r.action === "REINVEST_SHARES") && (r.quantity == null || r.quantity <= 0))
          note = "Trade row missing quantity";
        return { ...r, selected: !duplicate && r.action !== "UNKNOWN", duplicate, note };
      });
      setImportRows(previewed);
      setUnknownActions(unknownActions);
      // Auto-populate the date range from the parsed CSV's min/max.
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      setImportStartDate(dates[0] ?? "");
      setImportEndDate(dates[dates.length - 1] ?? "");
    };
    reader.readAsText(file);
  }

  // ── Per-action commit handlers ─────────────────────────────────────────
  // Each helper returns the cash delta (signed) it added to the account,
  // along with any newly created transaction / lot records the parent
  // state needs to absorb.

  async function importIncomeRow(row: PreviewRow, accountId: string, category: string): Promise<{ tx: TransactionRecord | null; delta: number }> {
    const amount = row.amount ?? 0;
    const { data: tx } = await client.models.financeTransaction.create({
      accountId,
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
    return { tx, delta: amount };
  }

  async function importExpenseRow(row: PreviewRow, accountId: string, category: string): Promise<{ tx: TransactionRecord | null; delta: number }> {
    const amount = row.amount ?? 0;
    const { data: tx } = await client.models.financeTransaction.create({
      accountId,
      amount,
      type:        "EXPENSE" as any,
      category,
      description: row.description || labelForSchwabAction(row.action),
      date:        row.date,
      status:      "POSTED" as any,
      goalId:      null,
      toAccountId: null,
      importHash:  row.hash,
    });
    return { tx, delta: amount };
  }

  // BUY-like (Buy + Reinvest Shares). Creates a lot and a single Schwab-style
  // trade row carrying the net signed amount.
  async function importBuyRow(
    row: PreviewRow, accountId: string, runningLots: HoldingLotRecord[],
  ): Promise<{ tx: TransactionRecord | null; lot: HoldingLotRecord | null; delta: number }> {
    const qty   = row.quantity ?? 0;
    const price = row.price    ?? 0;
    const fees  = row.fees     ?? 0;
    const amount = row.amount ?? -(qty * price + fees); // fall back if Schwab left amount blank
    // Cost basis includes commissions/fees per IRS Pub 550 — same convention
    // as the manual-entry trade panel.
    const basis = Math.abs(amount) || (qty * price + fees) || null;
    const { data: lot } = await client.models.financeHoldingLot.create({
      accountId,
      ticker:       row.symbol,
      assetType:    "STOCK" as any,
      quantity:     qty,
      costBasis:    basis,
      purchaseDate: row.date,
      isVested:     true,
      notes:        row.action === "REINVEST_SHARES" ? "Reinvested dividend" : null,
    });
    const { data: tx } = await client.models.financeTransaction.create({
      accountId,
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
    if (lot) runningLots.push(lot);
    return { tx, lot: lot ?? null, delta: amount };
  }

  // SELL: consume from this account's lots FIFO (oldest purchaseDate first)
  // and snapshot the breakdown into lotConsumptions JSON. Returns null tx
  // when there aren't enough lots (we surface this as an error rather than
  // create a half-broken sell).
  async function importSellRow(
    row: PreviewRow, accountId: string, runningLots: HoldingLotRecord[],
  ): Promise<{ tx: TransactionRecord | null; delta: number; error?: string }> {
    const qty    = row.quantity ?? 0;
    const price  = row.price    ?? 0;
    const fees   = row.fees     ?? 0;
    const amount = row.amount   ?? (qty * price - fees);
    if (qty <= 0) return { tx: null, delta: 0, error: "Missing quantity" };

    const candidates = runningLots
      .filter((l) => l.accountId === accountId && (l.ticker ?? "").toUpperCase() === row.symbol && (l.quantity ?? 0) > 0)
      .sort((a, b) => (a.purchaseDate ?? "").localeCompare(b.purchaseDate ?? ""));
    const totalAvail = candidates.reduce((s, l) => s + (l.quantity ?? 0), 0);
    if (totalAvail + 1e-6 < qty) {
      return { tx: null, delta: 0, error: `Only ${totalAvail.toFixed(4)} ${row.symbol} sh on hand for sell of ${qty}` };
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
        // Mark as gone in the running set so subsequent rows can't double-consume.
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
      accountId,
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
    return { tx, delta: amount };
  }

  // RSU vest. Schwab's CSV gives us quantity but no cost basis (FMV at
  // vest), so we create a lot with $0 basis — the user can edit later via
  // the lot panel once they have the 1099-B numbers.
  async function importStockPlanRow(row: PreviewRow, accountId: string, runningLots: HoldingLotRecord[]): Promise<{ lot: HoldingLotRecord | null }> {
    const qty = row.quantity ?? 0;
    if (qty <= 0) return { lot: null };
    const { data: lot } = await client.models.financeHoldingLot.create({
      accountId,
      ticker:       row.symbol,
      assetType:    "STOCK" as any,
      quantity:     qty,
      costBasis:    null, // unknown — edit after 1099-B is available
      purchaseDate: row.date,
      isVested:     true,
      notes:        "RSU vest — fill in cost basis from 1099-B",
    });
    if (lot) runningLots.push(lot);
    return { lot: lot ?? null };
  }

  async function handleImport() {
    const toImport = inRangeRows.filter((r) => r.selected && !r.duplicate);
    if (toImport.length === 0) return;
    if (!importAccountId) return;
    setSaving(true);
    const newTxs: TransactionRecord[] = [];
    const newLots: HoldingLotRecord[] = [];
    // Work over a mutable copy of lots so SELL/Reinvest Shares ordering
    // sees freshly created BUY lots within the same import batch.
    const runningLots = [...lots];
    let netCashDelta = 0;
    const errors: string[] = [];
    try {
      // Sort rows oldest first so SELLs find their lots after the BUYs that
      // funded them within the same CSV.
      const sorted = [...toImport].sort((a, b) => a.date.localeCompare(b.date));
      for (const row of sorted) {
        try {
          if (row.action === "BANK_INTEREST" || row.action === "QUALIFIED_DIVIDEND" || row.action === "REINVEST_DIVIDEND" || row.action === "QUAL_DIV_REINVEST") {
            const category = row.action === "BANK_INTEREST" ? "Interest" : "Dividends";
            const { tx, delta } = await importIncomeRow(row, importAccountId, category);
            if (tx) newTxs.push(tx);
            netCashDelta += delta;
          } else if (row.action === "BANK_TRANSFER" || row.action === "MONEYLINK_TRANSFER") {
            const category = "Transfers";
            const { tx, delta } = await importExpenseRow(row, importAccountId, category);
            if (tx) newTxs.push(tx);
            netCashDelta += delta;
          } else if (row.action === "BUY" || row.action === "REINVEST_SHARES") {
            const { tx, lot, delta } = await importBuyRow(row, importAccountId, runningLots);
            if (tx) newTxs.push(tx);
            if (lot) newLots.push(lot);
            netCashDelta += delta;
          } else if (row.action === "SELL") {
            const { tx, delta, error } = await importSellRow(row, importAccountId, runningLots);
            if (error) { errors.push(`${row.date} ${row.symbol}: ${error}`); continue; }
            if (tx) newTxs.push(tx);
            netCashDelta += delta;
          } else if (row.action === "STOCK_PLAN_ACTIVITY") {
            const { lot } = await importStockPlanRow(row, importAccountId, runningLots);
            if (lot) newLots.push(lot);
          }
        } catch (e: any) {
          console.error("[schwab-import] row failed", row, e);
          errors.push(`${row.date} ${labelForSchwabAction(row.action)} ${row.symbol}: ${e?.message ?? String(e)}`);
        }
      }

      // Single net adjustBalance roll-up so we don't N+1 the account update.
      if (netCashDelta !== 0) await adjustBalance(importAccountId, netCashDelta);

      onSetTransactions((p) => [...newTxs, ...p]);
      onSetLots((p) => {
        const created = newLots.filter((nl) => !p.some((existing) => existing.id === nl.id));
        // Reflect any lot mutations from SELL/Reinvest pairs by re-fetching.
        // Simplest path: refetch all lots so the local state matches DB.
        return [...created, ...p];
      });
      // Refetch lots + accounts so partial-consumption SELL updates are picked up.
      const [freshLots, freshAccs] = await Promise.all([
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeAccount),
      ]);
      onSetLots(freshLots);
      onSetAccounts(freshAccs);

      if (errors.length > 0) {
        alert(`Imported ${newTxs.length} rows with ${errors.length} error${errors.length === 1 ? "" : "s"}:\n\n${errors.slice(0, 10).join("\n")}${errors.length > 10 ? `\n…and ${errors.length - 10} more (see console)` : ""}`);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  // ── Tallies for the preview header ─────────────────────────────────────
  const counts = useMemo(() => {
    const c = new Map<SchwabAction, number>();
    for (const r of inRangeRows) {
      if (!r.selected) continue;
      c.set(r.action, (c.get(r.action) ?? 0) + 1);
    }
    return c;
  }, [inRangeRows]);

  return (
    <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-[28rem] border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
        <h2 className="text-base font-semibold dark:text-rose text-purple">Import Schwab Activity</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        <p className="text-xs text-gray-400">
          Drop a Schwab activity CSV (downloaded from Accounts → History → Transactions).
          Trades create lots and consume FIFO; dividends + interest become INCOME; outbound
          transfers become EXPENSE. RSU vests (Stock Plan Activity) create lots with no cost
          basis — edit them once you have the 1099-B.
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

        {importRows.length > 0 && (
          <div>
            <label className={labelCls}>Date range (inclusive)</label>
            <div className="flex items-center gap-2">
              <input type="date" value={importStartDate}
                onChange={(e) => setImportStartDate(e.target.value)} className={inputCls} />
              <span className="text-xs text-gray-400">to</span>
              <input type="date" value={importEndDate}
                onChange={(e) => setImportEndDate(e.target.value)} className={inputCls} />
            </div>
          </div>
        )}

        {unknownActions.length > 0 && (
          <p className="text-[11px] text-amber-500">
            Unknown actions in this CSV (skipped): {unknownActions.join(", ")}. Send a sample so I can add them.
          </p>
        )}

        {importRows.length > 0 && (
          <p className="text-xs text-gray-400">
            {importRows.length} rows · {inRangeRows.length} in range ·{" "}
            <span style={{ color: FINANCE_COLOR }}>{inRangeRows.filter((r) => r.selected).length} selected</span>
            {inRangeRows.some((r) => r.duplicate) && (
              <span className="text-amber-500"> · {inRangeRows.filter((r) => r.duplicate).length} duplicates</span>
            )}
          </p>
        )}

        {/* Tally of selected by action — gives a quick "what's about to happen" */}
        {counts.size > 0 && (
          <div className="flex flex-wrap gap-1">
            {Array.from(counts.entries()).map(([action, n]) => (
              <span key={action} className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                style={{ backgroundColor: ACTION_COLOR[action] + "22", color: ACTION_COLOR[action] }}>
                {labelForSchwabAction(action)} × {n}
              </span>
            ))}
          </div>
        )}

        {importRows.length > 0 && (
          <>
            <div className="flex gap-2">
              <button onClick={() => setImportRows((r) => r.map((row) => ({ ...row, selected: !row.duplicate && row.action !== "UNKNOWN" })))}
                className="text-xs underline" style={{ color: FINANCE_COLOR }}>
                Select all new
              </button>
              <button onClick={() => setImportRows((r) => r.map((row) => ({ ...row, selected: false })))}
                className="text-xs underline text-gray-400">Deselect all</button>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden max-h-[420px] overflow-y-auto">
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
                  {inRangeRows.map((row) => {
                    const idx = importRows.indexOf(row);
                    const disabled = row.duplicate || row.action === "UNKNOWN" || !!row.note;
                    return (
                      <tr key={`${row.hash}-${idx}`}
                        className={disabled ? "opacity-50" : ""}
                        onClick={() => !disabled && setImportRows((r) =>
                          r.map((x, i) => i === idx ? { ...x, selected: !x.selected } : x))}>
                        <td className="px-2 py-1">
                          <input type="checkbox" checked={row.selected} readOnly className="pointer-events-none" />
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-gray-500">{fmtDate(row.date)}</td>
                        <td className="px-2 py-1">
                          <span className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide"
                            style={{ backgroundColor: ACTION_COLOR[row.action] + "22", color: ACTION_COLOR[row.action] }}>
                            {labelForSchwabAction(row.action)}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-gray-700 dark:text-gray-300">
                          {row.symbol && <span className="font-semibold mr-1">{row.symbol}</span>}
                          {row.quantity != null && <span className="text-gray-400">{row.quantity} sh </span>}
                          {row.price != null && <span className="text-gray-400">@ {fmtCurrency(row.price, "USD")}</span>}
                          {!row.symbol && row.description && (
                            <span className="text-gray-500 truncate inline-block max-w-[180px] align-middle">{row.description}</span>
                          )}
                          {row.note && <p className="text-[10px] text-amber-500 mt-0.5">{row.note}</p>}
                          {row.duplicate && <p className="text-[10px] text-amber-500 mt-0.5">duplicate (already imported)</p>}
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
            </div>

            <SaveButton saving={saving} onSave={handleImport}
              label={`Import ${inRangeRows.filter((r) => r.selected && !r.duplicate).length} rows`} />
          </>
        )}
      </div>
    </div>
  );
}
