import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { uploadData } from "aws-amplify/storage";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import FinanceLayout from "@/layouts/finance";
import {
  client,
  FINANCE_COLOR,
  fmtCurrency, fmtDate, todayIso, amountColor,
  inputCls, labelCls,
  SaveButton, DeleteButton, EmptyState,
  listAll,
  PAYCHECK_PERSONS, PAYCHECK_PERSON_LABELS,
  type PaycheckRecord, type AttachmentRecord, type PaycheckPerson, type PaycheckLineItem,
} from "@/components/finance/_shared";

const S3_BUCKET = "gennaroanesi.com";

// ── Numeric fields surfaced in the form. Used to (1) build the form rows
// programmatically and (2) coerce the AI-extracted draft into the typed
// shape Amplify expects on save.
const NUMERIC_FIELDS = [
  "gross", "taxableWage", "net", "imputedGtl",
  "fedWh", "oasdi", "medicare",
  "contrib401k", "contribAfterTax401k", "hsa", "fsa",
  "medical", "dental", "vision",
  "ytdGross", "ytdTaxableWage", "ytdFedWh", "ytdOasdi", "ytdMedicare",
  "ytd401k", "ytdAfterTax401k", "ytdNet",
] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

const NUMERIC_FIELD_GROUPS: Array<{ heading: string; fields: NumericField[] }> = [
  { heading: "Headline",        fields: ["gross", "taxableWage", "net", "imputedGtl"] },
  { heading: "Withholding",     fields: ["fedWh", "oasdi", "medicare"] },
  { heading: "Contributions",   fields: ["contrib401k", "contribAfterTax401k", "hsa", "fsa"] },
  { heading: "Premiums",        fields: ["medical", "dental", "vision"] },
  { heading: "Year-to-date",    fields: ["ytdGross", "ytdTaxableWage", "ytdFedWh", "ytdOasdi", "ytdMedicare", "ytd401k", "ytdAfterTax401k", "ytdNet"] },
];

const FIELD_LABELS: Record<NumericField, string> = {
  gross:               "Gross",
  taxableWage:         "Taxable wage",
  net:                 "Net",
  imputedGtl:          "Imp GTL",
  fedWh:               "Federal WH",
  oasdi:               "OASDI",
  medicare:            "Medicare",
  contrib401k:         "401k",
  contribAfterTax401k: "After-tax 401k",
  hsa:                 "HSA",
  fsa:                 "FSA",
  medical:             "Medical",
  dental:              "Dental",
  vision:              "Vision",
  ytdGross:            "YTD Gross",
  ytdTaxableWage:      "YTD Taxable",
  ytdFedWh:            "YTD Fed WH",
  ytdOasdi:            "YTD OASDI",
  ytdMedicare:         "YTD Medicare",
  ytd401k:             "YTD 401k",
  ytdAfterTax401k:     "YTD A/T 401k",
  ytdNet:              "YTD Net",
};

type Draft = Partial<PaycheckRecord> & {
  lineItems?: PaycheckLineItem[] | null;
  // Pending attachment from the upload flow — saved alongside the paycheck
  // row once the user confirms.
  pendingAttachment?: { s3Key: string; filename: string; contentType: string; sizeBytes: number } | null;
};

type PanelState =
  | { kind: "new" }
  | { kind: "edit"; rec: PaycheckRecord }
  | null;

export default function PaychecksPage() {
  const { authState } = useRequireAuth();

  const [paychecks,       setPaychecks]       = useState<PaycheckRecord[]>([]);
  const [attachmentsById, setAttachmentsById] = useState<Map<string, AttachmentRecord[]>>(new Map());
  const [loading,         setLoading]         = useState(true);
  const [saving,          setSaving]          = useState(false);
  const [panel,           setPanel]           = useState<PanelState>(null);
  const [draft,           setDraft]           = useState<Draft>({});
  const [parseStatus,     setParseStatus]     = useState<"idle" | "uploading" | "parsing" | "error">("idle");
  const [parseError,      setParseError]      = useState<string | null>(null);

  const [filterPerson, setFilterPerson] = useState<PaycheckPerson | "ALL">("ALL");
  const [filterYear,   setFilterYear]   = useState<number | "ALL">("ALL");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Data fetch ─────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // The full schema is deep enough that letting TS infer a generic
      // through `client.models.<x>.list` trips its "excessively deep" guard
      // (CLAUDE.md note 4). Erasing the model type at the call site is the
      // sanctioned workaround — the result is re-typed via the explicit
      // listAll<X> parameter. Volume is tiny so a client-side parentType
      // filter on attachments is fine.
      const rows = await listAll<PaycheckRecord>(client.models.financePaycheck as any);
      const atts = await listAll<AttachmentRecord>(client.models.attachment as any);
      const byParent = new Map<string, AttachmentRecord[]>();
      for (const a of atts) {
        if (a.parentType !== "PAYCHECK") continue;
        const list = byParent.get(a.parentId) ?? [];
        list.push(a);
        byParent.set(a.parentId, list);
      }
      setPaychecks(rows);
      setAttachmentsById(byParent);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    fetchData();
  }, [authState, fetchData]);

  // ── Derived: filters + grouping ────────────────────────────────────────

  const availableYears = useMemo(() => {
    const ys = new Set<number>();
    for (const p of paychecks) {
      const y = (p.payDate ?? "").slice(0, 4);
      if (y) ys.add(Number(y));
    }
    return Array.from(ys).sort((a, b) => b - a);
  }, [paychecks]);

  const filtered = useMemo(() => {
    return paychecks
      .filter((p) => filterPerson === "ALL" || p.person === filterPerson)
      .filter((p) => filterYear   === "ALL" || (p.payDate ?? "").startsWith(String(filterYear)))
      .sort((a, b) => (b.payDate ?? "").localeCompare(a.payDate ?? ""));
  }, [paychecks, filterPerson, filterYear]);

  // ── Panel helpers ───────────────────────────────────────────────────────

  const openNew = useCallback(() => {
    setDraft({ person: "ME" as any, payDate: todayIso(), lineItems: [] });
    setParseError(null);
    setParseStatus("idle");
    setPanel({ kind: "new" });
  }, []);

  const openEdit = useCallback((rec: PaycheckRecord) => {
    setDraft({ ...rec, lineItems: (rec.lineItems as PaycheckLineItem[] | null) ?? [] });
    setParseError(null);
    setParseStatus("idle");
    setPanel({ kind: "edit", rec });
  }, []);

  const closePanel = useCallback(() => {
    setPanel(null);
    setDraft({});
    setParseError(null);
    setParseStatus("idle");
  }, []);

  // ── Upload + parse flow ─────────────────────────────────────────────────
  // 1. Upload PDF to S3 under `attachments/PAYCHECK/staging/`.
  // 2. Call parsePaycheckPdf mutation with the s3Key.
  // 3. Pre-fill the form with the returned draft. The s3Key is held in
  //    `pendingAttachment` so saving the paycheck also creates the
  //    attachment row.
  const onPickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChosen = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so picking the same file again still fires
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setParseError("Only PDF files are supported.");
      return;
    }
    setParseError(null);
    setParseStatus("uploading");

    const ts = Date.now();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
    const s3Key = `attachments/PAYCHECK/staging/${ts}-${safeName}`;

    try {
      await uploadData({
        path:    s3Key,
        data:    file,
        options: { bucket: S3_BUCKET, contentType: "application/pdf" },
      }).result;
    } catch (err) {
      console.error("[paychecks] upload failed", err);
      setParseError(err instanceof Error ? err.message : "Upload failed");
      setParseStatus("error");
      return;
    }

    setParseStatus("parsing");
    try {
      const personArg = (draft.person ?? "ME") as PaycheckPerson;
      const { data: result, errors } = await client.mutations.parsePaycheckPdf({
        s3Key,
        person: personArg,
      });
      if (errors?.length || !result) {
        throw new Error(errors?.[0]?.message ?? "Parse mutation returned no result");
      }
      if (!result.ok) {
        throw new Error(result.error ?? "Parser returned an error");
      }

      // Coerce the AI's JSON into the typed draft. AppSync serializes the
      // `a.json()` return field as a JSON string — parse it back into an
      // object before field access. Defensive: also accept the case where
      // a future schema/client change starts handing us an object directly.
      const draftRaw: unknown = result.draft;
      let raw: Record<string, unknown> = {};
      if (typeof draftRaw === "string") {
        try { raw = JSON.parse(draftRaw) as Record<string, unknown>; }
        catch { raw = {}; }
      } else if (draftRaw && typeof draftRaw === "object") {
        raw = draftRaw as Record<string, unknown>;
      }
      const next: Draft = {
        person:      personArg as any,
        payDate:     stringField(raw, "payDate") ?? todayIso(),
        periodStart: stringField(raw, "periodStart"),
        periodEnd:   stringField(raw, "periodEnd"),
        lineItems:   coerceLineItems(raw["lineItems"]),
        pendingAttachment: {
          s3Key,
          filename:    file.name,
          contentType: "application/pdf",
          sizeBytes:   file.size,
        },
      };
      for (const f of NUMERIC_FIELDS) {
        const v = numericField(raw, f);
        if (v !== null) (next as any)[f] = v;
      }
      setDraft(next);
      setParseStatus("idle");
    } catch (err) {
      console.error("[paychecks] parse failed", err);
      setParseError(err instanceof Error ? err.message : "Parse failed");
      setParseStatus("error");
    }
  }, [draft.person]);

  // ── Save / delete ───────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!draft.person || !draft.payDate || draft.gross == null || draft.net == null) {
      alert("Person, pay date, gross and net are required.");
      return;
    }
    setSaving(true);
    try {
      const payload: any = { ...draft };
      delete payload.pendingAttachment;
      // Strip server-managed fields when editing
      delete payload.id;
      delete payload.createdAt;
      delete payload.updatedAt;
      delete payload.owner;

      let saved: PaycheckRecord | null = null;
      if (panel?.kind === "edit") {
        const { data } = await client.models.financePaycheck.update({
          ...payload,
          id: panel.rec.id,
        });
        saved = data ?? null;
      } else {
        const { data } = await client.models.financePaycheck.create(payload);
        saved = data ?? null;
      }

      // Persist the staged PDF as an attachment row. Reuses the polymorphic
      // attachment model so future "show original PDF" flows work the same
      // way as transaction / loan attachments.
      if (saved && draft.pendingAttachment) {
        await client.models.attachment.create({
          parentType:  "PAYCHECK" as any,
          parentId:    saved.id,
          s3Key:       draft.pendingAttachment.s3Key,
          filename:    draft.pendingAttachment.filename,
          contentType: draft.pendingAttachment.contentType,
          sizeBytes:   draft.pendingAttachment.sizeBytes,
        });
      }

      await fetchData();
      closePanel();
    } catch (err) {
      console.error("[paychecks] save failed", err);
      alert(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [draft, panel, fetchData, closePanel]);

  const handleDelete = useCallback(async () => {
    if (panel?.kind !== "edit") return;
    if (!confirm(`Delete paycheck for ${fmtDate(panel.rec.payDate)}?`)) return;
    setSaving(true);
    try {
      // Remove attachment rows so the list stays consistent. The S3 file
      // itself is left in place — orphan-cleanup is a separate concern.
      const atts = attachmentsById.get(panel.rec.id) ?? [];
      await Promise.all(atts.map((a) =>
        client.models.attachment.delete({ id: a.id }),
      ));
      await client.models.financePaycheck.delete({ id: panel.rec.id });
      await fetchData();
      closePanel();
    } finally {
      setSaving(false);
    }
  }, [panel, attachmentsById, fetchData, closePanel]);

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="flex h-full">
        <div className="flex-1 px-4 py-5 md:px-6 overflow-auto">

          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
            <span>›</span>
            <span>Paychecks</span>
          </div>

          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100">Paychecks</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                Drop a PDF — Claude extracts the fields, you review and save. Or enter manually.
              </p>
            </div>
            <button
              onClick={openNew}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-90"
              style={{ backgroundColor: FINANCE_COLOR, color: "#fff" }}
            >
              + Add paycheck
            </button>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-gray-400 uppercase tracking-widest mr-1">Person:</span>
              <FilterPill active={filterPerson === "ALL"} onClick={() => setFilterPerson("ALL")}>All</FilterPill>
              {PAYCHECK_PERSONS.map((p) => (
                <FilterPill key={p} active={filterPerson === p} onClick={() => setFilterPerson(p)}>
                  {PAYCHECK_PERSON_LABELS[p]}
                </FilterPill>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-gray-400 uppercase tracking-widest mr-1">Year:</span>
              <FilterPill active={filterYear === "ALL"} onClick={() => setFilterYear("ALL")}>All</FilterPill>
              {availableYears.map((y) => (
                <FilterPill key={y} active={filterYear === y} onClick={() => setFilterYear(y)}>
                  {y}
                </FilterPill>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-gray-400 italic">Loading…</p>
          ) : filtered.length === 0 ? (
            <EmptyState label="paychecks" onAdd={openNew} />
          ) : (
            <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-gray-50 dark:bg-darkElevated">
                  <tr className="text-left text-[10px] uppercase tracking-widest text-gray-400 font-medium">
                    <th className="px-3 py-2">Pay date</th>
                    <th className="px-3 py-2">Person</th>
                    <th className="px-3 py-2 text-right">Gross</th>
                    <th className="px-3 py-2 text-right">Net</th>
                    <th className="px-3 py-2 text-right">Fed WH</th>
                    <th className="px-3 py-2 text-right">401k</th>
                    <th className="px-3 py-2 text-right">YTD Gross</th>
                    <th className="px-3 py-2 text-center">PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {filtered.map((p) => {
                    const atts = attachmentsById.get(p.id) ?? [];
                    return (
                      <tr
                        key={p.id}
                        onClick={() => openEdit(p)}
                        className="cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5"
                      >
                        <td className="px-3 py-2 tabular-nums text-gray-700 dark:text-gray-200">{fmtDate(p.payDate)}</td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{PAYCHECK_PERSON_LABELS[p.person as PaycheckPerson]}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(p.gross ?? 0)}</td>
                        <td className="px-3 py-2 text-right tabular-nums" style={{ color: amountColor(p.net ?? 0) }}>
                          {fmtCurrency(p.net ?? 0)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{p.fedWh != null ? fmtCurrency(p.fedWh) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{p.contrib401k != null ? fmtCurrency(p.contrib401k) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">{p.ytdGross != null ? fmtCurrency(p.ytdGross) : "—"}</td>
                        <td className="px-3 py-2 text-center text-xs">{atts.length > 0 ? "📎" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Side panel */}
        {panel && (
          <aside className="w-full md:w-[28rem] border-l border-gray-200 dark:border-darkBorder bg-white dark:bg-darkSurface overflow-y-auto flex-shrink-0">
            <div className="p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">
                  {panel.kind === "edit" ? "Edit paycheck" : "New paycheck"}
                </h2>
                <button onClick={closePanel} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg">×</button>
              </div>

              {/* Upload PDF (only for new paychecks) */}
              {panel.kind === "new" && (
                <div className="mb-4 rounded-lg border border-dashed border-gray-300 dark:border-darkBorder p-3">
                  <p className="text-[11px] uppercase tracking-widest text-gray-400 font-medium mb-2">Upload PDF</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={onFileChosen}
                    className="hidden"
                  />
                  <button
                    onClick={onPickFile}
                    disabled={parseStatus === "uploading" || parseStatus === "parsing"}
                    className="w-full py-1.5 rounded-lg text-xs font-semibold border transition-colors hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                    style={{ borderColor: FINANCE_COLOR + "88", color: FINANCE_COLOR }}
                  >
                    {parseStatus === "uploading" ? "Uploading…" :
                     parseStatus === "parsing"   ? "Extracting fields…" :
                     "Pick a paystub PDF"}
                  </button>
                  {draft.pendingAttachment && parseStatus === "idle" && (
                    <p className="text-[10px] text-gray-400 mt-2 truncate" title={draft.pendingAttachment.filename}>
                      ✓ {draft.pendingAttachment.filename} — review fields below
                    </p>
                  )}
                  {parseError && (
                    <p className="text-[10px] text-red-500 mt-2">{parseError}</p>
                  )}
                </div>
              )}

              {/* Person + dates */}
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className={labelCls}>Person</label>
                  <select
                    value={(draft.person as string) ?? "ME"}
                    onChange={(e) => setDraft((d) => ({ ...d, person: e.target.value as any }))}
                    className={inputCls}
                  >
                    {PAYCHECK_PERSONS.map((p) => (
                      <option key={p} value={p}>{PAYCHECK_PERSON_LABELS[p]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Pay date</label>
                  <input
                    type="date"
                    value={draft.payDate ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, payDate: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Period start</label>
                  <input
                    type="date"
                    value={draft.periodStart ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, periodStart: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Period end</label>
                  <input
                    type="date"
                    value={draft.periodEnd ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, periodEnd: e.target.value }))}
                    className={inputCls}
                  />
                </div>
              </div>

              {/* Numeric field groups */}
              {NUMERIC_FIELD_GROUPS.map((g) => (
                <div key={g.heading} className="mb-3">
                  <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2">{g.heading}</p>
                  <div className="grid grid-cols-2 gap-3">
                    {g.fields.map((f) => (
                      <div key={f}>
                        <label className={labelCls}>{FIELD_LABELS[f]}</label>
                        <input
                          type="number"
                          step="0.01"
                          value={(draft as any)[f] ?? ""}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setDraft((d) => ({ ...d, [f]: raw === "" ? null : Number(raw) }));
                          }}
                          className={inputCls}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Line items */}
              <div className="mb-3">
                <p className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2">Line items</p>
                <LineItemsEditor
                  items={(draft.lineItems as PaycheckLineItem[] | null) ?? []}
                  onChange={(items) => setDraft((d) => ({ ...d, lineItems: items }))}
                />
              </div>

              {/* Notes */}
              <div className="mb-4">
                <label className={labelCls}>Notes</label>
                <textarea
                  rows={2}
                  value={draft.notes ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  className={inputCls}
                />
              </div>

              <SaveButton saving={saving} onSave={handleSave} />
              {panel.kind === "edit" && (
                <div className="mt-2">
                  <DeleteButton saving={saving} onDelete={handleDelete} />
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </FinanceLayout>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────

function FilterPill({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-0.5 rounded-full transition-colors"
      style={{
        backgroundColor: active ? FINANCE_COLOR + "22" : "transparent",
        color:           active ? FINANCE_COLOR : undefined,
        border:          active ? `1px solid ${FINANCE_COLOR}66` : "1px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

function LineItemsEditor({
  items, onChange,
}: { items: PaycheckLineItem[]; onChange: (next: PaycheckLineItem[]) => void }) {
  const add = () => onChange([...items, { name: "", amount: 0, ytd: null, type: "OTHER" }]);
  const update = (i: number, patch: Partial<PaycheckLineItem>) =>
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));

  return (
    <div className="flex flex-col gap-1">
      {items.length === 0 && (
        <p className="text-[11px] text-gray-400 italic">— none —</p>
      )}
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            type="text"
            placeholder="Name"
            value={it.name}
            onChange={(e) => update(i, { name: e.target.value })}
            className="flex-1 bg-transparent border border-gray-200 dark:border-darkBorder rounded px-2 py-1 text-xs"
          />
          <input
            type="number"
            step="0.01"
            placeholder="Amount"
            value={it.amount === 0 ? "" : it.amount}
            onChange={(e) => update(i, { amount: Number(e.target.value || 0) })}
            className="w-20 bg-transparent border border-gray-200 dark:border-darkBorder rounded px-1 py-1 text-xs text-right tabular-nums"
          />
          <select
            value={it.type}
            onChange={(e) => update(i, { type: e.target.value as PaycheckLineItem["type"] })}
            className="bg-transparent border border-gray-200 dark:border-darkBorder rounded px-1 py-1 text-[10px]"
          >
            <option value="PRETAX">Pretax</option>
            <option value="POSTTAX">Posttax</option>
            <option value="IMPUTED">Imputed</option>
            <option value="EMPLOYER_PAID">Employer</option>
            <option value="EARNING">Earning</option>
            <option value="OTHER">Other</option>
          </select>
          <button
            onClick={() => remove(i)}
            className="text-xs text-gray-400 hover:text-red-500 px-1"
            title="Remove"
          >×</button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors mt-1"
      >
        + Add line item
      </button>
    </div>
  );
}

// ── Coercion helpers for AI-extracted JSON ───────────────────────────────

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function numericField(raw: Record<string, unknown>, key: string): number | null {
  const v = raw[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceLineItems(v: unknown): PaycheckLineItem[] {
  if (!Array.isArray(v)) return [];
  const out: PaycheckLineItem[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name   = typeof obj.name   === "string" ? obj.name   : "";
    const amount = numericField(obj, "amount") ?? 0;
    const ytd    = numericField(obj, "ytd");
    const type   = typeof obj.type   === "string" ? (obj.type as PaycheckLineItem["type"]) : "OTHER";
    if (!name && amount === 0) continue;
    out.push({ name, amount, ytd, type });
  }
  return out;
}
