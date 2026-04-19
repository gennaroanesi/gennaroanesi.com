import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord, RecurringRecord, GoalRecord,
  HoldingLotRecord, TickerQuoteRecord, AssetRecord,
  FINANCE_COLOR, CADENCE_LABELS,
  PHYSICAL_ASSET_TYPE_LABELS,
  fmtCurrency, fmtDate, todayIso, addMonths, nextOccurrence, monthsUntil,
  amountColor, goalPctColor, isRecurrenceLive,
  accountTotalValue, buildQuoteMap, isInvestedAccount,
  totalAssetValue, assetGainLoss,
  AccountBadge,
  type Cadence,
} from "@/components/finance/_shared";

export default function FinanceDashboard() {
  const { authState } = useRequireAuth();

  const [accounts,     setAccounts]     = useState<AccountRecord[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [recurrings,   setRecurrings]   = useState<RecurringRecord[]>([]);
  const [goals,        setGoals]        = useState<GoalRecord[]>([]);
  const [lots,         setLots]         = useState<HoldingLotRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [assets,       setAssets]       = useState<AssetRecord[]>([]);
  const [loading,      setLoading]      = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [
        { data: accs },
        { data: txs },
        { data: recs },
        { data: gls },
        { data: lotRecs },
        { data: quoteRecs },
        { data: assetRecs },
      ] = await Promise.all([
        client.models.financeAccount.list({ limit: 200 }),
        client.models.financeTransaction.list({ limit: 500 }),
        client.models.financeRecurring.list({ limit: 200 }),
        client.models.financeSavingsGoal.list({ limit: 100 }),
        client.models.financeHoldingLot.list({ limit: 500 }),
        client.models.financeTickerQuote.list({ limit: 500 }),
        client.models.financeAsset.list({ limit: 200 }),
      ]);
      setAccounts(accs ?? []);
      setTransactions(txs ?? []);
      setRecurrings(recs ?? []);
      setGoals(gls ?? []);
      setLots(lotRecs ?? []);
      setQuotes(quoteRecs ?? []);
      setAssets(assetRecs ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchAll();
  }, [authState, fetchAll]);

  // ── Derived data ───────────────────────────────────────────────────────────

  const activeAccounts = accounts.filter((a) => a.active !== false);

  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  const activeAssets = useMemo(() => assets.filter((a) => a.active !== false), [assets]);
  const assetsTotal  = useMemo(() => totalAssetValue(assets), [assets]);

  // Net worth uses total account value (cash + positions for brokerage/retirement)
  // plus active asset values. Sign convention: credit owed = negative, assets = positive.
  const netWorth =
    activeAccounts.reduce((sum, a) => sum + accountTotalValue(a, lots, quoteMap), 0) +
    assetsTotal;

  const today = todayIso();
  const in30  = addMonths(today, 1);

  // Upcoming recurring in the next 30 days
  const upcoming = recurrings
    .filter(isRecurrenceLive)
    .map((r) => ({
      rec:  r,
      next: nextOccurrence(r.nextDate ?? r.startDate ?? today, r.cadence as Cadence, r.startDate ?? undefined),
    }))
    // Respect per-recurrence end date (inclusive): drop occurrences that land beyond it
    .filter(({ rec, next }) => !rec.endDate || next <= rec.endDate)
    .filter(({ next }) => next >= today && next <= in30)
    .sort((a, b) => a.next.localeCompare(b.next));

  // Upcoming recurring income vs expense totals
  const upcomingIncome  = upcoming.filter(({ rec }) => (rec.amount ?? 0) > 0).reduce((s, { rec }) => s + (rec.amount ?? 0), 0);
  const upcomingExpense = upcoming.filter(({ rec }) => (rec.amount ?? 0) < 0).reduce((s, { rec }) => s + (rec.amount ?? 0), 0);

  // Recent posted transactions (last 10)
  const recentPosted = transactions
    .filter((t) => t.status === "POSTED")
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, 10);

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="px-4 py-5 md:px-8 md:py-6 overflow-auto h-full">
        <h1 className="text-2xl font-bold text-purple dark:text-rose mb-6">Finance</h1>

        {loading ? (
          <p className="text-sm text-gray-400 animate-pulse">Loading…</p>
        ) : (
          <div className="flex flex-col gap-6">

            {/* ── Net Worth + Account Balances ─────────────────────────── */}
            <section>
              <div className="flex items-baseline gap-3 mb-3">
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Net Worth</h2>
                <span
                  className="text-2xl font-bold tabular-nums"
                  style={{ color: netWorth >= 0 ? FINANCE_COLOR : "#ef4444" }}
                >
                  {fmtCurrency(netWorth)}
                </span>
              </div>

              {activeAccounts.length === 0 ? (
                <p className="text-sm text-gray-400">No accounts yet — <a href="/finance/transactions" className="underline" style={{ color: FINANCE_COLOR }}>add one</a>.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {activeAccounts.map((acc) => {
                    const totalValue = accountTotalValue(acc, lots, quoteMap);
                    const invested = isInvestedAccount(acc.type);
                    const positionsValue = invested ? totalValue - (acc.currentBalance ?? 0) : 0;
                    return (
                      <a
                        key={acc.id}
                        href={`/finance/accounts/${acc.id}`}
                        className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-4 py-3 flex flex-col gap-1 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{acc.name}</span>
                          <AccountBadge type={acc.type} />
                        </div>
                        <span
                          className="text-xl font-bold tabular-nums"
                          style={{ color: totalValue >= 0 ? FINANCE_COLOR : "#ef4444" }}
                        >
                          {fmtCurrency(totalValue, acc.currency ?? "USD")}
                        </span>
                        {invested && (
                          <p className="text-[11px] text-gray-400 tabular-nums">
                            Cash {fmtCurrency(acc.currentBalance, acc.currency ?? "USD")}
                            {positionsValue !== 0 && (
                              <> · Positions {fmtCurrency(positionsValue, acc.currency ?? "USD")}</>
                            )}
                          </p>
                        )}
                        {acc.type === "CREDIT" && (acc.creditLimit ?? 0) > 0 && (() => {
                          // currentBalance is negative when money is owed; flip to positive for utilization
                          const owed = Math.max(0, -(acc.currentBalance ?? 0));
                          const util = Math.min(1, owed / (acc.creditLimit ?? 1));
                          const color = util > 0.7 ? "#ef4444" : util > 0.3 ? "#f59e0b" : FINANCE_COLOR;
                          return (
                            <div className="flex flex-col gap-1">
                              <div className="h-1 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${util * 100}%`, backgroundColor: color }} />
                              </div>
                              <p className="text-[10px]" style={{ color }}>
                                {Math.round(util * 100)}% of {fmtCurrency(acc.creditLimit, acc.currency ?? "USD")} limit
                              </p>
                            </div>
                          );
                        })()}
                        {acc.notes && <p className="text-[11px] text-gray-400 truncate">{acc.notes}</p>}
                      </a>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── Assets ─────────────────────────────────────────────────────────── */}
            {activeAssets.length > 0 && (
              <section>
                <div className="flex items-baseline justify-between gap-3 mb-3">
                  <div className="flex items-baseline gap-3">
                    <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Assets</h2>
                    <span
                      className="text-lg font-bold tabular-nums"
                      style={{ color: assetsTotal >= 0 ? FINANCE_COLOR : "#ef4444" }}
                    >
                      {fmtCurrency(assetsTotal)}
                    </span>
                  </div>
                  <a href="/finance/assets" className="text-xs font-semibold" style={{ color: FINANCE_COLOR }}>
                    Manage →
                  </a>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {activeAssets.map((asset) => {
                    const gain = assetGainLoss(asset);
                    const label = PHYSICAL_ASSET_TYPE_LABELS[(asset.type ?? "OTHER") as keyof typeof PHYSICAL_ASSET_TYPE_LABELS];
                    return (
                      <a
                        key={asset.id}
                        href="/finance/assets"
                        className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-4 py-3 flex flex-col gap-1 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{asset.name}</span>
                          <span
                            className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide flex-shrink-0"
                            style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                          >
                            {label}
                          </span>
                        </div>
                        <span
                          className="text-xl font-bold tabular-nums"
                          style={{ color: (asset.currentValue ?? 0) >= 0 ? FINANCE_COLOR : "#ef4444" }}
                        >
                          {fmtCurrency(asset.currentValue)}
                        </span>
                        {gain != null && (
                          <p className="text-[11px] tabular-nums" style={{ color: amountColor(gain) }}>
                            {fmtCurrency(gain, "USD", true)} since purchase
                          </p>
                        )}
                      </a>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Upcoming Recurring (next 30 days) ────────────────────── */}
            <section>
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">
                Upcoming · Next 30 Days
              </h2>
              {upcoming.length === 0 ? (
                <p className="text-sm text-gray-400">No recurring items due in the next 30 days.</p>
              ) : (
                <>
                  <div className="flex gap-4 mb-3 text-sm">
                    <span>
                      <span className="text-gray-400 text-xs mr-1">Income</span>
                      <span className="font-semibold tabular-nums" style={{ color: "#22c55e" }}>{fmtCurrency(upcomingIncome)}</span>
                    </span>
                    <span>
                      <span className="text-gray-400 text-xs mr-1">Expenses</span>
                      <span className="font-semibold tabular-nums" style={{ color: "#ef4444" }}>{fmtCurrency(Math.abs(upcomingExpense))}</span>
                    </span>
                    <span>
                      <span className="text-gray-400 text-xs mr-1">Net</span>
                      <span
                        className="font-semibold tabular-nums"
                        style={{ color: amountColor(upcomingIncome + upcomingExpense) }}
                      >
                        {fmtCurrency(upcomingIncome + upcomingExpense, "USD", true)}
                      </span>
                    </span>
                  </div>
                  <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                        {upcoming.map(({ rec, next }) => (
                          <tr key={rec.id} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                            <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">{fmtDate(next)}</td>
                            <td className="px-4 py-2 text-gray-800 dark:text-gray-200">{rec.description}</td>
                            <td className="px-4 py-2 text-gray-400 text-xs">{rec.category}</td>
                            <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(rec.amount ?? 0) }}>
                              {fmtCurrency(rec.amount, "USD", true)}
                            </td>
                            <td className="px-4 py-2 text-right text-xs text-gray-400">{CADENCE_LABELS[rec.cadence as Cadence]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            {/* ── Savings Goals ─────────────────────────────────────────── */}
            {goals.length > 0 && (
              <section>
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">Savings Goals</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {goals.map((goal) => {
                    const pct     = (goal.targetAmount ?? 0) > 0 ? Math.min(1, (goal.currentAmount ?? 0) / (goal.targetAmount ?? 1)) : 0;
                    const color   = goalPctColor(pct);
                    const months  = goal.targetDate ? monthsUntil(goal.targetDate) : null;
                    const needed  = (goal.targetAmount ?? 0) - (goal.currentAmount ?? 0);
                    const monthly = months && months > 0 ? needed / months : null;
                    return (
                      <div
                        key={goal.id}
                        className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-4 py-3 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{goal.name}</span>
                          <span className="text-xs font-bold tabular-nums" style={{ color }}>{Math.round(pct * 100)}%</span>
                        </div>

                        {/* Progress bar */}
                        <div className="h-1.5 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct * 100}%`, backgroundColor: color }} />
                        </div>

                        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                          <span>{fmtCurrency(goal.currentAmount)} saved</span>
                          <span>{fmtCurrency(goal.targetAmount)} goal</span>
                        </div>
                        {goal.targetDate && (
                          <p className="text-[11px] text-gray-400">
                            {fmtDate(goal.targetDate)}
                            {monthly && months! > 0 && (
                              <> · <span className="font-medium">{fmtCurrency(monthly)}/mo needed</span></>
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Recent Transactions ──────────────────────────────────── */}
            {recentPosted.length > 0 && (
              <section>
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">Recent Transactions</h2>
                <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {recentPosted.map((tx) => {
                        const acc = accounts.find((a) => a.id === tx.accountId);
                        return (
                          <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                            <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">{fmtDate(tx.date)}</td>
                            <td className="px-4 py-2 text-gray-800 dark:text-gray-200 max-w-[200px] truncate">{tx.description}</td>
                            <td className="px-4 py-2 text-gray-400 text-xs hidden sm:table-cell">{tx.category}</td>
                            <td className="px-4 py-2 text-gray-400 text-xs hidden md:table-cell truncate">{acc?.name ?? "—"}</td>
                            <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(tx.amount ?? 0) }}>
                              {fmtCurrency(tx.amount, acc?.currency ?? "USD", true)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
