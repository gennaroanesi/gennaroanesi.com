import React, { useState, useMemo, useRef } from "react";
import {
  client,
  AccountRecord, TransactionRecord, RecurringRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, amountColor,
  inputCls, labelCls,
  SaveButton,
  parseBankCsv, type ParsedTransaction,
  type TxType,
  listAll,
  findRecurringMatches, applyRecurringMatch,
  RECURRING_MATCH_AUTO_THRESHOLD,
} from "@/components/finance/_shared";

type ImportRow = ParsedTransaction & {
  selected:  boolean;
  duplicate: boolean;
};

export type ImportPanelProps = {
  accounts:     AccountRecord[];
  transactions: TransactionRecord[];
  recurrings:   RecurringRecord[];

  defaultAccountId?: string;
  lockAccount?:      boolean;

  onClose: () => void;
  onSetTransactions: React.Dispatch<React.SetStateAction<TransactionRecord[]>>;
  onSetAccounts:     React.Dispatch<React.SetStateAction<AccountRecord[]>>;
};

export function ImportPanel(props: ImportPanelProps) {
  const {
    accounts, transactions, recurrings,
    defaultAccountId, lockAccount,
    onClose, onSetTransactions, onSetAccounts,
  } = props;

  const fileRef = useRef<HTMLInputElement>(null);
  const [saving,            setSaving]            = useState(false);
  const [importFormat,      setImportFormat]      = useState("");
  const [importRows,        setImportRows]        = useState<ImportRow[]>([]);
  const [importAccountId,   setImportAccountId]   = useState<string>(defaultAccountId ?? accounts[0]?.id ?? "");
  const [importReverse,     setImportReverse]     = useState(false);
  const [importStartDate,   setImportStartDate]   = useState<string>("");
  const [importEndDate,     setImportEndDate]     = useState<string>("");
  const [importDeleteRange, setImportDeleteRange] = useState(false);

  function effectiveAmount(raw: number): number {
    return importReverse ? -raw : raw;
  }

  const inRangeRows = useMemo(() => {
    if (!importStartDate && !importEndDate) return importRows;
    return importRows.filter((r) => {
      if (importStartDate && r.date < importStartDate) return false;
      if (importEndDate   && r.date > importEndDate)   return false;
      return true;
    });
  }, [importRows, importStartDate, importEndDate]);

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
      const { format, rows } = parseBankCsv(text);
      setImportFormat(format);
      const existingHashes = new Set(transactions.map((t) => t.importHash).filter(Boolean));
      setImportRows(
        rows.map((r) => ({
          ...r,
          selected:  !existingHashes.has(r.hash),
          duplicate: existingHashes.has(r.hash),
        })),
      );
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      setImportStartDate(dates[0] ?? "");
      setImportEndDate(dates[dates.length - 1] ?? "");
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    const toImport = importDeleteRange
      ? inRangeRows.filter((r) => r.selected)
      : inRangeRows.filter((r) => r.selected && !r.duplicate);
    if (toImport.length === 0 && (!importDeleteRange || inRangeExistingTx.length === 0)) return;
    if (!importAccountId) return;
    setSaving(true);
    try {
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
          category:    row.category || null,
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
      if (netDelta !== 0) {
        await adjustBalance(importAccountId, netDelta);
      }

      onSetTransactions((p) => [
        ...created,
        ...p.filter((t) => !deletedIds.has(t.id)),
      ]);
      // Refetch accounts to capture any prior optimistic drift.
      const accs = await listAll(client.models.financeAccount);
      onSetAccounts(accs);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
        <h2 className="text-base font-semibold dark:text-rose text-purple">Import CSV</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        <p className="text-xs text-gray-400">
          Supports Chase, Bank of America, Amex, and generic CSV exports. Duplicates are detected automatically.
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

        <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" checked={importReverse}
            onChange={(e) => setImportReverse(e.target.checked)} />
          Reverse sign
          <span className="text-gray-400">— flip all amounts if this file's convention is inverted</span>
        </label>

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
            <p className="text-[10px] text-gray-400 mt-1">
              Rows outside this range are excluded from the import.
            </p>
          </div>
        )}

        {importRows.length > 0 && importAccountId && importStartDate && importEndDate && (
          <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300 cursor-pointer">
            <input type="checkbox" checked={importDeleteRange}
              onChange={(e) => setImportDeleteRange(e.target.checked)}
              className="mt-0.5" />
            <span>
              <span className="font-medium">Delete existing transactions in range first</span>
              <span className="text-gray-400 ml-1">
                — {inRangeExistingTx.length} existing transaction{inRangeExistingTx.length === 1 ? "" : "s"} would be deleted, then {inRangeRows.length} replaced.
              </span>
            </span>
          </label>
        )}

        {importFormat && (
          <p className="text-xs text-gray-400">
            Detected format: <span className="font-medium text-gray-600 dark:text-gray-300">{importFormat}</span>
            {" · "}{importRows.length} rows
            {inRangeRows.length !== importRows.length && (
              <> · <span className="text-gray-500">{inRangeRows.length} in range</span></>
            )}
            {" · "}<span style={{ color: FINANCE_COLOR }}>{inRangeRows.filter((r) => r.selected).length} selected</span>
            {!importDeleteRange && inRangeRows.some((r) => r.duplicate) && (
              <span className="text-amber-500"> · {inRangeRows.filter((r) => r.duplicate).length} duplicates</span>
            )}
          </p>
        )}

        {importAccountId && importRows.length > 0 && (() => {
          const tgt = accounts.find((a) => a.id === importAccountId);
          if (!tgt) return null;
          const insertedDelta = (importDeleteRange
            ? inRangeRows.filter((r) => r.selected)
            : inRangeRows.filter((r) => r.selected && !r.duplicate)
          ).reduce((s, r) => s + effectiveAmount(r.amount), 0);
          const deletedDelta = importDeleteRange
            ? -inRangeExistingTx.reduce((s, t) => s + (t.amount ?? 0), 0)
            : 0;
          const delta = insertedDelta + deletedDelta;
          const currentBal   = tgt.currentBalance ?? 0;
          const predictedBal = currentBal + delta;
          const cur = tgt.currency ?? "USD";
          return (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">Current balance</span>
                <span className="tabular-nums font-medium" style={{ color: amountColor(currentBal) }}>
                  {fmtCurrency(currentBal, cur)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">Net change</span>
                <span className="tabular-nums font-medium" style={{ color: amountColor(delta) }}>
                  {fmtCurrency(delta, cur, true)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm pt-1 border-t border-gray-200 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400 font-medium">Predicted balance</span>
                <span className="tabular-nums font-bold" style={{ color: amountColor(predictedBal) }}>
                  {fmtCurrency(predictedBal, cur)}
                </span>
              </div>
            </div>
          );
        })()}

        {importRows.length > 0 && (
          <>
            <div className="flex gap-2">
              <button onClick={() => setImportRows((r) => r.map((row) => ({ ...row, selected: importDeleteRange ? true : !row.duplicate })))}
                className="text-xs underline" style={{ color: FINANCE_COLOR }}>
                {importDeleteRange ? "Select all in range" : "Select all new"}
              </button>
              <button onClick={() => setImportRows((r) => r.map((row) => ({ ...row, selected: false })))}
                className="text-xs underline text-gray-400">Deselect all</button>
            </div>

            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden max-h-64 overflow-y-auto">
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
                  {inRangeRows.map((row) => {
                    const idx = importRows.indexOf(row);
                    const showAsDuplicate = row.duplicate && !importDeleteRange;
                    return (
                      <tr key={idx} className={showAsDuplicate ? "opacity-40" : ""}
                        onClick={() => !showAsDuplicate && setImportRows((r) =>
                          r.map((x, i) => i === idx ? { ...x, selected: !x.selected } : x))}>
                        <td className="px-2 py-1">
                          <input type="checkbox" checked={row.selected} readOnly className="pointer-events-none" />
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-gray-500">{fmtDate(row.date)}</td>
                        <td className="px-2 py-1 truncate max-w-[140px] text-gray-700 dark:text-gray-300">
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
            </div>

            <SaveButton saving={saving} onSave={handleImport}
              label={
                importDeleteRange
                  ? `Replace ${inRangeExistingTx.length} with ${inRangeRows.filter((r) => r.selected).length}`
                  : `Import ${inRangeRows.filter((r) => r.selected && !r.duplicate).length} transactions`
              } />
          </>
        )}
      </div>
    </div>
  );
}
