import React, { useEffect, useState, useCallback, useMemo } from "react";
import type { Schema } from "@/amplify/data/resource";
import { useRequireAuth } from "@/hooks/useRequireAuth";
import NextLink from "next/link";
import FinanceLayout from "@/layouts/finance";
import { PageTitle, PageLoading, PrimaryButton } from "@/components/common/ui";
import {
  client, listAll, inputCls, labelCls, FINANCE_COLOR,
} from "@/components/finance/_shared";
import {
  CATEGORY_RULES, ALL_CATEGORIES, inferCategory, patternMatches,
} from "@/components/finance/categories";
import { mutate, reportError } from "@/components/common/mutate";
import { withAlpha, POSITIVE, WARNING } from "@/lib/colors";

type RuleRecord = Schema["financeCategoryRule"]["type"];

export default function CategoryRulesPage() {
  const { authState } = useRequireAuth();
  const [rules, setRules]     = useState<RuleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [test, setTest]       = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listAll(client.models.financeCategoryRule);
      setRules((rows as RuleRecord[]).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (authState === "authenticated") fetchData(); }, [authState, fetchData]);

  // The active, ordered rule list exactly as the classifier will use it.
  const liveRules = useMemo(
    () => rules.filter((r) => r.active !== false && r.pattern && r.category)
               .map((r) => ({ pattern: r.pattern as string, category: r.category as string })),
    [rules],
  );

  // Live test: which rule catches the typed description, and the resulting category.
  const testResult = useMemo(() => {
    const desc = test.trim();
    if (!desc) return null;
    const cat = inferCategory({ description: desc, type: "EXPENSE" }, liveRules) ?? null;
    // Find the winning rule index (mirrors inferCategory's raw+stripped test).
    const idx = liveRules.findIndex((r) => patternMatches(r.pattern, desc));
    return { cat, idx };
  }, [test, liveRules]);

  const categoryOptions = useMemo(() => {
    const s = new Set<string>(ALL_CATEGORIES);
    for (const r of rules) if (r.category) s.add(r.category);
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [rules]);

  async function patchRule(id: string, patch: Partial<RuleRecord>) {
    setRules((p) => p.map((r) => r.id === id ? { ...r, ...patch } as RuleRecord : r));
    try { await mutate(client.models.financeCategoryRule.update({ id, ...patch } as any)); }
    catch (e) { reportError(e, "Save rule"); fetchData(); }
  }

  async function addRule() {
    const nextOrder = (rules.length ? Math.max(...rules.map((r) => r.sortOrder ?? 0)) : 0) + 1;
    setSaving(true);
    try {
      const rec = await mutate(client.models.financeCategoryRule.create({
        pattern: "", category: categoryOptions[0] ?? "Other", sortOrder: nextOrder, active: true,
      }));
      if (rec) setRules((p) => [...p, rec as RuleRecord]);
    } catch (e) { reportError(e, "Add rule"); } finally { setSaving(false); }
  }

  async function deleteRule(r: RuleRecord) {
    if (!confirm(`Delete rule "${r.pattern}" → ${r.category}?`)) return;
    setRules((p) => p.filter((x) => x.id !== r.id));
    try { await mutate(client.models.financeCategoryRule.delete({ id: r.id })); }
    catch (e) { reportError(e, "Delete rule"); fetchData(); }
  }

  // Swap sortOrder with the adjacent rule (first-match-wins order is what matters).
  async function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= rules.length) return;
    const a = rules[i], b = rules[j];
    const ao = a.sortOrder ?? i, bo = b.sortOrder ?? j;
    const next = [...rules];
    next[i] = { ...a, sortOrder: bo } as RuleRecord;
    next[j] = { ...b, sortOrder: ao } as RuleRecord;
    setRules(next.sort((x, y) => (x.sortOrder ?? 0) - (y.sortOrder ?? 0)));
    try {
      await mutate(client.models.financeCategoryRule.update({ id: a.id, sortOrder: bo } as any));
      await mutate(client.models.financeCategoryRule.update({ id: b.id, sortOrder: ao } as any));
    } catch (e) { reportError(e, "Reorder"); fetchData(); }
  }

  // One-time seed: copy the bundled JSON rules into the DB when the table is empty.
  async function seedFromDefaults() {
    if (!confirm(`Seed ${CATEGORY_RULES.length} default rules into the editor?`)) return;
    setSaving(true);
    try {
      const created: RuleRecord[] = [];
      for (let i = 0; i < CATEGORY_RULES.length; i++) {
        const r = CATEGORY_RULES[i];
        const rec = await mutate(client.models.financeCategoryRule.create({
          pattern: r.pattern, category: r.category, sortOrder: i + 1, active: true,
        }));
        if (rec) created.push(rec as RuleRecord);
      }
      setRules(created.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    } catch (e) { reportError(e, "Seed"); } finally { setSaving(false); }
  }

  if (authState !== "authenticated") return null;

  return (
    <FinanceLayout>
      <div className="px-4 py-5 md:px-6 max-w-3xl">
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
          <NextLink href="/finance" className="hover:underline" style={{ color: FINANCE_COLOR }}>Finance</NextLink>
        </div>
        <div className="flex items-center justify-between mb-1 gap-2">
          <PageTitle>Category Rules</PageTitle>
          <PrimaryButton onClick={addRule} disabled={saving}>+ Add Rule</PrimaryButton>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          First match wins, top to bottom. Pattern is <code>/regex/flags</code> or a plain substring, tested against the
          transaction description. Anything no rule catches falls to the AI classifier at sync time. Changes apply to
          transactions synced <em>after</em> you save.
        </p>

        {/* Test box */}
        <div className="rounded-lg border border-gray-200 dark:border-darkBorder p-3 mb-4 bg-white dark:bg-darkSurface">
          <label className={labelCls}>Test a description</label>
          <input className={inputCls} placeholder="e.g. above and beyondaustin tx via payrix"
            value={test} onChange={(e) => setTest(e.target.value)} />
          {testResult && (
            <p className="text-xs mt-1.5">
              {testResult.cat
                ? <>→ <span className="font-semibold" style={{ color: POSITIVE }}>{testResult.cat}</span>
                    {testResult.idx >= 0 && <span className="text-gray-400"> · rule #{testResult.idx + 1}</span>}</>
                : <span style={{ color: WARNING }}>→ no rule matches — would go to the AI classifier (or Uncategorized)</span>}
            </p>
          )}
        </div>

        {loading ? (
          <PageLoading />
        ) : rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-darkBorder p-6 text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              No rules in the editor yet. Seed the {CATEGORY_RULES.length} built-in defaults to start editing them.
            </p>
            <PrimaryButton onClick={seedFromDefaults} disabled={saving}>
              {saving ? "Seeding…" : `Seed ${CATEGORY_RULES.length} default rules`}
            </PrimaryButton>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 dark:border-darkBorder overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-darkElevated text-[10px] uppercase tracking-widest text-gray-400">
                <tr>
                  <th className="px-2 py-2 w-10 text-left">#</th>
                  <th className="px-2 py-2 text-left">Pattern</th>
                  <th className="px-2 py-2 text-left w-44">Category</th>
                  <th className="px-2 py-2 w-12 text-center">On</th>
                  <th className="px-2 py-2 w-24" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {rules.map((r, i) => (
                  <tr key={r.id} className={r.active === false ? "opacity-50" : ""}>
                    <td className="px-2 py-1.5 text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      <input
                        className={`${inputCls} font-mono text-xs`}
                        defaultValue={r.pattern ?? ""}
                        placeholder="/regex/i or substring"
                        onBlur={(e) => { if (e.target.value !== (r.pattern ?? "")) patchRule(r.id, { pattern: e.target.value } as any); }}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select className={inputCls} value={r.category ?? ""}
                        onChange={(e) => patchRule(r.id, { category: e.target.value } as any)}>
                        {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input type="checkbox" checked={r.active !== false}
                        onChange={(e) => patchRule(r.id, { active: e.target.checked } as any)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => move(i, -1)} disabled={i === 0}
                          className="px-1.5 py-1 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30" title="Move up">↑</button>
                        <button onClick={() => move(i, 1)} disabled={i === rules.length - 1}
                          className="px-1.5 py-1 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30" title="Move down">↓</button>
                        <button onClick={() => deleteRule(r)}
                          className="px-1.5 py-1 rounded text-gray-400 hover:text-red-500" title="Delete">×</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </FinanceLayout>
  );
}
