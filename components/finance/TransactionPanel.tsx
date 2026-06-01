import React, { useState, useMemo } from "react";
import {
  client,
  AccountRecord, TransactionRecord, HoldingLotRecord, RecurringRecord,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor,
  inputCls, labelCls,
  SaveButton, DeleteButton,
  type TxType,
  isTradeType, parseLotConsumptions, type LotConsumption,
  listAll,
  findRecurringMatches, applyRecurringMatch,
  RECURRING_MATCH_AUTO_THRESHOLD,
} from "@/components/finance/_shared";
import { AttachmentsSection, deleteAttachmentsFor } from "@/components/common/AttachmentsSection";

export type TransactionPanelProps = {
  // Data the form reads from
  accounts:    AccountRecord[];
  lots:        HoldingLotRecord[];
  recurrings:  RecurringRecord[];

  // Mode
  mode:        "create" | "edit";
  defaultType?:      TxType;     // create only
  defaultAccountId?: string;     // create only — preselects the account
  lockAccount?:      boolean;    // create only — disables the account picker
  editingTx?:        TransactionRecord; // required when mode === "edit"

  // Lifecycle
  onClose: () => void;

  // The panel mutates parent state directly via these setters. Trade-side
  // writes touch lots; the cash side touches account balances; every save
  // appends/updates the transactions list.
  onSetTransactions: React.Dispatch<React.SetStateAction<TransactionRecord[]>>;
  onSetAccounts:     React.Dispatch<React.SetStateAction<AccountRecord[]>>;
  onSetLots:         React.Dispatch<React.SetStateAction<HoldingLotRecord[]>>;
};

export function TransactionPanel(props: TransactionPanelProps) {
  const {
    accounts, lots, recurrings,
    mode, defaultType, defaultAccountId, lockAccount, editingTx,
    onClose,
    onSetTransactions, onSetAccounts, onSetLots,
  } = props;

  const today = todayIso();

  // ── Draft state ──────────────────────────────────────────────────────────
  const [txDraft, setTxDraft] = useState<Partial<TransactionRecord>>(() => {
    if (mode === "edit" && editingTx) return { ...editingTx };
    const t = defaultType ?? "EXPENSE";
    const isIncome = t === "INCOME" || t === "SELL";
    return {
      date:      todayIso(),
      status:    "POSTED",
      type:      t,
      accountId: defaultAccountId,
      amount:    isIncome ? 0 : -0,
    };
  });

  // Trade-only UI state. For edit mode, seed price from amount/qty (display only —
  // trade fields are locked in edit). Fees stay blank in edit; they were saved
  // as their own sibling expense at create time.
  const [tradePrice, setTradePrice] = useState<string>(() => {
    if (mode === "edit" && editingTx && isTradeType(editingTx.type as any) && editingTx.quantity) {
      const p = Math.abs(editingTx.amount ?? 0) / editingTx.quantity;
      return p ? p.toFixed(4).replace(/\.?0+$/, "") : "";
    }
    return "";
  });
  const [tradeFees,    setTradeFees]    = useState<string>("");
  const [sellLotPicks, setSellLotPicks] = useState<string[]>([]);

  const [saving,              setSaving]              = useState(false);
  const [showMatchCandidates, setShowMatchCandidates] = useState(false);

  const recurringById = useMemo(() => {
    const m = new Map<string, RecurringRecord>();
    for (const r of recurrings) m.set(r.id, r);
    return m;
  }, [recurrings]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function adjustBalance(accountId: string, delta: number, toAccountId: string | null, type: TxType | string) {
    const acc = accounts.find((a) => a.id === accountId);
    if (acc) {
      const newBal = (acc.currentBalance ?? 0) + delta;
      await client.models.financeAccount.update({ id: accountId, currentBalance: newBal });
      onSetAccounts((p) => p.map((a) => a.id === accountId ? { ...a, currentBalance: newBal } : a));
    }
    if (type === "TRANSFER" && toAccountId) {
      const dest = accounts.find((a) => a.id === toAccountId);
      if (dest) {
        const newBal = (dest.currentBalance ?? 0) + Math.abs(delta);
        await client.models.financeAccount.update({ id: toAccountId, currentBalance: newBal });
        onSetAccounts((p) => p.map((a) => a.id === toAccountId ? { ...a, currentBalance: newBal } : a));
      }
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!txDraft.accountId || !txDraft.date) return;
    const txType = (txDraft.type ?? "EXPENSE") as TxType;
    const priceNum = parseFloat(tradePrice) || 0;
    const feesNum  = Math.max(0, parseFloat(tradeFees) || 0);
    const tradeGross = isTradeType(txType) ? priceNum * (txDraft.quantity ?? 0) : 0;
    const tradeSignedAmount = txType === "BUY" ? -tradeGross : tradeGross;

    if (isTradeType(txType)) {
      if (!txDraft.ticker || !txDraft.quantity || txDraft.quantity <= 0) {
        alert("Ticker and quantity are required for BUY/SELL.");
        return;
      }
      if (priceNum <= 0 && mode === "create") {
        alert("Price per share is required for BUY/SELL.");
        return;
      }
      if (txType === "SELL" && mode === "create" && sellLotPicks.length === 0) {
        alert("Pick at least one lot to sell from.");
        return;
      }
    } else if (txDraft.amount == null) {
      return;
    }

    setSaving(true);
    try {
      const isPosted = txDraft.status === "POSTED";
      const effectiveAmount = isTradeType(txType) && mode === "create" ? tradeSignedAmount : txDraft.amount!;

      if (mode === "create") {
        const autoDesc = isTradeType(txType)
          ? `${txType === "BUY" ? "Buy" : "Sell"} ${txDraft.quantity} ${(txDraft.ticker ?? "").toUpperCase()}`
          : null;
        const description = txDraft.description?.trim() ? txDraft.description.trim() : autoDesc;

        // BUY: create lot up front to get its id onto the transaction. Fees are
        // logged as their own sibling expense below — they don't roll into the
        // cost basis here so they stay visible/editable.
        let createdLotId: string | null = null;
        let createdLot: HoldingLotRecord | null = null;
        if (txType === "BUY") {
          const { data } = await client.models.financeHoldingLot.create({
            accountId:    txDraft.accountId!,
            ticker:       (txDraft.ticker ?? "").toUpperCase(),
            assetType:    "STOCK" as any,
            quantity:     txDraft.quantity!,
            costBasis:    tradeGross || null,
            purchaseDate: txDraft.date!,
            isVested:     true,
            notes:        null,
          });
          if (data) { createdLot = data; createdLotId = data.id; }
        }

        // SELL: walk sellLotPicks in order, take min(remaining, lotQty) from
        // each, mutate (decrement or delete) lots in place, and snapshot the
        // breakdown into lotConsumptions JSON for later reporting.
        let consumedCostBasis:    number | null = null;
        let lotConsumptionsJson:  string | null = null;
        let firstLotId:           string | null = null;
        if (txType === "SELL") {
          const sellQty = txDraft.quantity!;
          const totalAvail = sellLotPicks.reduce((s, id) => {
            const l = lots.find((x) => x.id === id);
            return s + (l?.quantity ?? 0);
          }, 0);
          if (totalAvail + 1e-6 < sellQty) {
            alert(`Selected lots only have ${totalAvail.toLocaleString("en-US", { maximumFractionDigits: 4 })} sh — short ${(sellQty - totalAvail).toLocaleString("en-US", { maximumFractionDigits: 4 })}.`);
            setSaving(false);
            return;
          }
          let remaining   = sellQty;
          let runningCost = 0;
          const breakdown: LotConsumption[] = [];
          for (const lotId of sellLotPicks) {
            if (remaining <= 1e-6) break;
            const lot = lots.find((l) => l.id === lotId);
            if (!lot) continue;
            const lotQty = lot.quantity ?? 0;
            if (lotQty <= 0) continue;
            const takeQty  = Math.min(remaining, lotQty);
            const fraction = takeQty / lotQty;
            const consumed = lot.costBasis != null ? lot.costBasis * fraction : 0;
            breakdown.push({ lotId, qty: takeQty, costBasis: consumed });
            runningCost += consumed;
            remaining   -= takeQty;
            const leftover = lotQty - takeQty;
            if (leftover < 1e-6) {
              await client.models.financeHoldingLot.delete({ id: lot.id });
              onSetLots((p) => p.filter((l) => l.id !== lot.id));
            } else {
              const newCost = lot.costBasis != null ? lot.costBasis - consumed : null;
              await client.models.financeHoldingLot.update({
                id: lot.id, quantity: leftover, costBasis: newCost,
              });
              onSetLots((p) => p.map((l) => l.id === lot.id ? { ...l, quantity: leftover, costBasis: newCost } : l));
            }
          }
          consumedCostBasis   = runningCost || null;
          lotConsumptionsJson = breakdown.length > 0 ? JSON.stringify(breakdown) : null;
          firstLotId          = breakdown[0]?.lotId ?? null;
        }

        const { data: newTx } = await client.models.financeTransaction.create({
          accountId:         txDraft.accountId!,
          amount:            effectiveAmount,
          type:              txType as any,
          category:          txDraft.category ?? null,
          description:       description,
          date:              txDraft.date!,
          status:            (txDraft.status ?? "POSTED") as any,
          goalId:            txDraft.goalId ?? null,
          toAccountId:       txDraft.toAccountId ?? null,
          importHash:        txDraft.importHash ?? null,
          ticker:            isTradeType(txType) ? (txDraft.ticker ?? "").toUpperCase() : null,
          quantity:          isTradeType(txType) ? txDraft.quantity ?? null : null,
          lotId:             txType === "BUY" ? createdLotId : firstLotId,
          consumedCostBasis: consumedCostBasis,
          lotConsumptions:   lotConsumptionsJson,
          notes:             txDraft.notes ?? null,
        });
        if (newTx) {
          if (createdLot) onSetLots((p) => [...p, createdLot!]);
          // Trades aren't recurring cash; skip the auto-link for them.
          const candidates = isTradeType(txType) ? [] : findRecurringMatches(newTx, recurrings);
          let linked: TransactionRecord = newTx;
          if (candidates[0] && candidates[0].score >= RECURRING_MATCH_AUTO_THRESHOLD) {
            await applyRecurringMatch(client, newTx, candidates[0].rule);
            linked = { ...newTx, recurringId: candidates[0].rule.id } as unknown as TransactionRecord;
          }
          onSetTransactions((prev) => [linked, ...prev]);
          if (isPosted) await adjustBalance(txDraft.accountId!, effectiveAmount, txDraft.toAccountId ?? null, txType);

          // Trade fees → sibling EXPENSE so the cash side reflects what the
          // brokerage moved. Linked back via notes for traceability.
          if (isTradeType(txType) && feesNum > 0) {
            const ticker = (txDraft.ticker ?? "").toUpperCase();
            const feeDesc = `Fees for ${txType} ${txDraft.quantity} ${ticker} on ${txDraft.date}`;
            const { data: feeTx } = await client.models.financeTransaction.create({
              accountId:   txDraft.accountId!,
              amount:      -feesNum,
              type:        "EXPENSE" as any,
              category:    "Trading fees",
              description: feeDesc,
              date:        txDraft.date!,
              status:      (txDraft.status ?? "POSTED") as any,
              goalId:      null,
              toAccountId: null,
              notes:       `tradeTxId:${newTx.id}`,
            });
            if (feeTx) {
              onSetTransactions((prev) => [feeTx, ...prev]);
              if (isPosted) await adjustBalance(txDraft.accountId!, -feesNum, null, "EXPENSE");
            }
          }
        }

      } else if (mode === "edit" && editingTx) {
        const prev = editingTx;
        const editingTrade = isTradeType(prev.type as any);
        await client.models.financeTransaction.update({
          id:          prev.id,
          accountId:   editingTrade ? prev.accountId : txDraft.accountId!,
          amount:      editingTrade ? prev.amount    : txDraft.amount!,
          type:        editingTrade ? (prev.type as any) : ((txDraft.type ?? "EXPENSE") as any),
          category:    txDraft.category ?? null,
          description: txDraft.description ?? null,
          date:        txDraft.date!,
          status:      (txDraft.status ?? "POSTED") as any,
          goalId:      txDraft.goalId ?? null,
          toAccountId: txDraft.toAccountId ?? null,
          recurringId: txDraft.recurringId ?? null,
          notes:       txDraft.notes ?? null,
        });

        if (!editingTrade) {
          if (prev.status === "POSTED") await adjustBalance(prev.accountId!, -(prev.amount ?? 0), prev.toAccountId ?? null, prev.type as TxType);
          if (isPosted)                 await adjustBalance(txDraft.accountId!, txDraft.amount!, txDraft.toAccountId ?? null, txDraft.type as TxType);
        } else {
          if (prev.status !== "POSTED" && isPosted) {
            await adjustBalance(prev.accountId!, prev.amount ?? 0, null, prev.type as TxType);
          } else if (prev.status === "POSTED" && !isPosted) {
            await adjustBalance(prev.accountId!, -(prev.amount ?? 0), null, prev.type as TxType);
          }
        }

        onSetTransactions((p) => p.map((t) => t.id === prev.id ? { ...t, ...txDraft } as TransactionRecord : t));
        // Refetch accounts to defeat any drift between optimistic +/- ops above.
        const accs = await listAll(client.models.financeAccount);
        onSetAccounts(accs);
      }

      onClose();
    } finally {
      setSaving(false);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (mode !== "edit" || !editingTx) return;
    const tx = editingTx;
    const msg = isTradeType(tx.type as any)
      ? "Delete this trade? The cash side will be reversed but the lot side won't be — you may need to fix up the holding lot manually."
      : "Delete this transaction?";
    if (!confirm(msg)) return;
    setSaving(true);
    try {
      if (tx.status === "POSTED") await adjustBalance(tx.accountId!, -(tx.amount ?? 0), tx.toAccountId ?? null, tx.type as TxType);
      await deleteAttachmentsFor("TRANSACTION", tx.id);
      await client.models.financeTransaction.delete({ id: tx.id });
      onSetTransactions((p) => p.filter((t) => t.id !== tx.id));
      const accs = await listAll(client.models.financeAccount);
      onSetAccounts(accs);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  // ── Trade subform derived values (computed inside the JSX block below). ──
  const isEditing = mode === "edit";
  const isEditingTrade = isEditing && editingTx ? isTradeType(editingTx.type as any) : false;

  return (
    <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
        <h2 className="text-base font-semibold dark:text-rose text-purple">
          {mode === "create" ? "New Transaction" : "Edit Transaction"}
        </h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        <div>
          <label className={labelCls}>Account *</label>
          <select
            className={inputCls}
            disabled={!!lockAccount && mode === "create"}
            value={txDraft.accountId ?? ""}
            onChange={(e) => setTxDraft((d) => ({ ...d, accountId: e.target.value }))}>
            <option value="">Select account…</option>
            {accounts.filter((a) => a.active !== false).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Type</label>
            <select className={inputCls} value={txDraft.type ?? "EXPENSE"}
              disabled={isEditingTrade}
              onChange={(e) => {
                const newType = e.target.value as TxType;
                setTxDraft((d) => {
                  const raw = Math.abs(d.amount ?? 0);
                  const positive = newType === "INCOME" || newType === "SELL";
                  return { ...d, type: newType as any, amount: positive ? raw : -raw };
                });
              }}>
              <option value="INCOME">Income</option>
              <option value="EXPENSE">Expense</option>
              <option value="TRANSFER">Transfer</option>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Status</label>
            <select className={inputCls} value={txDraft.status ?? "POSTED"}
              onChange={(e) => setTxDraft((d) => ({ ...d, status: e.target.value as any }))}>
              <option value="POSTED">Posted</option>
              <option value="PENDING">Pending</option>
            </select>
          </div>
        </div>

        {!isTradeType(txDraft.type as any) && (
          <div>
            <label className={labelCls}>Amount *</label>
            <input type="number" step="0.01" min="0" className={inputCls} placeholder="0.00"
              value={Math.abs(txDraft.amount ?? 0) || ""}
              onChange={(e) => {
                const raw = parseFloat(e.target.value) || 0;
                const positive = txDraft.type === "INCOME";
                const signed = positive ? Math.abs(raw) : -Math.abs(raw);
                setTxDraft((d) => ({ ...d, amount: signed }));
              }} />
          </div>
        )}

        {/* Trade subform — BUY/SELL with price, qty, fees, and (SELL) multi-lot
            ordered picker. Locked in edit mode (the snapshot is shown read-only). */}
        {isTradeType(txDraft.type as any) && (() => {
          const sellableLots = txDraft.type === "SELL"
            ? lots
                .filter((l) =>
                  l.accountId === txDraft.accountId
                  && (l.quantity ?? 0) > 0
                  && (!txDraft.ticker || (l.ticker ?? "").toUpperCase() === (txDraft.ticker ?? "").toUpperCase()),
                )
                .sort((a, b) => (a.purchaseDate ?? "").localeCompare(b.purchaseDate ?? ""))
            : [];
          const sellableById = new Map(sellableLots.map((l) => [l.id, l] as const));
          const orderedPicks = sellLotPicks
            .map((id) => sellableById.get(id))
            .filter((l): l is HoldingLotRecord => !!l);
          const unpicked = sellableLots.filter((l) => !sellLotPicks.includes(l.id));
          const priceNum = parseFloat(tradePrice) || 0;
          const qtyNum   = txDraft.quantity ?? 0;
          const grossAmt = priceNum * qtyNum;
          const feesNum  = Math.max(0, parseFloat(tradeFees) || 0);
          const selectedQty = orderedPicks.reduce((s, l) => s + (l.quantity ?? 0), 0);

          let runningCost = 0;
          let runningRemaining = qtyNum;
          for (const lot of orderedPicks) {
            if (runningRemaining <= 1e-6) break;
            const lotQty = lot.quantity ?? 0;
            const takeQty = Math.min(runningRemaining, lotQty);
            if (lot.costBasis != null && lotQty > 0) {
              runningCost += lot.costBasis * (takeQty / lotQty);
            }
            runningRemaining -= takeQty;
          }
          const consumedPreview = qtyNum > 0 && runningRemaining <= 1e-6 ? runningCost : null;
          const gainPreview = consumedPreview != null && txDraft.type === "SELL" ? grossAmt - consumedPreview : null;

          function moveLot(lotId: string, dir: "up" | "down") {
            setSellLotPicks((picks) => {
              const idx = picks.indexOf(lotId);
              if (idx < 0) return picks;
              const swap = dir === "up" ? idx - 1 : idx + 1;
              if (swap < 0 || swap >= picks.length) return picks;
              const next = [...picks];
              [next[idx], next[swap]] = [next[swap], next[idx]];
              return next;
            });
          }

          return (
            <div className="rounded border border-gray-200 dark:border-darkBorder p-3 flex flex-col gap-3 bg-gray-50/50 dark:bg-white/[0.02]">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Ticker *</label>
                  <input type="text" className={inputCls} placeholder="SWPPX"
                    disabled={isEditingTrade}
                    value={txDraft.ticker ?? ""}
                    onChange={(e) => {
                      const t = e.target.value.toUpperCase();
                      setTxDraft((d) => ({ ...d, ticker: t }));
                      if (txDraft.type === "SELL") setSellLotPicks([]);
                    }} />
                </div>
                <div>
                  <label className={labelCls}>Quantity *</label>
                  <input type="number" step="0.0001" min="0" className={inputCls} placeholder="0"
                    disabled={isEditingTrade}
                    value={txDraft.quantity ?? ""}
                    onChange={(e) => setTxDraft((d) => ({ ...d, quantity: parseFloat(e.target.value) || 0 }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Price per share *</label>
                  <input type="number" step="0.0001" min="0" className={inputCls} placeholder="0.00"
                    disabled={isEditingTrade}
                    value={tradePrice}
                    onChange={(e) => setTradePrice(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Fees</label>
                  <input type="number" step="0.01" min="0" className={inputCls} placeholder="0.00"
                    disabled={isEditingTrade}
                    value={tradeFees}
                    onChange={(e) => setTradeFees(e.target.value)} />
                  <p className="text-[10px] text-gray-400 mt-0.5">Logged as a separate expense.</p>
                </div>
              </div>

              {(priceNum > 0 && qtyNum > 0) && (
                <div className="rounded bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder px-3 py-2 flex flex-col gap-0.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">
                      {txDraft.type === "BUY" ? "Cash out" : "Cash in"} ({fmtCurrency(priceNum, "USD")} × {qtyNum})
                    </span>
                    <span className="tabular-nums font-medium" style={{ color: amountColor(txDraft.type === "BUY" ? -grossAmt : grossAmt) }}>
                      {fmtCurrency(txDraft.type === "BUY" ? -grossAmt : grossAmt, "USD", true)}
                    </span>
                  </div>
                  {feesNum > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">+ Fees expense</span>
                      <span className="tabular-nums font-medium" style={{ color: amountColor(-feesNum) }}>
                        {fmtCurrency(-feesNum, "USD", true)}
                      </span>
                    </div>
                  )}
                  {gainPreview != null && (
                    <div className="flex justify-between pt-1 border-t border-gray-200 dark:border-gray-700">
                      <span className="text-gray-500 dark:text-gray-400">Realized gain</span>
                      <span className="tabular-nums font-semibold" style={{ color: amountColor(gainPreview) }}>
                        {fmtCurrency(gainPreview, "USD", true)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {txDraft.type === "SELL" && !isEditingTrade && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <label className={labelCls}>Lots to consume *</label>
                    {orderedPicks.length > 0 && (
                      <span className="text-[10px] text-gray-400 tabular-nums">
                        selected {selectedQty.toLocaleString("en-US", { maximumFractionDigits: 4 })} / need {qtyNum.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                      </span>
                    )}
                  </div>
                  {orderedPicks.length > 0 && (
                    <div className="flex flex-col gap-1">
                      {orderedPicks.map((lot, idx) => (
                        <div key={lot.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated">
                          <span className="text-xs tabular-nums text-gray-400 w-5">{idx + 1}.</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-gray-700 dark:text-gray-200 truncate">
                              {(lot.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} sh
                              {lot.purchaseDate ? ` · ${lot.purchaseDate}` : ""}
                            </p>
                            <p className="text-[10px] text-gray-400">
                              {lot.costBasis != null ? `cost ${fmtCurrency(lot.costBasis, "USD")}` : "no cost basis"}
                            </p>
                          </div>
                          <button type="button" onClick={() => moveLot(lot.id, "up")} disabled={idx === 0}
                            title="Consume earlier" className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30 w-5">▲</button>
                          <button type="button" onClick={() => moveLot(lot.id, "down")} disabled={idx === orderedPicks.length - 1}
                            title="Consume later" className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-30 w-5">▼</button>
                          <button type="button" onClick={() => setSellLotPicks((p) => p.filter((id) => id !== lot.id))}
                            title="Remove" className="text-xs text-gray-400 hover:text-red-500 w-5">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {unpicked.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {orderedPicks.length > 0 && (
                        <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Available</p>
                      )}
                      {unpicked.map((lot) => (
                        <button key={lot.id} type="button" onClick={() => setSellLotPicks((p) => [...p, lot.id])}
                          className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-gray-200 dark:border-darkBorder hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-white/5 text-left transition-colors">
                          <span className="text-gray-400 text-xs">+</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-gray-700 dark:text-gray-200 truncate">
                              {(lot.quantity ?? 0).toLocaleString("en-US", { maximumFractionDigits: 4 })} sh
                              {lot.purchaseDate ? ` · ${lot.purchaseDate}` : ""}
                            </p>
                            <p className="text-[10px] text-gray-400">
                              {lot.costBasis != null ? `cost ${fmtCurrency(lot.costBasis, "USD")}` : "no cost basis"}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : sellableLots.length === 0 && txDraft.accountId ? (
                    <p className="text-[10px] text-amber-500">No matching lots on this account. Add a lot or BUY first.</p>
                  ) : null}
                  {qtyNum > 0 && selectedQty + 1e-6 < qtyNum && orderedPicks.length > 0 && (
                    <p className="text-[10px] text-amber-500">
                      Selected lots are short {(qtyNum - selectedQty).toLocaleString("en-US", { maximumFractionDigits: 4 })} sh.
                    </p>
                  )}
                </div>
              )}

              {isEditingTrade && editingTx && (() => {
                const breakdown = parseLotConsumptions(editingTx);
                return (
                  <>
                    {breakdown.length > 0 && (
                      <div className="flex flex-col gap-1">
                        <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Lots consumed</p>
                        {breakdown.map((b, idx) => (
                          <div key={`${b.lotId}-${idx}`}
                            className="flex items-center justify-between px-2 py-1.5 rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs">
                            <span className="text-gray-700 dark:text-gray-200">
                              {idx + 1}. {b.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} sh
                            </span>
                            <span className="text-gray-400 tabular-nums">cost {fmtCurrency(b.costBasis, "USD")}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-gray-400">
                      Trade-side fields are locked in edit mode. Delete and recreate to change ticker, qty, price, or lots.
                    </p>
                  </>
                );
              })()}
            </div>
          );
        })()}

        <div>
          <label className={labelCls}>Date *</label>
          <input type="date" className={inputCls} value={txDraft.date ?? ""}
            onChange={(e) => {
              const newDate = e.target.value;
              setTxDraft((d) => ({
                ...d,
                date: newDate,
                ...(mode === "create" && newDate > today
                  ? { status: "PENDING" }
                  : mode === "create" && newDate <= today
                  ? { status: "POSTED" }
                  : {}),
              }));
            }} />
        </div>
        <div>
          <label className={labelCls}>Description</label>
          <input type="text" className={inputCls} placeholder="e.g. Rent, Salary…"
            value={txDraft.description ?? ""}
            onChange={(e) => setTxDraft((d) => ({ ...d, description: e.target.value }))} />
        </div>
        <div>
          <label className={labelCls}>Category</label>
          <input type="text" className={inputCls} placeholder="e.g. Housing, Food…"
            value={txDraft.category ?? ""}
            onChange={(e) => setTxDraft((d) => ({ ...d, category: e.target.value }))} />
        </div>
        <div>
          <label className={labelCls}>Notes</label>
          <textarea rows={3} className={`${inputCls} resize-none`} placeholder="Free-form context…"
            value={txDraft.notes ?? ""}
            onChange={(e) => setTxDraft((d) => ({ ...d, notes: e.target.value }))} />
          <p className="text-[10px] text-gray-400 mt-0.5">Searchable. Kept separate from the bank-imported description.</p>
        </div>
        {txDraft.type === "TRANSFER" && (
          <div>
            <label className={labelCls}>To Account</label>
            <select className={inputCls} value={txDraft.toAccountId ?? ""}
              onChange={(e) => setTxDraft((d) => ({ ...d, toAccountId: e.target.value }))}>
              <option value="">Select destination…</option>
              {accounts.filter((a) => a.id !== txDraft.accountId && a.active !== false).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Linked recurring rule block (edit only). */}
        {mode === "edit" && (() => {
          const candidateTx = {
            accountId:   txDraft.accountId,
            amount:      txDraft.amount,
            type:        txDraft.type,
            category:    txDraft.category,
            description: txDraft.description,
            date:        txDraft.date,
          } as TransactionRecord;
          const candidates = findRecurringMatches(candidateTx, recurrings);
          const linked = txDraft.recurringId ? recurringById.get(txDraft.recurringId) : null;
          return (
            <>
              {linked && (
                <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 flex items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Linked to recurring</span>
                    <span className="text-xs text-gray-700 dark:text-gray-200">{linked.description ?? "(deleted rule)"}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setShowMatchCandidates((v) => !v)}
                      className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors">
                      {showMatchCandidates ? "Hide" : "Change…"}
                    </button>
                    <button type="button" onClick={() => setTxDraft((d) => ({ ...d, recurringId: null as any }))}
                      className="text-[11px] text-gray-400 hover:text-red-500 transition-colors">
                      Unlink
                    </button>
                  </div>
                </div>
              )}
              {(!linked || showMatchCandidates) && candidates.length > 0 && (
                <div className="rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-3 py-2 flex flex-col gap-1.5">
                  <span className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                    {linked ? "Change to…" : "Suggested matches"}
                  </span>
                  {candidates.slice(0, 5).map(({ rule, score, reasons }) => (
                    <button key={rule.id} type="button"
                      onClick={() => {
                        setTxDraft((d) => ({ ...d, recurringId: rule.id }));
                        setShowMatchCandidates(false);
                      }}
                      className="w-full text-left rounded border border-gray-200 dark:border-darkBorder hover:border-gray-300 dark:hover:border-gray-500 px-2 py-1.5 transition-colors flex items-center justify-between gap-2"
                      title={reasons.join(" · ")}>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{rule.description}</p>
                        <p className="text-[10px] text-gray-400">
                          {fmtCurrency(rule.amount, "USD", true)} · next {rule.nextDate ? fmtDate(rule.nextDate) : "—"}
                        </p>
                      </div>
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}>
                        {Math.round(score)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!linked && candidates.length === 0 && (
                <p className="text-[11px] text-gray-400 italic">No recurring rules match this transaction.</p>
              )}
            </>
          );
        })()}

        <div className="border-t border-gray-200 dark:border-darkBorder pt-4">
          <AttachmentsSection
            parentType="TRANSACTION"
            parentId={mode === "edit" && editingTx ? editingTx.id : null}
            disabled={mode === "create"}
          />
        </div>
        <SaveButton saving={saving} onSave={handleSave}
          label={mode === "create" ? "Add Transaction" : "Save"} />
        {mode === "edit" && (
          <DeleteButton saving={saving} onDelete={handleDelete} />
        )}
      </div>
    </div>
  );
}
