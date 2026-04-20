import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import { useRouter } from "next/router";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, LoanRecord, LoanPaymentRecord, AssetRecord,
  LOAN_TYPES, LOAN_TYPE_LABELS, LOAN_PAYMENT_STRATEGIES, LOAN_PAYMENT_STRATEGY_LABELS,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor,
  loanProgressPct, priceMonthlyPayment, amortize, addMonthsIso,
  inputCls, labelCls,
  SaveButton, EmptyState,
  listAll,
} from "@/components/finance/_shared";

type PanelState = { kind: "new" } | null;

type LoanDraft = {
  name:             string;
  loanType:         string;
  originalPrincipal: number | "";
  interestRatePct:  number | "";   // UI value (e.g. 4.5), stored as decimal (0.045)
  termMonths:       number | "";
  startDate:        string;
  firstPaymentDate: string;
  paymentStrategy:  string;
  assetId:          string;        // "" = none
  escrowAccountId:  string;        // "" = none
  lender:           string;
  notes:            string;
};

function emptyDraft(): LoanDraft {
  return {
    name:             "",
    loanType:         "MORTGAGE",
    originalPrincipal: "",
    interestRatePct:  "",
    termMonths:       "",
    startDate:        todayIso(),
    firstPaymentDate: "",
    paymentStrategy:  "PRICE_FIXED_PAYMENT",
    assetId:          "",
    escrowAccountId:  "",
    lender:           "",
    notes:            "",
  };
}

export default function LoansPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();

  const [loans,      setLoans]      = useState<LoanRecord[]>([]);
  const [accounts,   setAccounts]   = useState<AccountRecord[]>([]);
  const [assets,     setAssets]     = useState<AssetRecord[]>([]);
  const [payments,   setPayments]   = useState<LoanPaymentRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [panel,      setPanel]      = useState<PanelState>(null);
  const [draft,      setDraft]      = useState<LoanDraft>(emptyDraft());

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [ls, accs, ass, pays] = await Promise.all([
        listAll(client.models.financeLoan),
        listAll(client.models.financeAccount),
        listAll(client.models.financeAsset),
        listAll(client.models.financeLoanPayment),
      ]);
      setLoans(ls);
      setAccounts(accs);
      setAssets(ass);
      setPayments(pays);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.new === "1") {
      openNew();
      router.replace("/finance/loans", undefined, { shallow: true });
    }
  }, [router.isReady, router.query.new]);

  function openNew() {
    setDraft(emptyDraft());
    setPanel({ kind: "new" });
  }

  // ── Amortization preview (live, while user types) ─────────────────────────

  const preview = useMemo(() => {
    const p = Number(draft.originalPrincipal);
    const r = Number(draft.interestRatePct);
    const n = Number(draft.termMonths);
    if (!isFinite(p) || p <= 0 || !isFinite(r) || r < 0 || !isFinite(n) || n <= 0) return null;
    const rate = r / 100;
    const monthly = priceMonthlyPayment(p, rate, n);
    const totalPaid = monthly * n;
    const totalInterest = totalPaid - p;
    const payoff = draft.firstPaymentDate ? addMonthsIso(draft.firstPaymentDate, n - 1) : null;
    return { monthly, totalPaid, totalInterest, payoff };
  }, [draft.originalPrincipal, draft.interestRatePct, draft.termMonths, draft.firstPaymentDate]);

  // ── Create loan (atomic: account + loan + all scheduled payments) ─────────

  async function handleCreate() {
    if (!draft.name.trim()) return;
    const principal = Number(draft.originalPrincipal);
    const rate      = Number(draft.interestRatePct) / 100;
    const months    = Number(draft.termMonths);
    if (!isFinite(principal) || principal <= 0) { alert("Enter a valid principal"); return; }
    if (!isFinite(rate) || rate < 0) { alert("Enter a valid interest rate"); return; }
    if (!isFinite(months) || months <= 0) { alert("Enter a valid term"); return; }
    if (!draft.startDate || !draft.firstPaymentDate) { alert("Enter start and first payment dates"); return; }

    setSaving(true);
    try {
      // 1. Create the ledger account (LOAN type, negative balance = money owed)
      const { data: newAcc, errors: accErr } = await client.models.financeAccount.create({
        name:           draft.name.trim(),
        type:           "LOAN" as any,
        currentBalance: -principal,
        currency:       "USD",
        notes:          null,
        active:         true,
      });
      if (accErr?.length || !newAcc) throw new Error(accErr?.[0]?.message ?? "Failed to create account");

      // 2. Create the loan metadata record
      const { data: newLoan, errors: loanErr } = await client.models.financeLoan.create({
        accountId:         newAcc.id,
        loanType:          draft.loanType as any,
        originalPrincipal: principal,
        currentBalance:    principal,
        interestRate:      rate,
        termMonths:        months,
        startDate:         draft.startDate,
        firstPaymentDate:  draft.firstPaymentDate,
        paymentStrategy:   draft.paymentStrategy as any,
        assetId:           draft.assetId  || null,
        escrowAccountId:   draft.escrowAccountId || null,
        lender:            draft.lender.trim() || null,
        notes:             draft.notes.trim() || null,
      });
      if (loanErr?.length || !newLoan) {
        // Roll back the account we just created
        await client.models.financeAccount.delete({ id: newAcc.id });
        throw new Error(loanErr?.[0]?.message ?? "Failed to create loan");
      }

      // 3. Generate the full amortization schedule and write each row
      const schedule = amortize(principal, rate, months, draft.firstPaymentDate);
      for (const row of schedule) {
        await client.models.financeLoanPayment.create({
          loanId:         newLoan.id,
          status:         "SCHEDULED" as any,
          date:           row.date,
          sequenceNumber: row.sequenceNumber,
          totalAmount:    row.totalAmount,
          principal:      row.principal,
          interest:       row.interest,
          escrow:         null,
          fees:           null,
          isCorrection:   false,
          isExtraPayment: false,
          transactionId:  null,
          loanTransactionId: null,
          notes:          null,
        });
      }

      // Navigate to the detail page
      router.push(`/finance/loans/${newLoan.id}`);
    } catch (err: any) {
      console.error("[loans] create failed:", err);
      alert(`Failed to create loan: ${err?.message ?? String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  if (authState !== "authenticated") return null;

  // ── Group loans by type for display ───────────────────────────────────────
  const grouped: Record<string, LoanRecord[]> = {};
  for (const l of loans) {
    const t = (l.loanType ?? "OTHER") as string;
    (grouped[t] ??= []).push(l);
  }
  const groupOrder = LOAN_TYPES.filter((t) => grouped[t]?.length > 0);

  const totalDebt = loans.reduce((s, l) => s + (l.currentBalance ?? 0), 0);

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
          </div>

          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold text-purple dark:text-rose">Loans</h1>
              {loans.length > 0 && (
                <span className="text-xl font-bold tabular-nums" style={{ color: "#ef4444" }}>
                  {fmtCurrency(-totalDebt)}
                </span>
              )}
            </div>
            <button
              onClick={openNew}
              className="px-4 py-1.5 rounded text-sm font-semibold bg-purple text-rose dark:bg-rose dark:text-purple hover:opacity-90 transition-opacity"
            >
              + New Loan
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 animate-pulse py-12 text-center">Loading…</p>
          ) : loans.length === 0 ? (
            <EmptyState label="loans" onAdd={openNew} />
          ) : (
            <div className="flex flex-col gap-6">
              {groupOrder.map((groupType) => (
                <section key={groupType}>
                  <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium mb-3">
                    {LOAN_TYPE_LABELS[groupType]} · {grouped[groupType].length}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {grouped[groupType].map((loan) => {
                      const acc  = accounts.find((a) => a.id === loan.accountId);
                      const asset = loan.assetId ? assets.find((a) => a.id === loan.assetId) : null;
                      const pct   = loanProgressPct(loan);
                      const orig  = loan.originalPrincipal ?? 0;
                      const bal   = loan.currentBalance ?? 0;
                      const paid  = orig - bal;
                      const myPays = payments.filter((p) => p.loanId === loan.id);
                      const posted = myPays.filter((p) => p.status === "POSTED").length;
                      const remaining = (loan.termMonths ?? 0) - posted;
                      return (
                        <a
                          key={loan.id}
                          href={`/finance/loans/${loan.id}`}
                          className="rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface px-5 py-4 flex flex-col gap-3 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">
                              {acc?.name ?? "—"}
                            </h3>
                            <span className="text-xs font-bold tabular-nums" style={{ color: FINANCE_COLOR }}>
                              {Math.round(pct * 100)}%
                            </span>
                          </div>

                          {/* Progress bar */}
                          <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${pct * 100}%`, backgroundColor: FINANCE_COLOR }}
                            />
                          </div>

                          {/* Amounts */}
                          <div className="flex justify-between text-xs tabular-nums">
                            <span>
                              <span className="text-gray-400 mr-1">Owed</span>
                              <span className="font-semibold" style={{ color: "#ef4444" }}>{fmtCurrency(bal)}</span>
                            </span>
                            <span>
                              <span className="text-gray-400 mr-1">Paid</span>
                              <span className="font-semibold text-gray-700 dark:text-gray-300">{fmtCurrency(paid)}</span>
                            </span>
                          </div>

                          {/* Rate + remaining payments */}
                          <div className="flex justify-between text-[11px] text-gray-400">
                            <span>{((loan.interestRate ?? 0) * 100).toFixed(3)}% APR</span>
                            <span>
                              {posted} of {loan.termMonths} paid
                              {remaining > 0 && <> · {remaining} left</>}
                            </span>
                          </div>

                          {/* Linked asset */}
                          {asset && (
                            <p className="text-[11px] text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-2">
                              Linked to <span className="font-medium">{asset.name}</span>
                              {" · Equity "}
                              <span className="font-semibold tabular-nums" style={{ color: amountColor((asset.currentValue ?? 0) - bal) }}>
                                {fmtCurrency((asset.currentValue ?? 0) - bal)}
                              </span>
                            </p>
                          )}
                        </a>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        {/* ── Side panel: new loan ─────────────────────────────────────── */}
        {panel?.kind === "new" && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-[28rem] border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">New Loan</h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              <div>
                <label className={labelCls}>Name *</label>
                <input type="text" className={inputCls} placeholder="Primary mortgage, Honda auto loan…"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Type</label>
                  <select className={inputCls} value={draft.loanType}
                    onChange={(e) => setDraft((d) => ({ ...d, loanType: e.target.value }))}>
                    {LOAN_TYPES.map((t) => (
                      <option key={t} value={t}>{LOAN_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Lender</label>
                  <input type="text" className={inputCls} placeholder="optional"
                    value={draft.lender}
                    onChange={(e) => setDraft((d) => ({ ...d, lender: e.target.value }))} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Amount Borrowed *</label>
                <input type="number" step="0.01" min={0} className={inputCls} placeholder="300000"
                  value={draft.originalPrincipal}
                  onChange={(e) => setDraft((d) => ({
                    ...d,
                    originalPrincipal: e.target.value === "" ? "" : parseFloat(e.target.value),
                  }))} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Interest Rate (%) *</label>
                  <input type="number" step="0.001" min={0} className={inputCls} placeholder="4.5"
                    value={draft.interestRatePct}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      interestRatePct: e.target.value === "" ? "" : parseFloat(e.target.value),
                    }))} />
                </div>
                <div>
                  <label className={labelCls}>Term (months) *</label>
                  <input type="number" step="1" min={1} className={inputCls} placeholder="360"
                    value={draft.termMonths}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      termMonths: e.target.value === "" ? "" : parseInt(e.target.value, 10),
                    }))} />
                  {draft.termMonths !== "" && Number(draft.termMonths) > 0 && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      = {(Number(draft.termMonths) / 12).toFixed(1)} years
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>Start Date *</label>
                  <input type="date" className={inputCls}
                    value={draft.startDate}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      startDate: e.target.value,
                      // Auto-suggest first payment 30 days later if empty
                      firstPaymentDate: d.firstPaymentDate || (e.target.value ? addMonthsIso(e.target.value, 1) : ""),
                    }))} />
                </div>
                <div>
                  <label className={labelCls}>First Payment *</label>
                  <input type="date" className={inputCls}
                    value={draft.firstPaymentDate}
                    onChange={(e) => setDraft((d) => ({ ...d, firstPaymentDate: e.target.value }))} />
                </div>
              </div>

              <div>
                <label className={labelCls}>Payment Strategy</label>
                <select className={inputCls} value={draft.paymentStrategy}
                  onChange={(e) => setDraft((d) => ({ ...d, paymentStrategy: e.target.value }))}>
                  {LOAN_PAYMENT_STRATEGIES.map((s) => (
                    <option key={s} value={s}>{LOAN_PAYMENT_STRATEGY_LABELS[s]}</option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Used when recalculating after extra payments.
                </p>
              </div>

              {/* Live preview */}
              {preview && (
                <div className="rounded-lg bg-gray-50 dark:bg-darkElevated px-3 py-2 flex flex-col gap-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Monthly payment</span>
                    <span className="font-semibold tabular-nums" style={{ color: FINANCE_COLOR }}>
                      {fmtCurrency(preview.monthly)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Total interest over life</span>
                    <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-300">
                      {fmtCurrency(preview.totalInterest)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Total paid</span>
                    <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-300">
                      {fmtCurrency(preview.totalPaid)}
                    </span>
                  </div>
                  {preview.payoff && (
                    <div className="flex justify-between">
                      <span className="text-gray-400">Payoff date</span>
                      <span className="font-semibold tabular-nums text-gray-700 dark:text-gray-300">
                        {fmtDate(preview.payoff)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className={labelCls}>Linked Asset</label>
                <select className={inputCls} value={draft.assetId}
                  onChange={(e) => setDraft((d) => ({ ...d, assetId: e.target.value }))}>
                  <option value="">— none —</option>
                  {assets.filter((a) => a.active !== false).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Optional. Links loan to a house/car so equity can be shown on the asset page.
                </p>
              </div>

              <div>
                <label className={labelCls}>Escrow Account</label>
                <select className={inputCls} value={draft.escrowAccountId}
                  onChange={(e) => setDraft((d) => ({ ...d, escrowAccountId: e.target.value }))}>
                  <option value="">— none —</option>
                  {accounts.filter((a) => a.type === "SAVINGS" && a.active !== false).map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Optional. For future use — not wired to balance yet.
                </p>
              </div>

              <div>
                <label className={labelCls}>Notes</label>
                <textarea className={inputCls} rows={2} placeholder="Loan number, terms, refinance history…"
                  value={draft.notes}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
              </div>

              <SaveButton
                saving={saving}
                onSave={handleCreate}
                label={saving ? "Generating schedule…" : `Create Loan${draft.termMonths ? ` (${draft.termMonths} payments)` : ""}`}
              />
              <p className="text-[10px] text-gray-400 text-center">
                Creating a loan also generates all scheduled payments from amortization.
                You post each one (or bulk-post) as the statement arrives.
              </p>
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
