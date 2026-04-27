import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import NextLink from "next/link";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  AccountRecord, LoanRecord, LoanPaymentRecord, AssetRecord, TransactionRecord,
  LOAN_TYPE_LABELS, FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor, addMonthsIso,
  loanProgressPct, computeLoanBalanceFromPayments, remainingScheduled, postedCount, totalInterestPaid,
  recalculateLoan, paymentForTargetMonths,
  inputCls, labelCls,
  SaveButton, DeleteButton,
  listAll,
} from "@/components/finance/_shared";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

// Side panel state — for posting, editing, or logging an extra payment
type PanelState =
  | { kind: "post";        payment: LoanPaymentRecord }
  | { kind: "edit-posted"; payment: LoanPaymentRecord }
  | { kind: "extra" }
  | { kind: "correction";  delta: number }
  | { kind: "edit-loan" }
  | null;

// Editable loan metadata — only the fields that make sense to change after creation.
// Principal / interest rate / term / start date are deliberately NOT editable: changing
// them would invalidate the generated payment schedule and drive balance drift.
type LoanMetaDraft = {
  name:            string;   // lives on financeAccount.name (the ledger account)
  lender:          string;
  assetId:         string;   // "" = none
  escrowAccountId: string;   // "" = none
  notes:           string;
};

// Side panel draft, matches financeLoanPayment fields but with strings for inputs
type PaymentDraft = {
  date:        string;
  totalAmount: number | "";
  principal:   number | "";
  interest:    number | "";
  escrow:      number | "";
  fees:        number | "";
  notes:       string;
  /** When true, also create the matching expense transaction on the paying
   *  account and decrement that account's balance. Default false because the
   *  user often imports the checking debit independently from CSV — creating
   *  it here would double-count. */
  createCheckingTx: boolean;
};

function draftFromPayment(p: LoanPaymentRecord): PaymentDraft {
  return {
    date:        p.date ?? todayIso(),
    totalAmount: p.totalAmount ?? 0,
    principal:   p.principal ?? 0,
    interest:    p.interest ?? 0,
    escrow:      p.escrow ?? "",
    fees:        p.fees ?? "",
    notes:       p.notes ?? "",
    // Re-editing a payment that already had a checking tx defaults to keeping
    // it. New posts default to false.
    createCheckingTx: !!p.transactionId,
  };
}

export default function LoanDetailPage() {
  const { authState } = useRequireAuth();
  const router = useRouter();
  const loanId = typeof router.query.id === "string" ? router.query.id : "";

  const [loan,         setLoan]         = useState<LoanRecord | null>(null);
  const [account,      setAccount]      = useState<AccountRecord | null>(null);
  const [asset,        setAsset]        = useState<AssetRecord | null>(null);
  const [payments,     setPayments]     = useState<LoanPaymentRecord[]>([]);
  const [accounts,     setAccounts]     = useState<AccountRecord[]>([]); // all, for checking account picker
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [panel,        setPanel]        = useState<PanelState>(null);
  const [draft,        setDraft]        = useState<PaymentDraft>({
    date: todayIso(), totalAmount: "", principal: "", interest: "", escrow: "", fees: "", notes: "",
    createCheckingTx: false,
  });

  // Lender-stated balance (for correction banner). Local-only UI field.
  const [lenderBalance, setLenderBalance] = useState<number | "">("");

  // Editable-loan draft + list of assets (for the picker in the edit panel)
  const [loanMetaDraft, setLoanMetaDraft] = useState<LoanMetaDraft>({
    name: "", lender: "", assetId: "", escrowAccountId: "", notes: "",
  });
  const [assets, setAssets] = useState<AssetRecord[]>([]);

  // Bulk-post selection (set of payment IDs selected on the scheduled table)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Checking account picker (for posting). Default = first CHECKING account.
  const [checkingAccountId, setCheckingAccountId] = useState<string>("");

  // Recalc panel: months slider state for the "custom target" row
  const [customMonths, setCustomMonths] = useState<number>(36);

  const fetchAll = useCallback(async () => {
    if (!loanId) return;
    setLoading(true);
    try {
      const [{ data: ln }, accs, pays, ass] = await Promise.all([
        client.models.financeLoan.get({ id: loanId }),
        listAll(client.models.financeAccount),
        listAll(client.models.financeLoanPayment),
        listAll(client.models.financeAsset),
      ]);
      setLoan(ln ?? null);
      setAccounts(accs);
      setAssets(ass);
      if (ln?.accountId) setAccount(accs.find((a) => a.id === ln.accountId) ?? null);
      if (ln?.assetId)   setAsset(ass.find((a) => a.id === ln.assetId) ?? null);
      setPayments(pays.filter((p) => p.loanId === loanId));
      // Default checking picker to first checking account
      if (!checkingAccountId) {
        const firstChecking = accs.find((a) => a.type === "CHECKING" && a.active !== false);
        if (firstChecking) setCheckingAccountId(firstChecking.id);
      }
    } finally {
      setLoading(false);
    }
  }, [loanId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (authState !== "authenticated" || !router.isReady) return;
    fetchAll();
  }, [authState, router.isReady, fetchAll]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const postedPayments = useMemo(
    () => payments.filter((p) => p.status === "POSTED"),
    [payments],
  );
  const scheduledPayments = useMemo(() => remainingScheduled(payments), [payments]);

  // Columns for the posted payments table
  const postedColumns: ColDef<LoanPaymentRecord>[] = useMemo(() => [
    {
      key: "date",
      label: "Date",
      sortValue: (p) => p.date ?? "",
      render: (p) => <span className="whitespace-nowrap text-gray-500 dark:text-gray-400 text-xs">{fmtDate(p.date)}</span>,
    },
    {
      key: "seq",
      label: "#",
      sortValue: (p) => p.sequenceNumber ?? (p.isCorrection ? -2 : p.isExtraPayment ? -1 : 0),
      searchValue: (p) => p.isCorrection ? "correction" : p.isExtraPayment ? "extra" : `#${p.sequenceNumber ?? ""}`,
      mobileHidden: true,
      render: (p) => (
        <span className="text-xs text-gray-400">
          {p.isCorrection    ? <span style={{ color: "#f59e0b" }}>correction</span> :
           p.isExtraPayment  ? <span style={{ color: FINANCE_COLOR }}>extra</span>  :
           p.sequenceNumber  ? `#${p.sequenceNumber}` : "—"}
        </span>
      ),
    },
    {
      key: "total",
      label: "Total",
      sortValue: (p) => p.totalAmount ?? 0,
      align: "right",
      render: (p) => <span className="tabular-nums">{fmtCurrency(p.totalAmount)}</span>,
    },
    {
      key: "principal",
      label: "Principal",
      sortValue: (p) => p.principal ?? 0,
      align: "right",
      render: (p) => (
        <span className="tabular-nums font-semibold" style={{ color: FINANCE_COLOR }}>
          {fmtCurrency(p.principal)}
        </span>
      ),
    },
    {
      key: "interest",
      label: "Interest",
      sortValue: (p) => p.interest ?? 0,
      align: "right",
      mobileHidden: true,
      render: (p) => (
        <span className="tabular-nums text-gray-500 dark:text-gray-400">
          {p.interest != null ? fmtCurrency(p.interest) : "—"}
        </span>
      ),
    },
    {
      key: "escrow",
      label: "Escrow",
      sortValue: (p) => p.escrow ?? null,
      align: "right",
      mobileHidden: true,
      render: (p) => (
        <span className="tabular-nums text-gray-500 dark:text-gray-400">
          {p.escrow != null ? fmtCurrency(p.escrow) : "—"}
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const postedCtl = useTableControls(postedPayments, {
    defaultSortKey: "date",
    defaultSortDir: "desc",
    getSortValue: (row, key) => postedColumns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) => postedColumns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" ") + " " + (row.notes ?? ""),
    initialPageSize: 50,
  });

  // Columns for the scheduled payments table.
  // Note: the checkbox + Post button are rendered inline in the JSX below,
  // not via columns, because they depend on component state (selectedIds).
  const scheduledColumns: ColDef<LoanPaymentRecord>[] = useMemo(() => [
    {
      key: "date",
      label: "Date",
      sortValue: (p) => p.date ?? "",
      render: (p) => {
        const overdue = (p.date ?? "") < todayIso();
        return (
          <span className={`whitespace-nowrap text-xs ${overdue ? "text-amber-500 font-semibold" : "text-gray-500 dark:text-gray-400"}`}>
            {fmtDate(p.date)}
            {overdue && <span className="ml-1 text-[10px]">· overdue</span>}
          </span>
        );
      },
    },
    {
      key: "seq",
      label: "#",
      sortValue: (p) => p.sequenceNumber ?? 0,
      mobileHidden: true,
      render: (p) => <span className="text-xs text-gray-400">#{p.sequenceNumber ?? "—"}</span>,
    },
    {
      key: "total",
      label: "Total",
      sortValue: (p) => p.totalAmount ?? 0,
      align: "right",
      render: (p) => <span className="tabular-nums">{fmtCurrency(p.totalAmount)}</span>,
    },
    {
      key: "principal",
      label: "Principal",
      sortValue: (p) => p.principal ?? 0,
      align: "right",
      render: (p) => (
        <span className="tabular-nums font-semibold" style={{ color: FINANCE_COLOR }}>
          {fmtCurrency(p.principal)}
        </span>
      ),
    },
    {
      key: "interest",
      label: "Interest",
      sortValue: (p) => p.interest ?? 0,
      align: "right",
      mobileHidden: true,
      render: (p) => (
        <span className="tabular-nums text-gray-500 dark:text-gray-400">
          {fmtCurrency(p.interest)}
        </span>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const scheduledCtl = useTableControls(scheduledPayments, {
    defaultSortKey: "date",
    defaultSortDir: "asc",   // next due first
    getSortValue: (row, key) => scheduledColumns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText: (row) => scheduledColumns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" ") + ` ${row.sequenceNumber ?? ""}`,
    initialPageSize: 120,
  });

  const computedBalance = useMemo(
    () => loan ? computeLoanBalanceFromPayments(loan.originalPrincipal ?? 0, payments) : 0,
    [loan, payments],
  );

  // Drift between cached balance (on loan record) and computed-from-payments
  const cachedVsComputedDrift = loan ? (loan.currentBalance ?? 0) - computedBalance : 0;

  // Drift between cached balance and lender-stated balance (for correction banner)
  const cachedVsLenderDrift = lenderBalance !== "" && loan
    ? (loan.currentBalance ?? 0) - Number(lenderBalance)
    : null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Recalculate cached balance on the loan record = originalPrincipal − Σ(POSTED payment.principal).
   * Re-fetches payments from the server (rather than relying on React state, which is
   * async and stale right after a batch of mutations) and writes the new balance to
   * both the loan record and the linked account ledger (−balance = amount owed).
   */
  async function recalcCachedBalance(): Promise<number> {
    if (!loan) return 0;
    // Fetch the freshest payment list — state may not have caught up after a batch
    const freshPays = await listAll(client.models.financeLoanPayment);
    const myPays = freshPays.filter((p) => p.loanId === loan.id);
    const newBal = computeLoanBalanceFromPayments(loan.originalPrincipal ?? 0, myPays);

    await client.models.financeLoan.update({
      id:             loan.id,
      currentBalance: newBal,
    });
    // Also update the account ledger to match (−balance = owed)
    if (loan.accountId) {
      await client.models.financeAccount.update({
        id:             loan.accountId,
        currentBalance: -newBal,
      });
    }
    setLoan((l) => l ? ({ ...l, currentBalance: newBal } as LoanRecord) : l);
    setAccount((a) => a ? ({ ...a, currentBalance: -newBal } as AccountRecord) : a);
    setPayments(myPays);
    return newBal;
  }

  /**
   * Post a single scheduled payment.
   *
   * Always:
   * - Creates an INCOME transaction on the loan account for `principal`
   *   (so the ledger reflects the debit; balance update below keeps the
   *    cached account.currentBalance honest immediately, instead of waiting
   *    on recalcCachedBalance).
   * - Bumps loan account balance by +principal (debt closer to 0).
   * - Bumps loan record's cached `currentBalance` by −principal.
   *
   * Conditional on `createCheckingTx`:
   * - Creates an EXPENSE transaction on the paying account and decrements
   *   that account's balance by `totalAmount`. Default is OFF — the user
   *   typically imports their checking ledger from CSV, and creating it
   *   here would double-count.
   *
   * Always at the end: caller invokes recalcCachedBalance() as a safety
   * net to reconcile against the full posted-payment list.
   */
  async function postPayment(
    payment: LoanPaymentRecord,
    values: {
      date: string;
      totalAmount: number;
      principal: number;
      interest: number;
      escrow: number | null;
      fees: number | null;
      notes: string | null;
      createCheckingTx: boolean;
    },
  ): Promise<LoanPaymentRecord | null> {
    if (!loan || !account) return null;
    const { date, totalAmount, principal, interest, escrow, fees, notes, createCheckingTx } = values;

    if (createCheckingTx && !checkingAccountId) {
      alert("Pick a paying account above the scheduled table, or uncheck \"Also debit checking\" on the panel.");
      return null;
    }

    // 1. Optional: expense transaction on the paying account + balance update
    let checkingTx: { id: string } | null | undefined = null;
    if (createCheckingTx) {
      const created = await client.models.financeTransaction.create({
        accountId:   checkingAccountId,
        amount:      -totalAmount,
        type:        "EXPENSE" as any,
        category:    "Loan payment",
        description: `${account.name} payment${payment.sequenceNumber ? ` #${payment.sequenceNumber}` : ""}`,
        date,
        status:      "POSTED" as any,
        goalId:      null,
        toAccountId: null,
        importHash:  null,
      });
      checkingTx = created.data;
      const { data: chk } = await client.models.financeAccount.get({ id: checkingAccountId });
      if (chk) {
        await client.models.financeAccount.update({
          id:             checkingAccountId,
          currentBalance: (chk.currentBalance ?? 0) - totalAmount,
        });
      }
    }

    // 2. Income transaction on loan account (principal reduces the debt)
    const { data: loanTx } = await client.models.financeTransaction.create({
      accountId:   account.id,
      amount:      principal,
      type:        "INCOME" as any,
      category:    "Loan principal",
      description: `Principal payment${payment.sequenceNumber ? ` #${payment.sequenceNumber}` : ""}`,
      date,
      status:      "POSTED" as any,
      goalId:      null,
      toAccountId: null,
      importHash:  null,
    });

    // 3. Bump the loan account's cached balance toward zero by +principal.
    //    (Loan account balance is stored as a negative number; principal
    //    payment reduces the debt, so balance moves up.)
    {
      const { data: la } = await client.models.financeAccount.get({ id: account.id });
      if (la) {
        await client.models.financeAccount.update({
          id:             account.id,
          currentBalance: (la.currentBalance ?? 0) + principal,
        });
      }
    }

    // 4. Bump the loan record's cached currentBalance by −principal.
    {
      const { data: lr } = await client.models.financeLoan.get({ id: loan.id });
      if (lr) {
        await client.models.financeLoan.update({
          id:             loan.id,
          currentBalance: (lr.currentBalance ?? 0) - principal,
        });
      }
    }

    // 5. Update the payment record: status POSTED + split + transaction FKs
    const { data: updated } = await client.models.financeLoanPayment.update({
      id:                 payment.id,
      status:             "POSTED" as any,
      date,
      totalAmount,
      principal,
      interest,
      escrow:             escrow ?? null,
      fees:               fees ?? null,
      notes:              notes ?? null,
      transactionId:      checkingTx?.id ?? null,
      loanTransactionId:  loanTx?.id ?? null,
    });

    return updated ?? null;
  }

  async function handleSingleSave() {
    if (!panel) return;
    if (panel.kind !== "post" && panel.kind !== "edit-posted" && panel.kind !== "extra" && panel.kind !== "correction") return;

    // Validate
    const total = Number(draft.totalAmount);
    const prin  = Number(draft.principal);
    const intr  = Number(draft.interest);

    if (panel.kind === "correction") {
      // Correction is principal-only
      if (!isFinite(prin) || prin === 0) { alert("Enter a non-zero correction amount"); return; }
    } else {
      if (!isFinite(total) || total < 0) { alert("Enter a valid total"); return; }
      if (!isFinite(prin)  || prin  < 0) { alert("Enter a valid principal"); return; }
      if (!isFinite(intr)  || intr  < 0) { alert("Enter a valid interest"); return; }
      // Sanity-check the split vs total (allow small escrow/fees delta)
      const escAmt  = draft.escrow === "" ? 0 : Number(draft.escrow);
      const feesAmt = draft.fees   === "" ? 0 : Number(draft.fees);
      const sum = prin + intr + escAmt + feesAmt;
      if (Math.abs(sum - total) > 0.01) {
        if (!confirm(`Principal + interest${escAmt || feesAmt ? " + escrow/fees" : ""} (${fmtCurrency(sum)}) doesn't match total (${fmtCurrency(total)}). Save anyway?`)) return;
      }
    }

    setSaving(true);
    try {
      if (panel.kind === "post") {
        // Post a scheduled payment
        const updated = await postPayment(panel.payment, {
          date: draft.date,
          totalAmount: total,
          principal: prin,
          interest: intr,
          escrow: draft.escrow === "" ? null : Number(draft.escrow),
          fees: draft.fees === "" ? null : Number(draft.fees),
          notes: draft.notes.trim() || null,
          createCheckingTx: draft.createCheckingTx,
        });
        if (updated) {
          setPayments((p) => p.map((x) => x.id === updated.id ? updated : x));
        }
      } else if (panel.kind === "edit-posted") {
        // Edit an already-posted payment: drop the 2 old transactions and let
        // postPayment recreate them (or skip checking if toggle is off now).
        // We also need to undo the prior balance hits before postPayment
        // re-applies the new ones — otherwise balances double-up. principalDelta
        // is signed: positive principal originally reduced loan debt, so
        // reversing means subtracting it again from the loan account / adding
        // to the loan record.
        const old = panel.payment;
        if (old.transactionId) {
          // Reverse the old checking expense before deleting it.
          try {
            const { data: tx } = await client.models.financeTransaction.get({ id: old.transactionId });
            if (tx) {
              const { data: chk } = await client.models.financeAccount.get({ id: tx.accountId ?? "" });
              if (chk) {
                await client.models.financeAccount.update({
                  id:             chk.id,
                  currentBalance: (chk.currentBalance ?? 0) - (tx.amount ?? 0),
                });
              }
            }
          } catch {}
          await client.models.financeTransaction.delete({ id: old.transactionId });
        }
        if (old.loanTransactionId) {
          await client.models.financeTransaction.delete({ id: old.loanTransactionId });
        }
        // Reverse the old loan-side balance bumps so postPayment can reapply
        // cleanly with the (possibly different) new principal.
        if (account && (old.principal ?? 0) !== 0) {
          const { data: la } = await client.models.financeAccount.get({ id: account.id });
          if (la) {
            await client.models.financeAccount.update({
              id:             account.id,
              currentBalance: (la.currentBalance ?? 0) - (old.principal ?? 0),
            });
          }
          const { data: lr } = await client.models.financeLoan.get({ id: loan!.id });
          if (lr) {
            await client.models.financeLoan.update({
              id:             loan!.id,
              currentBalance: (lr.currentBalance ?? 0) + (old.principal ?? 0),
            });
          }
        }

        const updated = await postPayment(old, {
          date: draft.date,
          totalAmount: total,
          principal: prin,
          interest: intr,
          escrow: draft.escrow === "" ? null : Number(draft.escrow),
          fees: draft.fees === "" ? null : Number(draft.fees),
          notes: draft.notes.trim() || null,
          createCheckingTx: draft.createCheckingTx,
        });
        if (updated) setPayments((p) => p.map((x) => x.id === updated.id ? updated : x));
      } else if (panel.kind === "extra") {
        // Ad-hoc extra payment. Same gating rule as scheduled posts: only
        // create the checking-side debit when the toggle is on.
        if (!loan || !account) return;
        if (draft.createCheckingTx && !checkingAccountId) {
          alert("Pick a paying account, or uncheck \"Also debit checking\".");
          return;
        }

        let checkingTx: { id: string } | null | undefined = null;
        if (draft.createCheckingTx) {
          const created = await client.models.financeTransaction.create({
            accountId:   checkingAccountId,
            amount:      -total,
            type:        "EXPENSE" as any,
            category:    "Loan payment",
            description: `${account.name} extra payment`,
            date:        draft.date,
            status:      "POSTED" as any,
            goalId: null, toAccountId: null, importHash: null,
          });
          checkingTx = created.data;
          const { data: chk } = await client.models.financeAccount.get({ id: checkingAccountId });
          if (chk) {
            await client.models.financeAccount.update({
              id:             checkingAccountId,
              currentBalance: (chk.currentBalance ?? 0) - total,
            });
          }
        }

        const { data: loanTx } = await client.models.financeTransaction.create({
          accountId:   account.id,
          amount:      prin,
          type:        "INCOME" as any,
          category:    "Loan principal",
          description: "Extra principal payment",
          date:        draft.date,
          status:      "POSTED" as any,
          goalId: null, toAccountId: null, importHash: null,
        });

        // Bump loan account toward zero by +principal
        {
          const { data: la } = await client.models.financeAccount.get({ id: account.id });
          if (la) {
            await client.models.financeAccount.update({
              id:             account.id,
              currentBalance: (la.currentBalance ?? 0) + prin,
            });
          }
        }
        // Bump loan record's cached balance by −principal
        {
          const { data: lr } = await client.models.financeLoan.get({ id: loan.id });
          if (lr) {
            await client.models.financeLoan.update({
              id:             loan.id,
              currentBalance: (lr.currentBalance ?? 0) - prin,
            });
          }
        }

        const { data: newPay } = await client.models.financeLoanPayment.create({
          loanId:           loan.id,
          status:           "POSTED" as any,
          date:             draft.date,
          sequenceNumber:   null,
          totalAmount:      total,
          principal:        prin,
          interest:         intr,
          escrow:           draft.escrow === "" ? null : Number(draft.escrow),
          fees:             draft.fees   === "" ? null : Number(draft.fees),
          isCorrection:     false,
          isExtraPayment:   true,
          transactionId:    checkingTx?.id ?? null,
          loanTransactionId: loanTx?.id ?? null,
          notes:            draft.notes.trim() || null,
        });
        if (newPay) setPayments((p) => [...p, newPay]);
      } else if (panel.kind === "correction") {
        // Correction: principal-only delta, no transactions
        if (!loan) return;
        const { data: newPay } = await client.models.financeLoanPayment.create({
          loanId:           loan.id,
          status:           "POSTED" as any,
          date:             draft.date,
          sequenceNumber:   null,
          totalAmount:      0,
          principal:        prin,
          interest:         0,
          escrow:           null,
          fees:             null,
          isCorrection:     true,
          isExtraPayment:   false,
          transactionId:    null,
          loanTransactionId: null,
          notes:            (draft.notes.trim() || "Reconciliation correction"),
        });
        if (newPay) setPayments((p) => [...p, newPay]);
        setLenderBalance("");  // clear the banner input
      }

      // Recompute cached loan + account balance from the fresh payment list
      await recalcCachedBalance();
      setPanel(null);
    } catch (err: any) {
      console.error("[loan-payment] save failed:", err);
      alert(`Failed: ${err?.message ?? String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePayment(payment: LoanPaymentRecord) {
    if (!confirm("Delete this payment? This also removes its linked transactions.")) return;
    setSaving(true);
    try {
      if (payment.transactionId) {
        // Reverse the checking-side expense before deleting the transaction record
        try {
          const { data: tx } = await client.models.financeTransaction.get({ id: payment.transactionId });
          if (tx) {
            const { data: chk } = await client.models.financeAccount.get({ id: tx.accountId ?? "" });
            if (chk) {
              await client.models.financeAccount.update({
                id:             chk.id,
                // tx.amount is already negative for an expense; subtracting it reverses the effect
                currentBalance: (chk.currentBalance ?? 0) - (tx.amount ?? 0),
              });
            }
          }
        } catch {}
        try { await client.models.financeTransaction.delete({ id: payment.transactionId }); } catch {}
      }
      if (payment.loanTransactionId) {
        try { await client.models.financeTransaction.delete({ id: payment.loanTransactionId }); } catch {}
      }
      await client.models.financeLoanPayment.delete({ id: payment.id });
      setPayments((p) => p.filter((x) => x.id !== payment.id));
      await recalcCachedBalance();
      setPanel(null);
    } finally {
      setSaving(false);
    }
  }

  // ── Bulk post ──────────────────────────────────────────────────────────────

  async function handleBulkPost() {
    if (selectedIds.size === 0) return;
    // Bulk-post lets the user opt in to the checking-side debit too. Default
    // is no — most users have already imported the matching debits via CSV.
    const alsoDebit = confirm(
      `Post ${selectedIds.size} payment${selectedIds.size === 1 ? "" : "s"}.\n\n` +
      `OK = also debit the paying account for each (only if you haven't imported them).\n` +
      `Cancel = post loan-side only (recommended).`,
    );
    setSaving(true);
    try {
      const toPost = scheduledPayments.filter((p) => selectedIds.has(p.id));
      for (const payment of toPost) {
        await postPayment(payment, {
          date:             payment.date ?? todayIso(),
          totalAmount:      payment.totalAmount ?? 0,
          principal:        payment.principal ?? 0,
          interest:         payment.interest ?? 0,
          escrow:           payment.escrow ?? null,
          fees:             payment.fees ?? null,
          notes:            payment.notes ?? null,
          createCheckingTx: alsoDebit,
        });
      }
      setSelectedIds(new Set());
      // Recompute cached loan + account balance after the batch
      await recalcCachedBalance();
    } catch (err: any) {
      console.error("[bulk-post] failed:", err);
      alert(`Bulk post failed: ${err?.message ?? String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Recalculate from transactions (audit button) ──────────────────────────

  async function handleRecalcFromTransactions() {
    if (!loan || !account) return;
    // Fetch ALL posted INCOME transactions on the loan account — those represent principal flows
    const txs = await listAll(client.models.financeTransaction);
    const loanIncome = txs
      .filter((t) => t.accountId === account.id && t.status === "POSTED" && t.type === "INCOME")
      .reduce((s, t) => s + (t.amount ?? 0), 0);

    const balanceFromTx = (loan.originalPrincipal ?? 0) - loanIncome;
    const balanceFromPayments = computeLoanBalanceFromPayments(loan.originalPrincipal ?? 0, payments);

    const msg = [
      `From loan account transactions: ${fmtCurrency(balanceFromTx)}`,
      `From payment records: ${fmtCurrency(balanceFromPayments)}`,
      `Cached on loan record: ${fmtCurrency(loan.currentBalance ?? 0)}`,
      ``,
      Math.abs(balanceFromTx - balanceFromPayments) < 0.01
        ? "✓ Transactions and payment records agree."
        : `⚠ Drift of ${fmtCurrency(Math.abs(balanceFromTx - balanceFromPayments))} between sources — see console.`,
    ].join("\n");

    console.log("[loan-audit]", { balanceFromTx, balanceFromPayments, cached: loan.currentBalance });
    alert(msg);
  }

  // ── Side panel openers ─────────────────────────────────────────────────────

  function openPost(p: LoanPaymentRecord) {
    setDraft(draftFromPayment(p));
    setPanel({ kind: "post", payment: p });
  }
  function openEditPosted(p: LoanPaymentRecord) {
    setDraft(draftFromPayment(p));
    setPanel({ kind: "edit-posted", payment: p });
  }
  function openExtra() {
    setDraft({
      date: todayIso(),
      totalAmount: "", principal: "", interest: 0,
      escrow: "", fees: "", notes: "",
      createCheckingTx: false,
    });
    setPanel({ kind: "extra" });
  }
  function openCorrection(delta: number) {
    // Principal-only correction to reconcile cached balance with lender
    setDraft({
      date: todayIso(),
      totalAmount: 0,
      principal: delta,           // positive = reduces balance further; negative = increases
      interest: 0,
      escrow: "", fees: "",
      notes: `Reconcile with lender-stated balance`,
      createCheckingTx: false,    // corrections never create a checking tx
    });
    setPanel({ kind: "correction", delta });
  }

  function openEditLoan() {
    if (!loan || !account) return;
    setLoanMetaDraft({
      name:            account.name ?? "",
      lender:          loan.lender ?? "",
      assetId:         loan.assetId ?? "",
      escrowAccountId: loan.escrowAccountId ?? "",
      notes:           loan.notes ?? "",
    });
    setPanel({ kind: "edit-loan" });
  }

  async function handleSaveLoanMeta() {
    if (!loan || !account) return;
    if (!loanMetaDraft.name.trim()) { alert("Name is required"); return; }
    setSaving(true);
    try {
      // 1. Update the ledger account's name (that's what renders in the UI header)
      await client.models.financeAccount.update({
        id:   account.id,
        name: loanMetaDraft.name.trim(),
      });

      // 2. Update the loan metadata
      await client.models.financeLoan.update({
        id:              loan.id,
        lender:          loanMetaDraft.lender.trim() || null,
        assetId:         loanMetaDraft.assetId || null,
        escrowAccountId: loanMetaDraft.escrowAccountId || null,
        notes:           loanMetaDraft.notes.trim() || null,
      });

      // 3. Refresh local state
      setAccount((a) => a ? ({ ...a, name: loanMetaDraft.name.trim() } as AccountRecord) : a);
      setLoan((l) => l ? ({
        ...l,
        lender:          loanMetaDraft.lender.trim() || null,
        assetId:         loanMetaDraft.assetId || null,
        escrowAccountId: loanMetaDraft.escrowAccountId || null,
        notes:           loanMetaDraft.notes.trim() || null,
      } as LoanRecord) : l);
      setAsset(loanMetaDraft.assetId ? assets.find((a) => a.id === loanMetaDraft.assetId) ?? null : null);
      setPanel(null);
    } catch (err: any) {
      console.error("[loan-edit] save failed:", err);
      alert(`Failed: ${err?.message ?? String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // ── Selection helpers ──────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelectedIds((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllScheduled() {
    setSelectedIds(new Set(scheduledPayments.map((p) => p.id)));
  }
  function selectThroughToday() {
    const today = todayIso();
    setSelectedIds(new Set(scheduledPayments.filter((p) => (p.date ?? "") <= today).map((p) => p.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  if (authState !== "authenticated") return null;
  if (!router.isReady || loading) {
    return <FinanceLayout><div className="px-4 py-5 md:px-8 md:py-6"><p className="text-sm text-gray-400 animate-pulse">Loading…</p></div></FinanceLayout>;
  }
  if (!loan || !account) {
    return (
      <FinanceLayout>
        <div className="px-4 py-5 md:px-8 md:py-6">
          <p className="text-sm text-gray-400">
            Loan not found. <NextLink href="/finance/loans" className="underline" style={{ color: FINANCE_COLOR }}>Back to loans</NextLink>
          </p>
        </div>
      </FinanceLayout>
    );
  }

  const pct = loanProgressPct(loan);
  const interestPaid = totalInterestPaid(payments);
  const recalc = recalculateLoan(loan, payments);
  const customPayment = paymentForTargetMonths(loan, customMonths);

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          {/* Breadcrumb */}
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-3">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
            <span>›</span>
            <NextLink href="/finance/loans" className="hover:underline" style={{ color: FINANCE_COLOR }}>Loans</NextLink>
            <span>›</span>
            <span>{account.name}</span>
          </div>

          {/* Header */}
          <div className="flex flex-col gap-3 mb-5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-purple dark:text-rose">{account.name}</h1>
                <span
                  className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: FINANCE_COLOR + "22", color: FINANCE_COLOR }}
                >
                  {LOAN_TYPE_LABELS[(loan.loanType ?? "OTHER") as keyof typeof LOAN_TYPE_LABELS]}
                </span>
                {loan.lender && <span className="text-xs text-gray-400">· {loan.lender}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={openEditLoan}
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-gray-300 dark:border-darkBorder text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                >
                  Edit loan
                </button>
                <button
                  onClick={openExtra}
                  className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                  style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                >
                  + Extra payment
                </button>
                <button
                  onClick={handleRecalcFromTransactions}
                  className="px-3 py-1.5 rounded text-xs font-semibold border border-gray-300 dark:border-darkBorder text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
                >
                  Recalc audit
                </button>
              </div>
            </div>

            {/* Balance + progress */}
            <div className="flex items-baseline gap-6 flex-wrap">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Owed</p>
                <p className="text-2xl font-bold tabular-nums" style={{ color: "#ef4444" }}>
                  {fmtCurrency(loan.currentBalance)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Original</p>
                <p className="text-base font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {fmtCurrency(loan.originalPrincipal)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Rate / Term</p>
                <p className="text-base font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {((loan.interestRate ?? 0) * 100).toFixed(3)}% · {loan.termMonths}mo
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Payments</p>
                <p className="text-base font-semibold tabular-nums text-gray-700 dark:text-gray-200">
                  {postedCount(payments)} of {loan.termMonths} · {fmtCurrency(interestPaid)} interest
                </p>
              </div>
              {asset && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Equity</p>
                  <p className="text-base font-semibold tabular-nums" style={{ color: amountColor((asset.currentValue ?? 0) - (loan.currentBalance ?? 0)) }}>
                    {fmtCurrency((asset.currentValue ?? 0) - (loan.currentBalance ?? 0))}
                  </p>
                </div>
              )}
            </div>

            <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct * 100}%`, backgroundColor: FINANCE_COLOR }}
              />
            </div>
          </div>

          {/* ── Recalc: forward projection ──────────────────────────────── */}
          {/* Scenarios compare "what if I keep paying at this pace" to "what
              it takes to hit the original payoff date or a custom target." */}
          {recalc.remainingBalance > 0 && (
            <section className="mb-5 rounded-xl border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-darkBorder">
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">Recalc</h2>
                <p className="text-[10px] text-gray-400">
                  Based on {recalc.postedPaymentCount} posted payment{recalc.postedPaymentCount === 1 ? "" : "s"} · avg of last {Math.min(6, recalc.postedPaymentCount)}
                </p>
              </div>

              {/* Under-pay warning */}
              {recalc.scenarios.currentPace.underPaying && (
                <div className="px-4 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300">
                  Current pace ({fmtCurrency(recalc.avgPaymentLast6Mo)}/mo) doesn't cover monthly interest at {((loan.interestRate ?? 0) * 100).toFixed(3)}%. Balance would grow under this schedule.
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
                {/* Current pace */}
                <ScenarioTile
                  label="Current pace"
                  payment={recalc.scenarios.currentPace.monthlyPayment}
                  sub={
                    recalc.scenarios.currentPace.underPaying
                      ? "Never (interest exceeds pmt)"
                      : `→ ${fmtDate(recalc.scenarios.currentPace.payoffDate)} · ${recalc.scenarios.currentPace.months}mo · ${fmtCurrency(recalc.scenarios.currentPace.totalInterest)} interest`
                  }
                  accent={recalc.scenarios.currentPace.underPaying ? "#ef4444" : FINANCE_COLOR}
                />
                {/* Original term */}
                <ScenarioTile
                  label="Original-term pace"
                  payment={recalc.scenarios.originalTerm.monthlyPayment}
                  sub={`→ ${fmtDate(recalc.scenarios.originalTerm.payoffDate)} · ${recalc.scenarios.originalTerm.monthsLeft}mo left`}
                />
                {/* Fixed targets */}
                {([12, 24, 36, 60] as const).map((m) => (
                  <ScenarioTile
                    key={m}
                    label={`Clear in ${m} mo`}
                    payment={recalc.scenarios.payoffInMonths[m].monthlyPayment}
                    sub={`→ ${fmtDate(recalc.scenarios.payoffInMonths[m].payoffDate)}`}
                  />
                ))}
              </div>

              {/* Custom target months slider */}
              <div className="border-t border-gray-200 dark:border-darkBorder px-4 py-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <label className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                    Custom target
                  </label>
                  <div className="flex items-baseline gap-3">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {customMonths} mo · {fmtDate(addMonthsIso(todayIso(), customMonths))}
                    </span>
                    <span className="text-base font-bold tabular-nums" style={{ color: FINANCE_COLOR }}>
                      {fmtCurrency(customPayment)}/mo
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1}
                  max={Math.max(120, (loan.termMonths ?? 60))}
                  step={1}
                  value={customMonths}
                  onChange={(e) => setCustomMonths(parseInt(e.target.value, 10))}
                  className="w-full"
                  style={{ accentColor: FINANCE_COLOR }}
                />
              </div>
            </section>
          )}

          {/* ── Drift warning (cached vs computed) ────────────────────── */}
          {Math.abs(cachedVsComputedDrift) > 0.01 && (
            <div className="mb-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-xs">
              <div className="font-semibold text-amber-700 dark:text-amber-400 mb-1">
                Cached balance differs from posted payments
              </div>
              <p className="text-amber-600 dark:text-amber-300">
                Cached: {fmtCurrency(loan.currentBalance)} · From payments: {fmtCurrency(computedBalance)}.
                {" "}Likely cause: payment edit or deletion without a balance refresh.
              </p>
            </div>
          )}

          {/* ── Correction banner ─────────────────────────────────────── */}
          <div className="mb-4 rounded-lg border border-gray-200 dark:border-darkBorder bg-gray-50 dark:bg-darkElevated px-4 py-3 flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[180px]">
              <label className={labelCls}>Lender-stated balance</label>
              <input
                type="number"
                step="0.01"
                className={inputCls}
                placeholder="From your latest statement"
                value={lenderBalance}
                onChange={(e) => setLenderBalance(e.target.value === "" ? "" : parseFloat(e.target.value))}
              />
            </div>
            {cachedVsLenderDrift != null && Math.abs(cachedVsLenderDrift) > 0.01 && (
              <>
                <div className="text-xs">
                  <p className="text-gray-400">Drift</p>
                  <p
                    className="font-semibold tabular-nums"
                    style={{ color: cachedVsLenderDrift > 0 ? "#ef4444" : "#22c55e" }}
                  >
                    {fmtCurrency(cachedVsLenderDrift, "USD", true)}
                  </p>
                </div>
                <button
                  onClick={() => openCorrection(cachedVsLenderDrift)}
                  className="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                  style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR, backgroundColor: FINANCE_COLOR + "18" }}
                >
                  Add correction
                </button>
              </>
            )}
            {cachedVsLenderDrift != null && Math.abs(cachedVsLenderDrift) <= 0.01 && (
              <span className="text-xs text-green-500">✓ Matches lender</span>
            )}
          </div>

          {/* ── Checking account picker ──────────────────────────────── */}
          <div className="mb-4 flex items-center gap-2 text-xs">
            <span className="text-gray-400">Post payments from:</span>
            <select
              className="rounded border border-gray-200 dark:border-darkBorder bg-white dark:bg-darkElevated text-xs px-2 py-1 text-gray-700 dark:text-gray-300"
              value={checkingAccountId}
              onChange={(e) => setCheckingAccountId(e.target.value)}
            >
              <option value="">— select account —</option>
              {accounts.filter((a) => a.type === "CHECKING" && a.active !== false).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* ── Posted payments table ─────────────────────────────────── */}
          <section className="mb-6">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                Posted · {postedPayments.length}
              </h2>
              {postedPayments.length > 0 && (
                <SearchInput value={postedCtl.search} onChange={postedCtl.setSearch} placeholder="Search posted…" />
              )}
            </div>
            {postedPayments.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">No payments posted yet.</p>
            ) : (
              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                <DataTable
                  rows={postedCtl.paged}
                  columns={postedColumns}
                  sortKey={postedCtl.sortKey}
                  sortDir={postedCtl.sortDir}
                  onSort={postedCtl.handleSort}
                  onRowClick={openEditPosted}
                  emptyMessage={postedCtl.search ? "No matches" : "No payments posted yet"}
                />
                <TableControls
                  page={postedCtl.page}
                  totalPages={postedCtl.totalPages}
                  totalItems={postedCtl.totalItems}
                  totalUnfiltered={postedCtl.totalUnfiltered}
                  pageSize={postedCtl.pageSize}
                  setPage={postedCtl.setPage}
                  setPageSize={postedCtl.setPageSize}
                />
              </div>
            )}
          </section>

          {/* ── Scheduled payments table (+ bulk actions) ───────────── */}
          {scheduledPayments.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <h2 className="text-xs uppercase tracking-widest text-gray-400 font-medium">
                  Scheduled · {scheduledPayments.length}
                </h2>
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  <SearchInput value={scheduledCtl.search} onChange={scheduledCtl.setSearch} placeholder="Search scheduled…" />
                  <button onClick={selectThroughToday} className="underline" style={{ color: FINANCE_COLOR }}>
                    Select through today
                  </button>
                  <button onClick={selectAllScheduled} className="underline text-gray-400">
                    Select all
                  </button>
                  {selectedIds.size > 0 && (
                    <>
                      <button onClick={clearSelection} className="underline text-gray-400">
                        Clear ({selectedIds.size})
                      </button>
                      <button
                        onClick={handleBulkPost}
                        disabled={saving}
                        className="px-3 py-1 rounded font-semibold disabled:opacity-50 transition-opacity"
                        style={{ backgroundColor: FINANCE_COLOR, color: "#fff" }}
                      >
                        {saving ? "Posting…" : `Post ${selectedIds.size} selected`}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                <DataTable
                  rows={scheduledCtl.paged}
                  columns={[
                    // Checkbox column (first). Not sortable/searchable — pure UI.
                    {
                      key: "_check",
                      label: "",
                      className: "w-6",
                      render: (p) => (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelect(p.id)}
                        />
                      ),
                    },
                    ...scheduledColumns,
                    // Per-row Post action
                    {
                      key: "_action",
                      label: "Action",
                      align: "right",
                      render: (p) => (
                        <button
                          onClick={(e) => { e.stopPropagation(); openPost(p); }}
                          className="text-[11px] font-semibold px-2 py-0.5 rounded border transition-colors"
                          style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                        >
                          Post
                        </button>
                      ),
                    },
                  ]}
                  sortKey={scheduledCtl.sortKey}
                  sortDir={scheduledCtl.sortDir}
                  onSort={scheduledCtl.handleSort}
                  rowClassName={(p) =>
                    selectedIds.has(p.id) ? "bg-emerald-50 dark:bg-emerald-900/10" : ""
                  }
                  emptyMessage={scheduledCtl.search ? "No matches" : "No scheduled payments"}
                />
                <TableControls
                  page={scheduledCtl.page}
                  totalPages={scheduledCtl.totalPages}
                  totalItems={scheduledCtl.totalItems}
                  totalUnfiltered={scheduledCtl.totalUnfiltered}
                  pageSize={scheduledCtl.pageSize}
                  setPage={scheduledCtl.setPage}
                  setPageSize={scheduledCtl.setPageSize}
                />
              </div>
            </section>
          )}
        </div>

        {/* ── Side panel ───────────────────────────────────────────────── */}
        {panel && (
          <div className="fixed inset-0 z-40 md:static md:inset-auto md:w-96 border-l border-gray-200 dark:border-darkBorder flex flex-col bg-white dark:bg-darkSurface overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-darkBorder flex-shrink-0">
              <h2 className="text-base font-semibold dark:text-rose text-purple">
                {panel.kind === "post"          ? `Post Payment${(panel.payment.sequenceNumber ? ` #${panel.payment.sequenceNumber}` : "")}` :
                 panel.kind === "edit-posted"   ? `Edit Payment${(panel.payment.sequenceNumber ? ` #${panel.payment.sequenceNumber}` : "")}` :
                 panel.kind === "extra"         ? "Extra Payment" :
                 panel.kind === "edit-loan"     ? "Edit Loan" :
                                                  "Balance Correction"}
              </h2>
              <button onClick={() => setPanel(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none ml-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
              {panel.kind === "edit-loan" ? (
                // ── Edit loan metadata form ───────────────────────────────
                // Principal / rate / term / start date are deliberately omitted —
                // changing them would invalidate the generated payment schedule.
                <>
                  <p className="text-[11px] text-gray-400">
                    Principal, rate, term, and start date are locked — changing them would invalidate
                    the payment schedule. To correct those, delete and recreate the loan.
                  </p>

                  <div>
                    <label className={labelCls}>Name *</label>
                    <input type="text" className={inputCls} placeholder="Primary mortgage…"
                      value={loanMetaDraft.name}
                      onChange={(e) => setLoanMetaDraft((d) => ({ ...d, name: e.target.value }))} />
                  </div>

                  <div>
                    <label className={labelCls}>Lender</label>
                    <input type="text" className={inputCls} placeholder="optional"
                      value={loanMetaDraft.lender}
                      onChange={(e) => setLoanMetaDraft((d) => ({ ...d, lender: e.target.value }))} />
                  </div>

                  <div>
                    <label className={labelCls}>Linked Asset</label>
                    <select className={inputCls} value={loanMetaDraft.assetId}
                      onChange={(e) => setLoanMetaDraft((d) => ({ ...d, assetId: e.target.value }))}>
                      <option value="">— none —</option>
                      {assets.filter((a) => a.active !== false).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Links loan to a house/car so equity shows on the asset page.
                    </p>
                  </div>

                  <div>
                    <label className={labelCls}>Escrow Account</label>
                    <select className={inputCls} value={loanMetaDraft.escrowAccountId}
                      onChange={(e) => setLoanMetaDraft((d) => ({ ...d, escrowAccountId: e.target.value }))}>
                      <option value="">— none —</option>
                      {accounts.filter((a) => a.type === "SAVINGS" && a.active !== false).map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Not yet wired to balance. Reserved for a future escrow-sweep feature.
                    </p>
                  </div>

                  <div>
                    <label className={labelCls}>Notes</label>
                    <textarea className={inputCls} rows={2} placeholder="Loan number, terms, refinance history…"
                      value={loanMetaDraft.notes}
                      onChange={(e) => setLoanMetaDraft((d) => ({ ...d, notes: e.target.value }))} />
                  </div>

                  <SaveButton saving={saving} onSave={handleSaveLoanMeta} label="Save" />
                </>
              ) : (
                // ── Payment / correction forms (original body) ─────────────────
                <>
              {panel.kind === "correction" && (
                <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  This adjusts cached balance by {fmtCurrency(panel.delta, "USD", true)} to match lender.
                  Stored as a principal-only record (no transactions).
                </div>
              )}

              <div>
                <label className={labelCls}>Date *</label>
                <input type="date" className={inputCls} value={draft.date}
                  onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
              </div>

              {panel.kind !== "correction" && (
                <>
                  {/* Auto-calc the current-month interest from actual balance, then autofill principal. */}
                  {(panel.kind === "post" || panel.kind === "extra") && (() => {
                    const total = Number(draft.totalAmount);
                    const escAmt  = draft.escrow === "" ? 0 : Number(draft.escrow);
                    const feesAmt = draft.fees   === "" ? 0 : Number(draft.fees);
                    const monthlyRate = (loan.interestRate ?? 0) / 12;
                    // True interest from current cached balance (not from schedule, which assumes no prepayments)
                    const trueInterest = Math.round((loan.currentBalance ?? 0) * monthlyRate * 100) / 100;
                    const impliedPrincipal = Math.round((total - trueInterest - escAmt - feesAmt) * 100) / 100;
                    const canAuto = isFinite(total) && total > 0;

                    function applyAutoCalc() {
                      if (!canAuto) return;
                      setDraft((d) => ({
                        ...d,
                        interest:  trueInterest,
                        principal: impliedPrincipal,
                      }));
                    }

                    return (
                      <div className="rounded-lg bg-gray-50 dark:bg-darkElevated border border-gray-200 dark:border-darkBorder px-3 py-2 text-xs flex flex-col gap-1">
                        <p className="text-gray-500 dark:text-gray-400">
                          Balance before payment: <span className="tabular-nums font-semibold text-gray-700 dark:text-gray-200">{fmtCurrency(loan.currentBalance)}</span>
                          {" · "}
                          Interest this month: <span className="tabular-nums font-semibold text-gray-700 dark:text-gray-200">{fmtCurrency(trueInterest)}</span>
                        </p>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-gray-400">
                            {canAuto
                              ? <>Split a {fmtCurrency(total)} payment → {fmtCurrency(impliedPrincipal)} principal + {fmtCurrency(trueInterest)} interest</>
                              : <>Enter total to auto-calculate principal</>}
                          </span>
                          <button
                            onClick={applyAutoCalc}
                            disabled={!canAuto}
                            className="px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors disabled:opacity-40"
                            style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                          >
                            Auto-split
                          </button>
                        </div>
                      </div>
                    );
                  })()}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Total *</label>
                      <input type="number" step="0.01" className={inputCls}
                        value={draft.totalAmount}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          totalAmount: e.target.value === "" ? "" : parseFloat(e.target.value),
                        }))} />
                    </div>
                    <div>
                      <label className={labelCls}>Principal *</label>
                      <input type="number" step="0.01" className={inputCls}
                        value={draft.principal}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          principal: e.target.value === "" ? "" : parseFloat(e.target.value),
                        }))} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls}>Interest *</label>
                      <input type="number" step="0.01" className={inputCls}
                        value={draft.interest}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          interest: e.target.value === "" ? "" : parseFloat(e.target.value),
                        }))} />
                    </div>
                    <div>
                      <label className={labelCls}>Escrow</label>
                      <input type="number" step="0.01" className={inputCls} placeholder="optional"
                        value={draft.escrow}
                        onChange={(e) => setDraft((d) => ({
                          ...d,
                          escrow: e.target.value === "" ? "" : parseFloat(e.target.value),
                        }))} />
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Fees</label>
                    <input type="number" step="0.01" className={inputCls} placeholder="optional"
                      value={draft.fees}
                      onChange={(e) => setDraft((d) => ({
                        ...d,
                        fees: e.target.value === "" ? "" : parseFloat(e.target.value),
                      }))} />
                  </div>

                  {/* Live sum indicator — confirms split matches total. Green when balanced, amber when off. */}
                  {(() => {
                    const total = Number(draft.totalAmount);
                    const prin  = Number(draft.principal);
                    const intr  = Number(draft.interest);
                    const esc   = draft.escrow === "" ? 0 : Number(draft.escrow);
                    const fees  = draft.fees   === "" ? 0 : Number(draft.fees);
                    const allNumeric = [total, prin, intr, esc, fees].every((n) => isFinite(n));
                    if (!allNumeric || total <= 0) return null;
                    const sum = prin + intr + esc + fees;
                    const diff = sum - total;
                    const matches = Math.abs(diff) < 0.01;
                    return (
                      <div
                        className="rounded-lg border px-3 py-2 flex items-center justify-between text-xs"
                        style={{
                          borderColor:     matches ? "#22c55e55" : "#f59e0b55",
                          backgroundColor: matches ? "#22c55e11" : "#f59e0b11",
                        }}
                      >
                        <span className="text-gray-500 dark:text-gray-400">
                          Principal + interest{esc || fees ? " + escrow/fees" : ""}
                        </span>
                        <span
                          className="tabular-nums font-semibold"
                          style={{ color: matches ? "#22c55e" : "#f59e0b" }}
                        >
                          {fmtCurrency(sum)}
                          {!matches && (
                            <span className="ml-1 text-[11px]">
                              ({fmtCurrency(diff, "USD", true)} off)
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })()}
                </>
              )}

              {panel.kind === "correction" && (
                <div>
                  <label className={labelCls}>Correction Amount *</label>
                  <input type="number" step="0.01" className={inputCls}
                    value={draft.principal}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      principal: e.target.value === "" ? "" : parseFloat(e.target.value),
                    }))} />
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    Positive = reduces owed balance (lender says you owe less).
                    Negative = increases owed balance.
                  </p>
                </div>
              )}

              <div>
                <label className={labelCls}>Notes</label>
                <input type="text" className={inputCls} placeholder="optional"
                  value={draft.notes}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
              </div>

              {/* Checking-side debit toggle. Off by default — most users
                  already import the matching debit from CSV, so creating it
                  here would double-count. Hidden on the principal-only
                  correction flow since corrections never touch checking. */}
              {panel.kind !== "correction" && (
                <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={draft.createCheckingTx}
                    onChange={(e) => setDraft((d) => ({ ...d, createCheckingTx: e.target.checked }))}
                  />
                  <span>
                    Also debit the paying account for {fmtCurrency(Number(draft.totalAmount) || 0)}
                    <span className="block text-[10px] text-gray-400">
                      Leave off if your bank statement is already imported — it would double-count.
                    </span>
                  </span>
                </label>
              )}

              <SaveButton saving={saving} onSave={handleSingleSave}
                label={
                  panel.kind === "post"         ? "Post Payment" :
                  panel.kind === "edit-posted"  ? "Save" :
                  panel.kind === "extra"        ? "Log Extra Payment" :
                                                  "Save Correction"
                } />
              {panel.kind === "edit-posted" && (
                <DeleteButton saving={saving} onDelete={() => handleDeletePayment(panel.payment)} />
              )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────────

function ScenarioTile({
  label, payment, sub, accent,
}: {
  label:    string;
  payment:  number;
  sub:      string;
  accent?:  string;
}) {
  const color = accent ?? FINANCE_COLOR;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-darkBorder px-3 py-2 flex flex-col gap-0.5">
      <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">{label}</p>
      <p className="text-base font-bold tabular-nums" style={{ color }}>
        {fmtCurrency(payment)}<span className="text-xs font-normal text-gray-400">/mo</span>
      </p>
      <p className="text-[10px] text-gray-500 dark:text-gray-400">{sub}</p>
    </div>
  );
}
