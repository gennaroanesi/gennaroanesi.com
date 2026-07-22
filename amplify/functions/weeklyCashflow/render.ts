/**
 * render.ts — pure email rendering for the weekly cashflow briefing.
 * No AWS/env, so it can be unit-tested with an engine result + accounts.
 */
import type { Account, CashflowResult } from "./engine";

const SITE = "https://gennaroanesi.com";

const money = (n: number) => {
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n < 0 ? `−${s}` : s;
};
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export function buildEmail(res: CashflowResult, accounts: Account[]): { subject: string; text: string; html: string } {
  const acctUrl = (id: string) => `${SITE}/finance/accounts/${id}`;
  const cardId = (name: string) => accounts.find((a) => a.name === name)?.id;
  const dateRange = `${res.todayIso} → ${res.horizonIso}`;
  const subject = `💸 Weekly cashflow — ${res.todayIso}${res.salaryWeek ? " (salary week)" : ""}`;

  // ── plain text ──
  const T: string[] = [];
  T.push(`WEEKLY CASHFLOW  ${dateRange}`);
  T.push(res.salaryWeek ? "✅ Salary week — paycheck lands in this window." : "— No salary this window.");
  if (res.moves.length) { T.push(`\n⚠️ ACTION NEEDED:`); res.moves.forEach((m) => T.push(`  • ${m}`)); }
  T.push(`\nBALANCES`);
  res.balances.checking.forEach((c) => T.push(`  ${c.name}: ${money(c.balance)} (checking)`));
  res.balances.savings.forEach((c) => T.push(`  ${c.name}: ${money(c.balance)} (savings)`));
  res.balances.cards.forEach((c) => T.push(`  ${c.name}: ${money(-c.owed)} owed${c.utilization != null ? ` · ${(c.utilization * 100).toFixed(0)}% util` : ""}${c.apr != null ? ` · ${(c.apr * 100).toFixed(1)}% APR` : ""}`));
  T.push(`\nCHECKING OUTLOOK (next ${daysBetween(res.todayIso, res.horizonIso)} days)`);
  res.projections.forEach((p) => T.push(`  ${p.name}: ${money(p.start)} → low ${money(p.minBalance)} on ${p.minDate} → ${money(p.end)} at horizon`));
  if (res.incomeEvents.length) { T.push(`\nINCOME`); res.incomeEvents.forEach((e) => T.push(`  ${e.date}  +${money(e.amount).replace("−", "")}  ${e.description}`)); }
  T.push(`\nBILLS DUE (next 2 weeks)`);
  res.bills.forEach((b) => T.push(`  ${b.date}  ${money(b.amount)}  ${b.onCard ? "[card]" : "[cash]"}  ${b.description}`));
  if (res.statementsDue.length) { T.push(`\nCARD STATEMENTS DUE`); res.statementsDue.forEach((s) => T.push(`  ${s.card}: ~${money(s.approxAmount)} due ${s.dueDate}`)); }
  T.push(`\nWHAT TO DO WITH LEFTOVER CASH (buffer ${money(res.buffer)})`);
  if (res.actions.length) {
    T.push(`  Surplus above buffer: ${money(res.surplus)}`);
    res.actions.forEach((a) => T.push(`  • Pay ${money(a.amount)} on ${a.card}  (${a.reason})`));
  } else {
    T.push(`  No surplus to sweep this window${res.surplus <= 0 && res.moves.length ? " — cover the shortfall above first." : "."}`);
  }
  T.push(`\n${SITE}/finance`);

  // ── html ──
  const H: string[] = [];
  const h2 = (t: string) => `<h2 style="font-size:15px;margin:20px 0 8px;color:#1e2d4a;border-bottom:1px solid #eee;padding-bottom:4px">${t}</h2>`;
  const li = (s: string) => `<li style="margin:3px 0">${s}</li>`;
  H.push(`<div style="font-family:-apple-system,sans-serif;font-size:14px;line-height:1.55;color:#333;max-width:640px">`);
  H.push(`<h1 style="font-size:18px;color:#1e2d4a;margin:0 0 4px">💸 Weekly Cashflow</h1>`);
  H.push(`<div style="color:#888;font-size:13px">${dateRange}</div>`);
  H.push(`<div style="margin-top:8px;font-weight:600;color:${res.salaryWeek ? "#1a7f37" : "#666"}">${res.salaryWeek ? "✅ Salary week — paycheck lands in this window" : "— No salary this window"}</div>`);
  if (res.moves.length) {
    H.push(`<div style="margin-top:14px;padding:12px 14px;background:#fff4f4;border-left:4px solid #d64545;border-radius:4px">`);
    H.push(`<strong style="color:#b02a2a">⚠️ Action needed</strong><ul style="margin:6px 0 0;padding-left:18px">${res.moves.map(li).join("")}</ul></div>`);
  }
  H.push(h2("Balances"));
  H.push(`<ul style="margin:0;padding-left:18px;list-style:none">`);
  res.balances.checking.forEach((c) => H.push(li(`<a href="${acctUrl(c.id)}" style="color:#1e2d4a">${c.name}</a>: <strong>${money(c.balance)}</strong> <span style="color:#999">checking</span>`)));
  res.balances.savings.forEach((c) => H.push(li(`<a href="${acctUrl(c.id)}" style="color:#1e2d4a">${c.name}</a>: ${money(c.balance)} <span style="color:#999">savings</span>`)));
  res.balances.cards.forEach((c) => H.push(li(`<a href="${acctUrl(c.id)}" style="color:#1e2d4a">${c.name}</a>: <span style="color:#b02a2a">${money(-c.owed)}</span>${c.utilization != null ? ` <span style="color:#999">· ${(c.utilization * 100).toFixed(0)}% util</span>` : ""}${c.apr != null ? ` <span style="color:#999">· ${(c.apr * 100).toFixed(1)}% APR</span>` : ""}`)));
  H.push(`</ul>`);
  H.push(h2("Checking outlook"));
  H.push(`<ul style="margin:0;padding-left:18px;list-style:none">`);
  res.projections.forEach((p) => H.push(li(`${p.name}: ${money(p.start)} → <strong style="color:${p.minBalance < 0 ? "#b02a2a" : p.minBalance < res.buffer ? "#c47d00" : "#1a7f37"}">low ${money(p.minBalance)}</strong> on ${p.minDate} → ${money(p.end)} at horizon`)));
  H.push(`</ul>`);
  if (res.incomeEvents.length) { H.push(h2("Income")); H.push(`<ul style="margin:0;padding-left:18px">${res.incomeEvents.map((e) => li(`${e.date} &nbsp; <strong style="color:#1a7f37">+${money(e.amount).replace("−", "")}</strong> &nbsp; ${e.description}`)).join("")}</ul>`); }
  H.push(h2("Bills due (next 2 weeks)"));
  H.push(`<table style="border-collapse:collapse;width:100%;font-size:13px"><tbody>`);
  res.bills.forEach((b) => H.push(`<tr><td style="padding:2px 8px 2px 0;color:#666;white-space:nowrap">${b.date}</td><td style="padding:2px 8px;text-align:right;color:#b02a2a;white-space:nowrap">${money(b.amount)}</td><td style="padding:2px 6px"><span style="font-size:11px;color:#999">${b.onCard ? "card" : "cash"}</span></td><td style="padding:2px 0">${b.description}</td></tr>`));
  H.push(`</tbody></table>`);
  if (res.statementsDue.length) {
    H.push(h2("Card statements due"));
    H.push(`<ul style="margin:0;padding-left:18px">${res.statementsDue.map((s) => { const id = cardId(s.card); const nm = id ? `<a href="${acctUrl(id)}" style="color:#1e2d4a">${s.card}</a>` : s.card; return li(`${nm}: ~<strong>${money(s.approxAmount)}</strong> due ${s.dueDate}`); }).join("")}</ul>`);
  }
  H.push(h2(`What to do with leftover cash <span style="font-weight:400;color:#999;font-size:12px">(buffer ${money(res.buffer)})</span>`));
  if (res.actions.length) {
    H.push(`<div style="color:#666">Surplus above buffer: <strong>${money(res.surplus)}</strong></div>`);
    H.push(`<ul style="margin:6px 0 0;padding-left:18px">${res.actions.map((a) => { const id = cardId(a.card); const nm = id ? `<a href="${acctUrl(id)}" style="color:#1e2d4a">${a.card}</a>` : a.card; return li(`Pay <strong>${money(a.amount)}</strong> on ${nm} <span style="color:#999">(${a.reason})</span>`); }).join("")}</ul>`);
  } else {
    H.push(`<div style="color:#666">No surplus to sweep this window${res.surplus <= 0 && res.moves.length ? " — cover the shortfall above first." : "."}</div>`);
  }
  H.push(`<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;font-size:12px">`);
  H.push(`<a href="${SITE}/finance" style="color:#d4a843;margin-right:14px">Dashboard</a>`);
  H.push(`<a href="${SITE}/finance/transactions" style="color:#d4a843;margin-right:14px">Transactions</a>`);
  H.push(`<a href="${SITE}/finance/review" style="color:#d4a843">Review</a></div>`);
  H.push(`</div>`);

  return { subject, text: T.join("\n"), html: H.join("") };
}
