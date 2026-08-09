/**
 * components/finance/WeeklyOutlook.tsx
 *
 * The Monday cashflow email, live in the UI. Runs the SAME pure engine
 * (components/finance/cashflow.ts → analyzeCashflow) that the weeklyCashflow
 * Lambda uses, on the accounts + recurring rules the dashboard already loaded —
 * so the card and the email never drift. Horizon is user-adjustable (7/14/30d);
 * the email is fixed at its own default.
 */

import React, { useMemo, useState } from "react";
import { analyzeCashflow } from "./cashflow";
import type { AccountRecord, RecurringRecord } from "./data";
import { fmtCurrency, fmtDate, todayIso, FINANCE_COLOR } from "./_shared";
import { POSITIVE, NEGATIVE, WARNING, withAlpha } from "@/lib/colors";

const BUFFER = 750;
const HORIZONS = [7, 14, 30] as const;

export function WeeklyOutlook({
  accounts,
  recurrings,
}: {
  accounts: AccountRecord[];
  recurrings: RecurringRecord[];
}) {
  // Default to 14d to match the Monday email exactly (the engine's own default).
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(14);

  const res = useMemo(() => {
    const accs = accounts
      .filter((a) => a.active !== false)
      .map((a) => ({
        id: a.id, name: a.name, type: a.type as string, currentBalance: a.currentBalance ?? 0,
        creditLimit: a.creditLimit, apr: a.apr,
        statementClosingDay: a.statementClosingDay, statementDueDay: a.statementDueDay,
      }));
    const recs = recurrings.map((r) => ({
      id: r.id, description: r.description ?? "", amount: r.amount ?? 0, type: r.type as string,
      category: r.category, cadence: r.cadence as string, nextDate: r.nextDate,
      startDate: r.startDate, endDate: r.endDate, active: r.active,
      accountId: r.accountId, toAccountId: r.toAccountId,
    }));
    return analyzeCashflow(accs, recs, { todayIso: todayIso(), horizonDays: horizon, buffer: BUFFER });
  }, [accounts, recurrings, horizon]);

  const income = res.incomeEvents.reduce((s, e) => s + e.amount, 0);
  const bills = res.bills.reduce((s, b) => s + b.amount, 0); // negative
  const hasActions = res.moves.length > 0 || res.actions.length > 0;

  return (
    <section className="rounded-lg border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-100 dark:border-darkBorder">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-purple dark:text-rose">💸 Cashflow Outlook</h2>
          {res.salaryWeek && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full"
              style={{ backgroundColor: withAlpha(POSITIVE, 0x22), color: POSITIVE }}>
              Salary week
            </span>
          )}
        </div>
        <div className="inline-flex rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden text-xs">
          {HORIZONS.map((h) => (
            <button key={h} onClick={() => setHorizon(h)}
              className={`px-2.5 py-1 transition-colors ${horizon === h ? "text-white" : "text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5"}`}
              style={horizon === h ? { backgroundColor: FINANCE_COLOR } : undefined}>
              {h}d
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 flex flex-col gap-4">
        {/* Action items */}
        {hasActions ? (
          <div className="rounded-lg border p-3" style={{ borderColor: withAlpha(WARNING, 0x55), backgroundColor: withAlpha(WARNING, 0x14) }}>
            <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: WARNING }}>⚠ Action needed</div>
            <ul className="flex flex-col gap-1 text-sm text-gray-700 dark:text-gray-200">
              {res.moves.map((m, i) => <li key={`m${i}`}>• {m}</li>)}
              {res.actions.map((a, i) => (
                <li key={`a${i}`}>• Pay <span className="font-semibold">{fmtCurrency(a.amount)}</span> on {a.card} — {a.reason}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="text-sm text-gray-500 dark:text-gray-400" style={{ color: POSITIVE }}>
            ✓ On track — no moves needed in the next {horizon} days.
          </div>
        )}

        {/* Summary */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Income" value={fmtCurrency(income)} color={POSITIVE} />
          <Stat label="Bills" value={fmtCurrency(bills)} color={NEGATIVE} />
          <Stat label="Net" value={fmtCurrency(income + bills)} color={income + bills >= 0 ? POSITIVE : NEGATIVE} />
        </div>

        {/* Per-account projections */}
        {res.projections.length > 0 && (
          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-gray-400 mb-1">Projected balances</div>
            <div className="flex flex-col divide-y divide-gray-100 dark:divide-darkBorder">
              {res.projections.map((p) => {
                const low = p.minBalance < BUFFER;
                return (
                  <div key={p.id} className="flex items-center justify-between py-1.5 text-sm">
                    <span className="text-gray-700 dark:text-gray-200 truncate mr-2">{p.name}</span>
                    <span className="flex items-center gap-2 tabular-nums whitespace-nowrap">
                      <span className="text-gray-400">{fmtCurrency(p.start)}</span>
                      <span className="text-gray-300 dark:text-gray-600">→</span>
                      <span title={low ? `Dips to ${fmtCurrency(p.minBalance)} on ${fmtDate(p.minDate)}` : undefined}
                        style={{ color: low ? NEGATIVE : undefined }} className={low ? "font-semibold" : "text-gray-500 dark:text-gray-400"}>
                        {low ? `⚠ ${fmtCurrency(p.minBalance)}` : fmtCurrency(p.end)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Cards due */}
        {res.statementsDue.length > 0 && (
          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest text-gray-400 mb-1">Cards due</div>
            <div className="flex flex-col gap-1 text-sm">
              {res.statementsDue.map((s, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-gray-700 dark:text-gray-200">{s.card}</span>
                  <span className="tabular-nums text-gray-500 dark:text-gray-400">
                    {fmtCurrency(s.approxAmount)}{s.approxDate ? "~" : ""} · due {fmtDate(s.dueDate)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Bills by category (collapsible) */}
        {res.billsByCategory.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-[11px] font-mono uppercase tracking-widest text-gray-400 hover:text-gray-500">
              Bills by category ({res.billsByCategory.length})
            </summary>
            <div className="mt-2 flex flex-col gap-1">
              {res.billsByCategory.map((c) => (
                <div key={c.category} className="flex items-center justify-between">
                  <span className="text-gray-600 dark:text-gray-300">{c.category}</span>
                  <span className="tabular-nums" style={{ color: NEGATIVE }}>{fmtCurrency(c.total)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-darkElevated py-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-gray-400">{label}</div>
      <div className="text-sm font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  );
}
