import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, TransactionRecord, RecurringRecord, GoalRecord,
  HoldingLotRecord, TickerQuoteRecord, AssetRecord, LoanRecord,
  GoalFundingSourceRecord, AccountSnapshotRecord,
  FINANCE_COLOR, CADENCE_LABELS,
  PHYSICAL_ASSET_TYPE_LABELS,
  fmtCurrency, fmtDate, todayIso, addMonths, nextOccurrence, advanceByCadence, monthsUntil,
  amountColor, goalPctColor, isRecurrenceLive,
  accountTotalValue, buildQuoteMap, isInvestedAccount,
  totalAssetValue, assetGainLoss,
  computeGoalAllocations, effectiveGoalAmount, goalHasFundingSource,
  projectGoal, resolvedGrowthRate,
  projectBalance, isProjectableAccount, daysToEOY,
  estimateTimeToZero,
  AccountBadge,
  listAll,
  type Cadence,
} from "@/components/finance/_shared";
import { Sparkline } from "@/components/common/sparkline";

// ── Skeleton placeholder ──────────────────────────────────────────────────
function SectionSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-4 rounded bg-gray-200 dark:bg-gray-700" style={{ width: `${70 + Math.random() * 30}%` }} />
      ))}
    </div>
  );
}

export default function FinanceDashboard() {
  const { authState } = useRequireAuth();

  // ── Per-section state + loading flags ──────────────────────────────────
  const [accounts,     setAccounts]     = useState<AccountRecord[]>([]);
  const [lots,         setLots]         = useState<HoldingLotRecord[]>([]);
  const [quotes,       setQuotes]       = useState<TickerQuoteRecord[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [recurrings,   setRecurrings]   = useState<RecurringRecord[]>([]);
  const [loadingUpcoming, setLoadingUpcoming] = useState(true);

  const [goals,        setGoals]        = useState<GoalRecord[]>([]);
  const [mappings,     setMappings]     = useState<GoalFundingSourceRecord[]>([]);
  const [loadingGoals, setLoadingGoals] = useState(true);

  const [assets,       setAssets]       = useState<AssetRecord[]>([]);
  const [loans,        setLoans]        = useState<LoanRecord[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(true);

  // Upcoming section: optional account filter for projected-balance view
  const [upcomingAccFilter, setUpcomingAccFilter] = useState<string[]>([]);

  // ── Parallel data fetching ────────────────────────────────────────────
  // Each group fetches independently and sets its own loading flag.
  // Sections render as soon as their data arrives.

  const [snapshots, setSnapshots] = useState<AccountSnapshotRecord[]>([]);

  const fetchAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      // Trailing 90 days of snapshots. 90 is enough to stabilize the daily
      // drift mean/stddev for projections (30 was too volatile) without
      // pulling years of data. Sparklines on the cards still look fine at
      // this width.
      const sinceIso = new Date(Date.now() - 90 * 24 * 3600 * 1000)
        .toISOString().slice(0, 10);
      const [accs, lotRecs, quoteRecs, snapRecs] = await Promise.all([
        listAll(client.models.financeAccount),
        listAll(client.models.financeHoldingLot),
        listAll(client.models.financeTickerQuote),
        listAll(client.models.financeAccountSnapshot, { date: { ge: sinceIso } }),
      ]);
      setAccounts(accs);
      setLots(lotRecs);
      setQuotes(quoteRecs);
      setSnapshots(snapRecs);
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  const fetchUpcoming = useCallback(async () => {
    setLoadingUpcoming(true);
    try {
      const [txs, recs] = await Promise.all([
        listAll(client.models.financeTransaction),
        listAll(client.models.financeRecurring),
      ]);
      setTransactions(txs);
      setRecurrings(recs);
    } finally {
      setLoadingUpcoming(false);
    }
  }, []);

  const fetchGoals = useCallback(async () => {
    setLoadingGoals(true);
    try {
      const [gls, mappingRecs] = await Promise.all([
        listAll(client.models.financeSavingsGoal),
        listAll(client.models.financeGoalFundingSource),
      ]);
      setGoals(gls);
      setMappings(mappingRecs);
    } finally {
      setLoadingGoals(false);
    }
  }, []);

  const fetchAssets = useCallback(async () => {
    setLoadingAssets(true);
    try {
      const [assetRecs, loanRecs] = await Promise.all([
        listAll(client.models.financeAsset),
        listAll(client.models.financeLoan),
      ]);
      setAssets(assetRecs);
      setLoans(loanRecs);
    } finally {
      setLoadingAssets(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    // Fire all groups in parallel — each resolves independently
    fetchAccounts();
    fetchUpcoming();
    fetchGoals();
    fetchAssets();
  }, [authState, fetchAccounts, fetchUpcoming, fetchGoals, fetchAssets]);

  // ── Derived data ───────────────────────────────────────────────────────────

  const activeAccounts = accounts.filter((a) => a.active !== false);

  // Dashboard grid shows favorites only when any exist; otherwise falls back to all
  // active accounts so new users see something before starring anything.
  const favoriteAccounts = useMemo(() => activeAccounts.filter((a) => a.favorite), [activeAccounts]);
  const dashboardAccounts = favoriteAccounts.length > 0 ? favoriteAccounts : activeAccounts;
  const usingFavorites = favoriteAccounts.length > 0;

  const quoteMap = useMemo(() => buildQuoteMap(quotes), [quotes]);

  // Per-account trailing balance series for sparklines. Sorted oldest → newest
  // so the line reads left-to-right as days go by.
  const balanceSeriesByAccount = useMemo(() => {
    const m = new Map<string, number[]>();
    const byAcc = new Map<string, AccountSnapshotRecord[]>();
    for (const s of snapshots) {
      if (!s.accountId) continue;
      if (!byAcc.has(s.accountId)) byAcc.set(s.accountId, []);
      byAcc.get(s.accountId)!.push(s);
    }
    for (const [id, rows] of byAcc) {
      rows.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
      m.set(id, rows.map((r) => r.balance ?? 0));
    }
    return m;
  }, [snapshots]);

  // Per-account end-of-year projection, keyed by account id. Built once per
  // render of the account cards rather than inside each card's render — fewer
  // allocations, easier to reason about.
  const eoyProjectionByAccount = useMemo(() => {
    const horizon = daysToEOY();
    const m = new Map<string, ReturnType<typeof projectBalance>>();
    for (const acc of accounts) {
      if (!isProjectableAccount(acc.type)) continue;
      m.set(acc.id, projectBalance(acc, snapshots, recurrings, horizon));
    }
    return m;
  }, [accounts, snapshots, recurrings]);

  // Time-to-zero for CREDIT / LOAN accounts (trending toward zero balance).
  const timeToZeroByAccount = useMemo(() => {
    const m = new Map<string, NonNullable<ReturnType<typeof estimateTimeToZero>>>();
    for (const acc of accounts) {
      if (acc.type !== "CREDIT" && acc.type !== "LOAN") continue;
      const r = estimateTimeToZero(acc, snapshots, recurrings);
      if (r) m.set(acc.id, r);
    }
    return m;
  }, [accounts, snapshots, recurrings]);

  const activeAssets = useMemo(() => assets.filter((a) => a.active !== false), [assets]);
  const assetsTotal  = useMemo(() => totalAssetValue(assets), [assets]);

  // Sum of loan balances keyed by the asset they're secured against.
  const loanOwedByAssetId = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of loans) {
      if (!l.assetId) continue;
      m.set(l.assetId, (m.get(l.assetId) ?? 0) + (l.currentBalance ?? 0));
    }
    return m;
  }, [loans]);

  // Goal allocations: derived from mappings + account balances.
  const allocations = useMemo(
    () => computeGoalAllocations(accounts, goals, mappings, lots, quotes),
    [accounts, goals, mappings, lots, quotes],
  );

  // Total unallocated cash across all accounts that have at least one mapping.
  const unallocatedSummary = useMemo(() => {
    let total = 0;
    let accountCount = 0;
    for (const [, surplus] of allocations.surplusByAccount) {
      if (surplus > 0) {
        total += surplus;
        accountCount++;
      }
    }
    return { total, accountCount };
  }, [allocations]);

  // Net worth = total account value + active asset values.
  const netWorth =
    activeAccounts.reduce((sum, a) => sum + accountTotalValue(a, lots, quoteMap), 0) +
    assetsTotal;

  // Projected net worth at EOY (conservative floor) = current net worth shifted
  // by each projectable account's (conservative − current) delta. Non-projectable
  // accounts (brokerage, retirement, checking) contribute zero delta — market
  // noise or pass-through float that isn't sensibly extrapolated.
  const projectedNetWorthEOY = useMemo(() => {
    let delta = 0;
    for (const acc of activeAccounts) {
      const p = eoyProjectionByAccount.get(acc.id);
      if (!p) continue;
      delta += p.conservative - p.current;
    }
    return netWorth + delta;
  }, [activeAccounts, eoyProjectionByAccount, netWorth]);

  const today = todayIso();
  const in30  = addMonths(today, 1);

  // Upcoming: recurring occurrences + future-dated transactions
  type UpcomingEntry = { rec: RecurringRecord | null; tx: TransactionRecord | null; next: string; amount: number; description: string; category: string; accountId: string; cadence: string | null };

  const upcoming = useMemo(() => {
    const entries: UpcomingEntry[] = [];

    // Recurring occurrences
    const live = recurrings.filter(isRecurrenceLive);
    for (const r of live) {
      let cur = nextOccurrence(r.nextDate ?? r.startDate ?? today, r.cadence as Cadence, r.startDate ?? undefined);
      while (cur <= in30) {
        if (r.endDate && cur > r.endDate) break;
        if (cur >= today) {
          entries.push({
            rec: r, tx: null, next: cur,
            amount: r.amount ?? 0,
            description: r.description ?? "",
            category: r.category ?? "",
            accountId: r.accountId ?? "",
            cadence: r.cadence ?? null,
          });
        }
        const prev = cur;
        cur = advanceByCadence(cur, r.cadence as Cadence, r.startDate ?? undefined);
        if (cur <= prev) break;
      }
    }

    // Future transactions
    for (const t of transactions) {
      if ((t.date ?? "") >= today && (t.date ?? "") <= in30) {
        entries.push({
          rec: null, tx: t, next: t.date!,
          amount: t.amount ?? 0,
          description: t.description ?? "",
          category: t.category ?? "",
          accountId: t.accountId ?? "",
          cadence: null,
        });
      }
    }

    return entries.sort((a, b) => a.next.localeCompare(b.next));
  }, [recurrings, transactions, today, in30]);

  // Upcoming: income/expense totals (respect account filter)
  const upcomingFiltered = upcomingAccFilter.length > 0
    ? upcoming.filter((e) => upcomingAccFilter.includes(e.accountId))
    : upcoming;
  const upcomingIncome  = upcomingFiltered.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  const upcomingExpense = upcomingFiltered.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);

  // Projected balance
  const upcomingStartBalance = upcomingAccFilter.length > 0
    ? upcomingAccFilter.reduce((s, accId) => {
        const acc = accounts.find((a) => a.id === accId);
        return acc ? s + accountTotalValue(acc, lots, quoteMap) : s;
      }, 0)
    : 0;
  const upcomingProjected = useMemo(() => {
    if (upcomingAccFilter.length === 0) return [];
    let running = upcomingStartBalance;
    return upcomingFiltered.map((e) => {
      running += e.amount;
      return running;
    });
  }, [upcomingFiltered, upcomingStartBalance, upcomingAccFilter.length]);

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

        <div className="flex flex-col gap-6">

          {/* ── Net Worth + Account Balances ─────────────────────────── */}
          <section>
            {loadingAccounts ? (
              <>
                <div className="flex items-baseline gap-3 mb-3">
                  <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Net Worth</h2>
                  <div className="h-7 w-40 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-4 py-3 animate-pulse">
                      <div className="h-4 w-24 rounded bg-gray-200 dark:bg-gray-700 mb-2" />
                      <div className="h-6 w-32 rounded bg-gray-200 dark:bg-gray-700" />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Net Worth</h2>
                    <span
                      className="text-2xl font-bold tabular-nums"
                      style={{ color: netWorth >= 0 ? FINANCE_COLOR : "#ef4444" }}
                    >
                      {fmtCurrency(netWorth)}
                    </span>
                    {Math.abs(projectedNetWorthEOY - netWorth) > 1 && (
                      <span
                        className="text-[11px] text-gray-400 tabular-nums cursor-help"
                        title="Conservative floor: ~80% chance the EOY total is at least this. Aggregates the P20 projection of projectable accounts (savings, credit, loan, cash)."
                      >
                        → EOY ≥ {fmtCurrency(projectedNetWorthEOY)}
                      </span>
                    )}
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
                  <p className="text-sm text-gray-400">No accounts yet — <a href="/finance/accounts" className="underline" style={{ color: FINANCE_COLOR }}>add one</a>.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {dashboardAccounts.map((acc) => {
                      const totalValue = accountTotalValue(acc, lots, quoteMap);
                      const invested = isInvestedAccount(acc.type);
                      const positionsValue = invested ? totalValue - (acc.currentBalance ?? 0) : 0;
                      const series = balanceSeriesByAccount.get(acc.id) ?? [];
                      const sparkColor = totalValue >= 0 ? FINANCE_COLOR : "#ef4444";
                      const proj = eoyProjectionByAccount.get(acc.id);
                      const ttz  = timeToZeroByAccount.get(acc.id);
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
                          <div className="flex items-end justify-between gap-3">
                            <span
                              className="text-xl font-bold tabular-nums"
                              style={{ color: sparkColor }}
                            >
                              {fmtCurrency(totalValue, acc.currency ?? "USD")}
                            </span>
                            {series.length >= 2 && (
                              <Sparkline
                                points={series}
                                width={80}
                                height={24}
                                stroke={sparkColor}
                                fill={sparkColor + "22"}
                                title={`${series.length}-day balance trend`}
                              />
                            )}
                          </div>
                          {invested && (
                            <p className="text-[11px] text-gray-400 tabular-nums">
                              Cash {fmtCurrency(acc.currentBalance, acc.currency ?? "USD")}
                              {positionsValue !== 0 && (
                                <> · Positions {fmtCurrency(positionsValue, acc.currency ?? "USD")}</>
                              )}
                            </p>
                          )}
                          {/* EOY projection — cash-ish accounts only. Shows the
                              CONSERVATIVE P20 floor ("~80% chance of being at
                              least this"), not the mean. Hover for the full
                              breakdown with the mean + band. */}
                          {proj && Math.abs(proj.conservative - proj.current) > 1 && (() => {
                            const currency = acc.currency ?? "USD";
                            const rpad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
                            const breakdown =
                              `EOY projection (${proj.horizonDays}d horizon, 90d trailing data)\n` +
                              `  ${rpad("Current",       16)}${fmtCurrency(proj.current,       currency)}\n` +
                              `  ${rpad("+ Recurring",   16)}${fmtCurrency(proj.deterministic, currency, true)}\n` +
                              `  ${rpad("+ Trailing",    16)}${fmtCurrency(proj.stochastic,    currency, true)}\n` +
                              `  ${"─".repeat(28)}\n` +
                              `  ${rpad("Mean",          16)}${fmtCurrency(proj.projected,     currency)}\n` +
                              `  ${rpad("≥ P20 (shown)", 16)}${fmtCurrency(proj.conservative,  currency)}\n` +
                              `  ${rpad("≤ P80",         16)}${fmtCurrency(proj.optimistic,    currency)}\n` +
                              `Method: ${proj.method === "blended" ? "blended (recurring + trailing drift)" : "recurring-only (not enough snapshot history)"}`;
                            return (
                              <p
                                className="text-[11px] text-gray-400 tabular-nums cursor-help"
                                title={breakdown}
                              >
                                → EOY ≥ {fmtCurrency(proj.conservative, currency)}
                              </p>
                            );
                          })()}
                          {/* Time to payoff for credit / loan accounts */}
                          {ttz && (
                            <p className="text-[11px] tabular-nums" style={{ color: FINANCE_COLOR }}>
                              Payoff in ~{ttz.months} mo
                              {ttz.method === "recurring-only" && (
                                <span className="text-gray-400"> · recurring-only</span>
                              )}
                            </p>
                          )}
                          {acc.type === "CREDIT" && (acc.creditLimit ?? 0) > 0 && (() => {
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
              </>
            )}
          </section>

          {/* ── Assets ─────────────────────────────────────────────────────────── */}
          {loadingAssets ? (
            <section>
              <div className="flex items-baseline gap-3 mb-3">
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Assets</h2>
                <div className="h-5 w-28 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
              </div>
              <SectionSkeleton lines={2} />
            </section>
          ) : activeAssets.length > 0 && (
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

          {/* ── Upcoming (next 30 days) ────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                Upcoming · Next 30 Days
              </h2>
              {/* Account multi-select filter — needs accounts loaded */}
              {!loadingAccounts && (
                <div className="flex items-center gap-2">
                  {upcomingAccFilter.length > 0 && (
                    <button
                      onClick={() => setUpcomingAccFilter([])}
                      className="text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      Clear
                    </button>
                  )}
                  <select
                    className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-600 dark:text-gray-300 max-w-[200px]"
                    value=""
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      setUpcomingAccFilter((prev) =>
                        prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
                      );
                    }}
                  >
                    <option value="">
                      {upcomingAccFilter.length === 0 ? "Filter by account…" : `${upcomingAccFilter.length} account${upcomingAccFilter.length > 1 ? "s" : ""}`}
                    </option>
                    {accounts.filter((a) => a.active !== false).map((a) => (
                      <option key={a.id} value={a.id}>
                        {upcomingAccFilter.includes(a.id) ? "✓ " : ""}{a.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Selected account chips */}
            {upcomingAccFilter.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {upcomingAccFilter.map((accId) => {
                  const acc = accounts.find((a) => a.id === accId);
                  if (!acc) return null;
                  return (
                    <span key={accId}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border"
                      style={{ backgroundColor: FINANCE_COLOR + "18", color: FINANCE_COLOR, borderColor: FINANCE_COLOR + "55" }}
                    >
                      {acc.name}: {fmtCurrency(accountTotalValue(acc, lots, quoteMap))}
                      <button
                        onClick={() => setUpcomingAccFilter((p) => p.filter((x) => x !== accId))}
                        className="ml-0.5 hover:opacity-60"
                      >×</button>
                    </span>
                  );
                })}
                {upcomingAccFilter.length > 1 && (
                  <span className="text-[11px] text-gray-400 self-center ml-1">
                    Combined: <span className="font-semibold tabular-nums" style={{ color: amountColor(upcomingStartBalance) }}>{fmtCurrency(upcomingStartBalance)}</span>
                  </span>
                )}
              </div>
            )}

            {loadingUpcoming ? (
              <SectionSkeleton lines={5} />
            ) : upcomingFiltered.length === 0 ? (
              <p className="text-sm text-gray-400">
                {upcomingAccFilter.length > 0
                  ? "No upcoming items on the selected account(s) in the next 30 days."
                  : "No upcoming items in the next 30 days."}
              </p>
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
                    {upcomingAccFilter.length > 0 && (
                      <thead className="bg-gray-50 dark:bg-darkElevated border-b border-gray-200 dark:border-darkBorder">
                        <tr>
                          <th className="px-4 py-1.5 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Date</th>
                          <th className="px-4 py-1.5 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">Description</th>
                          <th className="px-4 py-1.5 text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Category</th>
                          <th className="px-4 py-1.5 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Amount</th>
                          <th className="px-4 py-1.5 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium">Balance</th>
                          <th className="px-4 py-1.5 text-right text-[10px] uppercase tracking-widest text-gray-400 font-medium hidden sm:table-cell">Cadence</th>
                        </tr>
                      </thead>
                    )}
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {upcomingFiltered.map((entry, idx) => (
                        <tr key={entry.tx ? `tx-${entry.tx.id}` : `rec-${entry.rec!.id}-${entry.next}`} className="hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                          <td className="px-4 py-2 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">{fmtDate(entry.next)}</td>
                          <td className="px-4 py-2 text-gray-800 dark:text-gray-200">
                            {entry.description}
                            {entry.tx && !entry.rec && (
                              <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">
                                {entry.tx.status === "PENDING" ? "Pending" : "Scheduled"}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-gray-400 text-xs hidden sm:table-cell">{entry.category}</td>
                          <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(entry.amount) }}>
                            {fmtCurrency(entry.amount, "USD", true)}
                          </td>
                          {upcomingAccFilter.length > 0 && (
                            <td className="px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap" style={{ color: amountColor(upcomingProjected[idx] ?? 0) }}>
                              {fmtCurrency(upcomingProjected[idx])}
                            </td>
                          )}
                          <td className="px-4 py-2 text-right text-xs text-gray-400 hidden sm:table-cell">
                            {entry.cadence ? CADENCE_LABELS[entry.cadence as Cadence] : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {/* ── Savings Goals ─────────────────────────────────────────── */}
          {loadingGoals ? (
            <section>
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">Savings Goals</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[1, 2].map((i) => (
                  <div key={i} className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-4 py-3 animate-pulse">
                    <div className="h-4 w-32 rounded bg-gray-200 dark:bg-gray-700 mb-2" />
                    <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 mb-2" />
                    <div className="h-3 w-24 rounded bg-gray-200 dark:bg-gray-700" />
                  </div>
                ))}
              </div>
            </section>
          ) : goals.length > 0 && (
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
          {loadingUpcoming ? (
            <section>
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">Recent Transactions</h2>
              <SectionSkeleton lines={4} />
            </section>
          ) : recentPosted.length > 0 && (
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
      </div>
    </FinanceLayout>
  );
}
