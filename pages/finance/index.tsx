import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord, RecurringRecord, GoalRecord,
  HoldingLotRecord, TickerQuoteRecord, AssetRecord, LoanRecord,
  GoalFundingSourceRecord,
  FINANCE_COLOR, CADENCE_LABELS,
  PHYSICAL_ASSET_TYPE_LABELS,
  fmtCurrency, fmtDate, todayIso, addMonths, nextOccurrence, advanceByCadence, monthsUntil,
  amountColor, goalPctColor, isRecurrenceLive,
  accountTotalValue, buildQuoteMap, isInvestedAccount,
  totalAssetValue, assetGainLoss,
  computeGoalAllocations, effectiveGoalAmount, goalHasFundingSource,
  projectGoal, resolvedGrowthRate,
  AccountBadge,
  listAll,
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
  const [loans,        setLoans]        = useState<LoanRecord[]>([]);
  const [mappings,     setMappings]     = useState<GoalFundingSourceRecord[]>([]);
  const [loading,      setLoading]      = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [
        accs,
        txs,
        recs,
        gls,
        lotRecs,
        quoteRecs,
        assetRecs,
        loanRecs,
        mappingRecs,
      ] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeTransaction),
        listAll(client.models.financeRecurring),
        listAll(client.models.financeSavingsGoal),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
        listAll(client.models.financeAsset),
        listAll(client.models.financeLoan),
        listAll(client.models.financeGoalFundingSource),
      ]);
      setAccounts(accs);
      setTransactions(txs);
      setRecurrings(recs);
      setGoals(gls);
      setLots(lotRecs);
      setQuotes(quoteRecs);
      setAssets(assetRecs);
      setLoans(loanRecs);
      setMappings(mappingRecs);
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

  // Dashboard grid shows favorites only when any exist; otherwise falls back to all
  // active accounts so new users see something before starring anything.
  const favoriteAccounts = useMemo(() => activeAccounts.filter((a) => a.favorite), [activeAccounts]);
  const dashboardAccounts = favoriteAccounts.length > 0 ? favoriteAccounts : activeAccounts;
  const usingFavorites = favoriteAccounts.length > 0;

  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  const activeAssets = useMemo(() => assets.filter((a) => a.active !== false), [assets]);
  const assetsTotal  = useMemo(() => totalAssetValue(assets), [assets]);

  // Sum of loan balances keyed by the asset they're secured against. Multiple loans
  // on one asset (e.g. mortgage + HELOC) sum together; assets with no loan are absent.
  const loanOwedByAssetId = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of loans) {
      if (!l.assetId) continue;
      m.set(l.assetId, (m.get(l.assetId) ?? 0) + (l.currentBalance ?? 0));
    }
    return m;
  }, [loans]);

  // Goal allocations: derived from mappings + account balances. See _shared for algorithm.
  const allocations = useMemo(
    () => computeGoalAllocations(accounts, goals, mappings, lots, quotes),
    [accounts, goals, mappings, lots, quotes],
  );

  // Total unallocated cash across all accounts that have at least one mapping.
  // Accounts with no mappings are ignored — they're not part of the goal system yet.
  const unallocatedSummary = useMemo(() => {
    let total = 0;
    let accountCount = 0;
    for (const [accountId, surplus] of allocations.surplusByAccount) {
      if (surplus > 0) {
        total += surplus;
        accountCount++;
      }
    }
    return { total, accountCount };
  }, [allocations]);

  // Total loan debt tied to assets — used so net worth subtracts it exactly once
  // (assets contribute their full value; loan accounts are their own line already via activeAccounts).
  // Note: we don't subtract owed here because loan accounts already carry a negative currentBalance
  // in activeAccounts — subtracting again would double-count the debt.

  // Net worth uses total account value (cash + positions for brokerage/retirement)
  // plus active asset values. Sign convention: credit owed = negative, assets = positive.
  const netWorth =
    activeAccounts.reduce((sum, a) => sum + accountTotalValue(a, lots, quoteMap), 0) +
    assetsTotal;

  const today = todayIso();
  const in30  = addMonths(today, 1);

  // Upcoming recurring in the next 30 days — expand ALL occurrences per recurrence,
  // not just the first one. A bi-weekly salary should show 2-3 entries in a 30-day window.
  const upcoming = useMemo(() => {
    const live = recurrings.filter(isRecurrenceLive);
    const entries: { rec: RecurringRecord; next: string }[] = [];

    for (const r of live) {
      let cur = nextOccurrence(r.nextDate ?? r.startDate ?? today, r.cadence as Cadence, r.startDate ?? undefined);

      // Walk forward generating every occurrence that falls within [today, in30]
      while (cur <= in30) {
        // Respect per-recurrence end date
        if (r.endDate && cur > r.endDate) break;

        if (cur >= today) {
          entries.push({ rec: r, next: cur });
        }

        // Advance to next occurrence
        const prev = cur;
        cur = advanceByCadence(cur, r.cadence as Cadence, r.startDate ?? undefined);
        // Safety: if advanceByCadence didn't move forward (shouldn't happen), break
        if (cur <= prev) break;
      }
    }

    return entries.sort((a, b) => a.next.localeCompare(b.next));
  }, [recurrings, today, in30]);

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
              <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Net Worth</h2>
                  <span
                    className="text-2xl font-bold tabular-nums"
                    style={{ color: netWorth >= 0 ? FINANCE_COLOR : "#ef4444" }}
                  >
                    {fmtCurrency(netWorth)}
                  </span>
                  {usingFavorites && (
                    <span className="text-[11px] text-gray-400">
                      Showing {favoriteAccounts.length} favorite{favoriteAccounts.length === 1 ? "" : "s"} of {activeAccounts.length}
                    </span>
                  )}
                </div>
                <a href="/finance/accounts" className="text-xs font-semibold" style={{ color: FINANCE_COLOR }}>
                  {usingFavorites ? "View all accounts →" : "Manage accounts →"}
                </a>
              </div>

              {activeAccounts.length === 0 ? (
                <p className="text-sm text-gray-400">No accounts yet — <a href="/finance/transactions" className="underline" style={{ color: FINANCE_COLOR }}>add one</a>.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {dashboardAccounts.map((acc) => {
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
                    const owed = loanOwedByAssetId.get(asset.id) ?? 0;
                    const hasLoan = owed > 0;
                    const equity = (asset.currentValue ?? 0) - owed;
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
                        {hasLoan && (
                          <div className="flex flex-col gap-0.5 pt-1 border-t border-gray-100 dark:border-gray-700 mt-0.5">
                            <p className="text-[11px] text-gray-400 tabular-nums flex justify-between gap-2">
                              <span>Owed</span>
                              <span className="font-semibold" style={{ color: "#ef4444" }}>{fmtCurrency(owed)}</span>
                            </p>
                            <p className="text-[11px] text-gray-400 tabular-nums flex justify-between gap-2">
                              <span>Equity</span>
                              <span className="font-semibold" style={{ color: amountColor(equity) }}>{fmtCurrency(equity)}</span>
                            </p>
                          </div>
                        )}
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
                          <tr key={`${rec.id}-${next}`} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
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
                <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
                  <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Savings Goals</h2>
                  {unallocatedSummary.total > 0 && (
                    <a
                      href="/finance/accounts"
                      className="text-[11px] text-gray-500 dark:text-gray-400 hover:underline"
                      title="Cash on mapped accounts that no goal has absorbed — click to manage accounts"
                    >
                      Unallocated:{" "}
                      <span className="tabular-nums font-semibold" style={{ color: "#f59e0b" }}>
                        {fmtCurrency(unallocatedSummary.total)}
                      </span>
                      {" "}across {unallocatedSummary.accountCount} account{unallocatedSummary.accountCount === 1 ? "" : "s"}
                    </a>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {goals.map((goal) => {
                    const current = effectiveGoalAmount(goal, allocations, mappings);
                    const target  = goal.targetAmount ?? 0;
                    const pct     = target > 0 ? Math.min(1, current / target) : 0;
                    const color   = goalPctColor(pct);
                    const months  = goal.targetDate ? monthsUntil(goal.targetDate) : null;
                    const hasMapping = goalHasFundingSource(goal, mappings);

                    // Growth-aware projection. If already on track from growth alone,
                    // monthly = null — card shows "on track" instead.
                    const growth = resolvedGrowthRate(goal);
                    const projection = months && months > 0
                      ? projectGoal(current, target, months, growth)
                      : null;
                    const monthly = projection?.requiredMonthlyContribution ?? null;
                    const onTrackFromGrowth = projection != null
                      && projection.requiredMonthlyContribution == null
                      && pct < 1;
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
                          <span>{fmtCurrency(current)} {hasMapping ? "allocated" : "saved"}</span>
                          <span>{fmtCurrency(target)} goal</span>
                        </div>
                        {goal.targetDate && (
                          <p className="text-[11px] text-gray-400">
                            {fmtDate(goal.targetDate)}
                            {onTrackFromGrowth && (
                              <> · <span className="font-medium text-green-500">on track from {Math.round(growth * 100)}% growth</span></>
                            )}
                            {monthly != null && monthly > 0 && months! > 0 && (
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
