import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { uploadData, getUrl } from "aws-amplify/storage";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import { mutate, reportError, notifyError, notifySuccess } from "@/components/common/mutate";
import {
  client,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState,
  fetchInvoices, fetchInvoiceLinks, fetchTransactions,
  type InvoiceRecord, type InvoiceLinkRecord, type TransactionRecord,
} from "@/components/finance/_shared";
import { POSITIVE, NEGATIVE, WARNING, withAlpha } from "@/lib/colors";
import { Badge, SlideOverPanel } from "@/components/common/ui";
import {
  ColDef, DataTable, SearchInput, TableControls, useTableControls,
} from "@/components/common/table";

const S3_BUCKET = "gennaroanesi.com";

// ── Invoice line items (read-only) ─────────────────────────────────────────
// `items` is the AWSJSON-via-string column written by the processor Lambda:
// [{description, qty, unitPrice, amount}]. Defensive parse — a malformed
// blob renders as "no items" instead of crashing the panel.

type InvoiceItem = { description?: string; qty?: number; unitPrice?: number; amount?: number };

function parseItems(raw: string | null | undefined): InvoiceItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x === "object") : [];
  } catch {
    return [];
  }
}

// ── Status badge colors ─────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  PARSED:       POSITIVE,
  NEEDS_REVIEW: WARNING,
  ERROR:        NEGATIVE,
};
const STATUS_LABEL: Record<string, string> = {
  PARSED:       "Parsed",
  NEEDS_REVIEW: "Review",
  ERROR:        "Error",
};

function StatusBadgeCell({ status }: { status: string | null | undefined }) {
  const s = status ?? "NEEDS_REVIEW";
  return <Badge color={STATUS_COLOR[s] ?? WARNING}>{STATUS_LABEL[s] ?? s}</Badge>;
}

// ── Date helper ─────────────────────────────────────────────────────────────

function addDaysIso(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type PanelState = { rec: InvoiceRecord } | null;

export default function InvoicesPage() {
  const { authState } = useRequireAuth();

  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [allLinks, setAllLinks] = useState<InvoiceLinkRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  const [panel, setPanel] = useState<PanelState>(null);
  const [draft, setDraft] = useState<Partial<InvoiceRecord>>({});

  // Panel-scoped async state
  const [pdfUrl,       setPdfUrl]       = useState<string | null>(null);
  const [panelLinks,   setPanelLinks]   = useState<InvoiceLinkRecord[]>([]);
  const [linkedTxs,    setLinkedTxs]    = useState<Map<string, TransactionRecord>>(new Map());
  const [candidates,   setCandidates]   = useState<TransactionRecord[]>([]);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [showLinkPicker,  setShowLinkPicker]  = useState(false);
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Data fetch ───────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [invs, links] = await Promise.all([fetchInvoices(), fetchInvoiceLinks()]);
      setInvoices(invs);
      setAllLinks(links);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  const linkCountByInvoice = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of allLinks) m.set(l.invoiceId, (m.get(l.invoiceId) ?? 0) + 1);
    return m;
  }, [allLinks]);

  // ── Panel open/close ─────────────────────────────────────────────────────

  const closePanel = useCallback(() => {
    setPanel(null);
    setDraft({});
    setPdfUrl(null);
    setPanelLinks([]);
    setLinkedTxs(new Map());
    setCandidates([]);
    setCandidateSearch("");
    setShowLinkPicker(false);
  }, []);

  const openInvoice = useCallback(async (rec: InvoiceRecord) => {
    setPanel({ rec });
    setDraft({ ...rec });
    setPdfUrl(null);
    setPanelLinks([]);
    setLinkedTxs(new Map());
    setCandidates([]);
    setCandidateSearch("");
    setShowLinkPicker(false);

    // Signed URLs expire — generate fresh on every panel open.
    if (rec.s3KeyPdf) {
      try {
        const { url } = await getUrl({
          path:    rec.s3KeyPdf,
          options: { bucket: S3_BUCKET, expiresIn: 900 },
        });
        setPdfUrl(url.toString());
      } catch (e) {
        console.warn("[invoices] getUrl failed", e);
      }
    }

    try {
      const links = await fetchInvoiceLinks({ invoiceId: rec.id });
      setPanelLinks(links);
      // Resolve linked transactions individually — they can sit outside any
      // candidate window, so a targeted get() per link beats a broad scan.
      const txEntries = await Promise.all(links.map(async (l) => {
        const { data } = await (client.models.financeTransaction as any).get({ id: l.transactionId });
        return [l.transactionId, data as TransactionRecord | null] as const;
      }));
      const m = new Map<string, TransactionRecord>();
      for (const [id, tx] of txEntries) if (tx) m.set(id, tx);
      setLinkedTxs(m);
    } catch (e) {
      console.warn("[invoices] link fetch failed", e);
    }

    if (rec.issueDate) {
      try {
        const txs = await fetchTransactions({
          from: addDaysIso(rec.issueDate, -7),
          to:   addDaysIso(rec.issueDate, 21),
        });
        setCandidates(txs);
      } catch (e) {
        console.warn("[invoices] candidate fetch failed", e);
      }
    }
  }, []);

  // ── Save / delete ────────────────────────────────────────────────────────

  const saveValid = !!(draft.vendor?.trim() && draft.total != null && draft.issueDate);

  const handleSave = useCallback(async () => {
    if (!panel || !saveValid) return;
    setSaving(true);
    try {
      // A manual save that passes validation IS the review — promote
      // NEEDS_REVIEW (and manually-completed ERROR rows) to PARSED.
      const nextStatus = panel.rec.parseStatus === "PARSED" ? undefined : ("PARSED" as const);
      const updated = await mutate((client.models.financeInvoice as any).update({
        id:            panel.rec.id,
        vendor:        draft.vendor?.trim() ?? null,
        invoiceNumber: draft.invoiceNumber?.trim() || null,
        issueDate:     draft.issueDate || null,
        dueDate:       draft.dueDate || null,
        currency:      draft.currency?.trim() || "USD",
        subtotal:      draft.subtotal ?? null,
        tax:           draft.tax ?? null,
        total:         draft.total ?? null,
        notes:         draft.notes?.trim() || null,
        ...(nextStatus ? { parseStatus: nextStatus, parseError: null } : {}),
      })) as InvoiceRecord | null;
      if (updated) {
        setInvoices((p) => p.map((i) => (i.id === updated.id ? updated : i)));
        setPanel({ rec: updated });
        setDraft({ ...updated });
      }
      notifySuccess("Invoice saved");
    } catch (err) {
      reportError(err, "Save invoice");
    } finally {
      setSaving(false);
    }
  }, [panel, draft, saveValid]);

  const handleDelete = useCallback(async () => {
    if (!panel) return;
    // window.confirm matches the rest of the finance section today; the
    // modal migration is a known TODO across the section.
    if (!confirm(`Delete invoice ${panel.rec.vendor ?? panel.rec.id}? The stored PDF stays in S3.`)) return;
    setSaving(true);
    try {
      // Remove its links too so no orphan rows point at a dead invoice.
      const links = await fetchInvoiceLinks({ invoiceId: panel.rec.id });
      await Promise.all(links.map((l) =>
        mutate((client.models.financeInvoiceLink as any).delete({ id: l.id })),
      ));
      await mutate((client.models.financeInvoice as any).delete({ id: panel.rec.id }));
      setInvoices((p) => p.filter((i) => i.id !== panel.rec.id));
      setAllLinks((p) => p.filter((l) => l.invoiceId !== panel.rec.id));
      closePanel();
    } catch (err) {
      reportError(err, "Delete invoice");
    } finally {
      setSaving(false);
    }
  }, [panel, closePanel]);

  // ── Link management ──────────────────────────────────────────────────────

  const createLink = useCallback(async (tx: TransactionRecord) => {
    if (!panel) return;
    setSaving(true);
    try {
      const link = await mutate((client.models.financeInvoiceLink as any).create({
        invoiceId:     panel.rec.id,
        transactionId: tx.id,
        amount:        draft.total ?? panel.rec.total ?? null,
      })) as InvoiceLinkRecord | null;
      if (link) {
        setPanelLinks((p) => [...p, link]);
        setLinkedTxs((p) => new Map(p).set(tx.id, tx));
        setAllLinks((p) => [...p, link]);
      }
      setShowLinkPicker(false);
    } catch (err) {
      reportError(err, "Link transaction");
    } finally {
      setSaving(false);
    }
  }, [panel, draft.total]);

  const removeLink = useCallback(async (link: InvoiceLinkRecord) => {
    setSaving(true);
    try {
      await mutate((client.models.financeInvoiceLink as any).delete({ id: link.id }));
      setPanelLinks((p) => p.filter((l) => l.id !== link.id));
      setAllLinks((p) => p.filter((l) => l.id !== link.id));
    } catch (err) {
      reportError(err, "Unlink");
    } finally {
      setSaving(false);
    }
  }, []);

  const updateLinkAmount = useCallback(async (link: InvoiceLinkRecord, raw: string) => {
    const amount = raw.trim() === "" ? null : parseFloat(raw);
    if (amount !== null && !Number.isFinite(amount)) return;
    if ((link.amount ?? null) === amount) return;
    try {
      const updated = await mutate((client.models.financeInvoiceLink as any).update({
        id: link.id, amount,
      })) as InvoiceLinkRecord | null;
      if (updated) {
        setPanelLinks((p) => p.map((l) => (l.id === updated.id ? updated : l)));
        setAllLinks((p) => p.map((l) => (l.id === updated.id ? updated : l)));
      }
    } catch (err) {
      reportError(err, "Update allocation");
    }
  }, []);

  // Candidate list: closest |amount| to the invoice total first, top 15,
  // already-linked rows excluded, free-text narrowed by the picker search.
  const rankedCandidates = useMemo(() => {
    const total = Math.abs(draft.total ?? panel?.rec.total ?? 0);
    const linkedIds = new Set(panelLinks.map((l) => l.transactionId));
    const q = candidateSearch.trim().toLowerCase();
    return candidates
      .filter((t) => !linkedIds.has(t.id))
      .filter((t) => !q
        || (t.description ?? "").toLowerCase().includes(q)
        || (t.category ?? "").toLowerCase().includes(q)
        || String(Math.abs(t.amount ?? 0).toFixed(2)).includes(q))
      .sort((a, b) =>
        Math.abs(Math.abs(a.amount ?? 0) - total) - Math.abs(Math.abs(b.amount ?? 0) - total))
      .slice(0, 15);
  }, [candidates, panelLinks, candidateSearch, draft.total, panel]);

  // ── Manual upload flow ───────────────────────────────────────────────────
  // Upload the PDF under the same key layout the processor Lambda uses, then
  // create a NEEDS_REVIEW row and open the panel for manual field entry.
  // (Client-side extraction is a later custom mutation.)

  const onPickFile = useCallback(() => fileInputRef.current?.click(), []);

  const onFileChosen = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      notifyError("Only PDF files are supported.");
      return;
    }
    setUploading(true);
    try {
      const invoiceId = crypto.randomUUID();
      const s3KeyPdf = `private/invoices/${invoiceId}/invoice.pdf`;
      await uploadData({
        path:    s3KeyPdf,
        data:    file,
        options: { bucket: S3_BUCKET, contentType: "application/pdf" },
      }).result;

      const created = await mutate((client.models.financeInvoice as any).create({
        id:          invoiceId,
        s3KeyPdf,
        source:      "UPLOAD",
        parseStatus: "NEEDS_REVIEW",
        parseError:  "manually uploaded — fields not extracted",
        currency:    "USD",
        issueDate:   todayIso(),
        receivedAt:  new Date().toISOString(),
      })) as InvoiceRecord | null;
      if (!created) throw new Error("Create returned no record");
      setInvoices((p) => [created, ...p]);
      await openInvoice(created);
    } catch (err) {
      reportError(err, "Upload invoice");
    } finally {
      setUploading(false);
    }
  }, [openInvoice]);

  // ── Open original .eml ───────────────────────────────────────────────────

  const openOriginal = useCallback(async () => {
    if (!panel?.rec.s3KeyOriginal) return;
    try {
      const { url } = await getUrl({
        path:    panel.rec.s3KeyOriginal,
        options: { bucket: S3_BUCKET, expiresIn: 300 },
      });
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch (e) {
      console.warn("[invoices] getUrl(.eml) failed", e);
      notifyError("Could not generate a link for the original email.");
    }
  }, [panel]);

  // ── Table ────────────────────────────────────────────────────────────────

  const columns: ColDef<InvoiceRecord>[] = useMemo(() => [
    {
      key:    "issueDate",
      label:  "Date",
      render: (r) => <span className="tabular-nums text-gray-700 dark:text-gray-200">{fmtDate(r.issueDate)}</span>,
      sortValue:   (r) => r.issueDate ?? "",
      searchValue: (r) => fmtDate(r.issueDate) ?? "",
    },
    {
      key:    "vendor",
      label:  "Vendor",
      render: (r) => <span className="text-gray-700 dark:text-gray-200">{r.vendor ?? <span className="text-gray-400 italic">unknown</span>}</span>,
      sortValue:   (r) => (r.vendor ?? "").toLowerCase(),
      searchValue: (r) => r.vendor ?? "",
    },
    {
      key:    "invoiceNumber",
      label:  "Number",
      mobileHidden: true,
      render: (r) => <span className="text-gray-500 dark:text-gray-400 tabular-nums">{r.invoiceNumber ?? "—"}</span>,
      sortValue:   (r) => r.invoiceNumber ?? "",
      searchValue: (r) => r.invoiceNumber ?? "",
    },
    {
      key:    "total",
      label:  "Total",
      align:  "right",
      render: (r) => <span className="tabular-nums">{r.total != null ? fmtCurrency(r.total, r.currency ?? "USD") : "—"}</span>,
      sortValue:   (r) => r.total ?? null,
      searchValue: (r) => (r.total != null ? r.total.toFixed(2) : ""),
    },
    {
      key:    "parseStatus",
      label:  "Status",
      align:  "center",
      render: (r) => <StatusBadgeCell status={r.parseStatus} />,
      sortValue:   (r) => r.parseStatus ?? "",
      searchValue: (r) => r.parseStatus ?? "",
    },
    {
      key:    "linked",
      label:  "Linked",
      align:  "center",
      mobileHidden: true,
      render: (r) => {
        const n = linkCountByInvoice.get(r.id) ?? 0;
        return n > 0
          ? <span className="tabular-nums text-xs" style={{ color: FINANCE_COLOR }}>{n} tx</span>
          : <span className="text-gray-400">—</span>;
      },
      sortValue:   (r) => linkCountByInvoice.get(r.id) ?? 0,
      searchValue: () => "",
    },
  ], [linkCountByInvoice]);

  const tableCtl = useTableControls(invoices, {
    defaultSortKey: "issueDate",
    defaultSortDir: "desc",
    getSortValue:   (row, key) => columns.find((c) => c.key === key)?.sortValue?.(row),
    getSearchText:  (row) =>
      columns.map((c) => c.searchValue?.(row) ?? "").filter(Boolean).join(" "),
    initialPageSize: 50,
  });

  if (authState !== "authenticated") return null;

  const items = parseItems(panel ? (panel.rec.items as string | null) : null);
  const isPdfPanel = !!panel;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
            <span>›</span>
            <span>Invoices</span>
          </div>

          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Invoices</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Forward bills to invoices@gennaroanesi.com — or upload a PDF directly.
              </p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                onChange={onFileChosen}
                className="hidden"
              />
              <button
                onClick={onPickFile}
                disabled={uploading}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: FINANCE_COLOR, color: "#fff" }}
              >
                {uploading ? "Uploading…" : "+ Upload PDF"}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap mb-4">
            <div className="ml-auto">
              <SearchInput value={tableCtl.search} onChange={tableCtl.setSearch} placeholder="Search vendor, number…" />
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 italic">Loading…</p>
          ) : invoices.length === 0 && !tableCtl.search ? (
            <EmptyState label="invoices" onAdd={onPickFile} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
              <DataTable
                rows={tableCtl.paged}
                columns={columns}
                sortKey={tableCtl.sortKey}
                sortDir={tableCtl.sortDir}
                onSort={tableCtl.handleSort}
                onRowClick={(r) => void openInvoice(r)}
                emptyMessage={tableCtl.search ? "No matches" : "No invoices"}
              />
              <TableControls
                page={tableCtl.page}
                totalPages={tableCtl.totalPages}
                totalItems={tableCtl.totalItems}
                totalUnfiltered={tableCtl.totalUnfiltered}
                pageSize={tableCtl.pageSize}
                setPage={tableCtl.setPage}
                setPageSize={tableCtl.setPageSize}
              />
            </div>
          )}
        </div>

        {/* ── Side panel ─────────────────────────────────────────────── */}
        {isPdfPanel && panel && (
          <SlideOverPanel
            title={panel.rec.vendor ?? "Invoice"}
            onClose={closePanel}
            width="md:w-[30rem]"
            titleClassName="truncate"
          >
            {/* PDF preview — signed URL, regenerated on every open */}
            {pdfUrl ? (
              <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-hidden">
                <iframe
                  src={pdfUrl}
                  title="Invoice PDF"
                  className="w-full h-64 bg-white"
                />
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">Loading PDF preview…</p>
            )}
            <div className="flex items-center justify-between text-[11px]">
              {pdfUrl && (
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer"
                  className="hover:underline" style={{ color: FINANCE_COLOR }}>
                  Open PDF in new tab
                </a>
              )}
              {panel.rec.s3KeyOriginal && (
                <button onClick={openOriginal} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">
                  Open original (.eml)
                </button>
              )}
            </div>

            {panel.rec.parseStatus !== "PARSED" && (
              <div className="rounded-lg px-3 py-2 text-xs"
                style={{ backgroundColor: withAlpha(STATUS_COLOR[panel.rec.parseStatus ?? "NEEDS_REVIEW"] ?? WARNING, 0x22), color: STATUS_COLOR[panel.rec.parseStatus ?? "NEEDS_REVIEW"] ?? WARNING }}>
                {panel.rec.parseStatus === "ERROR" ? "Extraction failed" : "Needs review"}
                {panel.rec.parseError ? ` — ${panel.rec.parseError}` : ""}. Complete the fields and save to mark as parsed.
              </div>
            )}

            {/* Editable fields */}
            <div>
              <label className={labelCls}>Vendor *</label>
              <input type="text" className={inputCls} placeholder="e.g. Reliant Energy"
                value={draft.vendor ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, vendor: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Invoice #</label>
                <input type="text" className={inputCls}
                  value={draft.invoiceNumber ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, invoiceNumber: e.target.value }))} />
              </div>
              <div>
                <label className={labelCls}>Currency</label>
                <input type="text" className={inputCls} placeholder="USD"
                  value={draft.currency ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value.toUpperCase() }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Issue date *</label>
                <input type="date" className={inputCls}
                  value={draft.issueDate ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, issueDate: e.target.value }))} />
              </div>
              <div>
                <label className={labelCls}>Due date</label>
                <input type="date" className={inputCls}
                  value={draft.dueDate ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {([
                ["subtotal", "Subtotal"],
                ["tax",      "Tax"],
                ["total",    "Total *"],
              ] as const).map(([field, label]) => (
                <div key={field}>
                  <label className={labelCls}>{label}</label>
                  <input type="number" step="0.01" className={inputCls} placeholder="0.00"
                    value={draft[field] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : parseFloat(e.target.value);
                      setDraft((d) => ({ ...d, [field]: v !== null && Number.isFinite(v) ? v : null }));
                    }} />
                </div>
              ))}
            </div>
            <div>
              <label className={labelCls}>Notes</label>
              <textarea rows={2} className={`${inputCls} resize-none`}
                value={draft.notes ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
            </div>

            {/* Items — read-only (editing items is out of scope for v1) */}
            {items.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">Line items</p>
                <div className="rounded border border-gray-200 dark:border-darkBorder overflow-hidden">
                  {items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs border-b last:border-b-0 border-gray-100 dark:border-darkBorder/50">
                      <span className="text-gray-700 dark:text-gray-200 truncate flex-1">{it.description ?? "—"}</span>
                      {it.qty != null && <span className="text-gray-400 tabular-nums flex-shrink-0">×{it.qty}</span>}
                      <span className="text-gray-500 dark:text-gray-400 tabular-nums flex-shrink-0">
                        {it.amount != null ? fmtCurrency(it.amount, draft.currency ?? "USD") : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Email provenance */}
            {(panel.rec.emailFrom || panel.rec.emailSubject) && (
              <p className="text-[10px] text-gray-400 leading-snug">
                {panel.rec.emailFrom && <>From {panel.rec.emailFrom}. </>}
                {panel.rec.emailSubject && <>Subject: “{panel.rec.emailSubject}”. </>}
                Received {panel.rec.receivedAt ? fmtDate(panel.rec.receivedAt.slice(0, 10)) : "—"}.
              </p>
            )}

            {/* ── Linked transactions ───────────────────────────────── */}
            <div className="border-t border-gray-200 dark:border-darkBorder pt-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                  Linked transactions{panelLinks.length > 0 ? ` (${panelLinks.length})` : ""}
                </p>
                <button
                  onClick={() => setShowLinkPicker((v) => !v)}
                  className="text-[11px] font-medium"
                  style={{ color: FINANCE_COLOR }}
                >
                  {showLinkPicker ? "Cancel" : "+ Link a transaction"}
                </button>
              </div>

              {panelLinks.length === 0 && !showLinkPicker && (
                <p className="text-xs text-gray-400 italic">Not linked to any transaction yet.</p>
              )}

              {panelLinks.map((link) => {
                const tx = linkedTxs.get(link.transactionId);
                return (
                  <div key={link.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded border border-gray-200 dark:border-darkBorder bg-gray-50/50 dark:bg-white/[0.02]">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700 dark:text-gray-200 truncate">
                        {tx?.description ?? link.transactionId}
                      </p>
                      <p className="text-[10px] text-gray-400 tabular-nums">
                        {tx?.date ? fmtDate(tx.date) : "—"}
                        {tx && <> · <span style={{ color: amountColor(tx.amount ?? 0) }}>{fmtCurrency(tx.amount ?? 0, "USD", true)}</span></>}
                      </p>
                    </div>
                    {/* Allocated amount — partial allocations (1 tx ↔ N invoices) */}
                    <input
                      type="number" step="0.01" placeholder="alloc"
                      title="Amount of this transaction allocated to this invoice"
                      className="w-20 flex-shrink-0 bg-white dark:bg-darkElevated border border-gray-200 dark:border-darkBorder rounded px-1.5 py-1 text-xs text-right tabular-nums text-gray-700 dark:text-gray-200"
                      defaultValue={link.amount ?? ""}
                      onBlur={(e) => void updateLinkAmount(link, e.target.value)}
                    />
                    <button onClick={() => void removeLink(link)} disabled={saving}
                      title="Unlink"
                      className="text-gray-400 hover:text-red-500 text-sm leading-none px-1 flex-shrink-0">×</button>
                  </div>
                );
              })}

              {showLinkPicker && (
                <div className="flex flex-col gap-1.5">
                  <input
                    type="text" placeholder="Filter candidates…"
                    className={inputCls}
                    value={candidateSearch}
                    onChange={(e) => setCandidateSearch(e.target.value)}
                  />
                  {!panel.rec.issueDate && !draft.issueDate ? (
                    <p className="text-[10px] text-amber-500">Set an issue date first — candidates come from ±3 weeks around it.</p>
                  ) : rankedCandidates.length === 0 ? (
                    <p className="text-xs text-gray-400 italic">No unlinked transactions in the window.</p>
                  ) : (
                    rankedCandidates.map((tx) => (
                      <button key={tx.id} type="button" onClick={() => void createLink(tx)}
                        disabled={saving}
                        className="flex items-center gap-2 px-2 py-1.5 rounded border border-dashed border-gray-200 dark:border-darkBorder hover:border-gray-300 dark:hover:border-gray-500 hover:bg-gray-50 dark:hover:bg-white/5 text-left transition-colors">
                        <span className="text-gray-400 text-xs flex-shrink-0">+</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-700 dark:text-gray-200 truncate">{tx.description ?? "(no description)"}</p>
                          <p className="text-[10px] text-gray-400 tabular-nums">{fmtDate(tx.date)}</p>
                        </div>
                        <span className="text-xs tabular-nums flex-shrink-0" style={{ color: amountColor(tx.amount ?? 0) }}>
                          {fmtCurrency(tx.amount ?? 0, "USD", true)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <SaveButton saving={saving} onSave={handleSave} disabled={!saveValid} />
            <DeleteButton saving={saving} onDelete={handleDelete} />
          </SlideOverPanel>
        )}
      </div>
    </FinanceLayout>
  );
}
