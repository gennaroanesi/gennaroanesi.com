/**
 * amazon_itemize.mjs
 *
 * Populate financeTransaction.lineItems from an Amazon "Request My Data"
 * order export, so opaque `AMAZON MKTPL*…` charges break down into real
 * categories instead of a single "Amazon" bucket.
 *
 * Usage:
 *   npm run amz:itemize                    # dry-run: match report, no writes
 *   npm run amz:itemize -- --apply         # write lineItems onto matched txs
 *   npm run amz:itemize -- --csv="path/to/Order History.csv"
 *   npm run amz:itemize -- --from=2026-01-01 --to=2026-05-10
 *   npm run amz:itemize -- --unmatched     # also list unmatched shipments/charges
 *
 * Auth: COGNITO_USER + COGNITO_PASSWORD (.env.local, via --env-file).
 *
 * How matching works:
 *   Amazon charges the card per SHIPMENT, not per order, so items are grouped
 *   by (Order ID, Ship Date) and their `Total Amount` (unit + tax − discount,
 *   already per-item) summed to get the expected charge. Each shipment is then
 *   matched to an Amazon transaction with the same absolute amount (±$0.02)
 *   whose date falls within a window around the ship date — charges post at
 *   ship time, occasionally a few days later. Matching is greedy nearest-date
 *   and one-to-one, so two same-priced shipments can't claim the same charge.
 *   Anything ambiguous is left UNMATCHED rather than guessed into a bucket.
 *
 * Categories come from PRODUCT_CATEGORY_RULES below (Amazon dropped the
 * category column from newer exports, so we classify on product name).
 */
import { readFileSync } from "fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

// ── Args ──────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
const APPLY      = args.apply === "true";
const SHOW_UNMAT = args.unmatched === "true";
const CSV_PATH   = args.csv ?? "./scripts/data/Your Orders/Your Amazon Orders/Order History.csv";
const FROM       = args.from ?? "2026-01-01";
const TO         = args.to   ?? "2026-12-31";
const AMOUNT_TOL = 0.02;
const DAYS_BEFORE = 2;   // charge can post slightly before recorded ship date
const DAYS_AFTER  = 6;

// ── Product-name → category classifier ────────────────────────────────────────
// Ordered, first match wins. Buckets intentionally reuse the existing finance
// vocabulary (see components/finance/category-rules.json) so the Review page
// groups item spend alongside everything else.
const PRODUCT_CATEGORY_RULES = [
  // Pets first — unambiguous brand/noun signals.
  [/\b(dog|puppy|\bcat\b|\bpet\b|kong|chew toy|leash|litter|kibble|chewy)\b/i,           "Dolce"],
  // Medical before Health: post-surgery/durable-medical gear reads as generic
  // "health" otherwise (shower chair, cold therapy, cast padding, sterile pads).
  [/\b(sterile|non-adherent|gauze|cast padding|wound|shower chair|cold therapy|ice machine|pill organizer|crutch|\bbrace\b|orthopedic|post[- ]surgery|leg lifter|hip replacement|knee surgery|blood pressure|thermometer|nebulizer|compression sleeve)\b/i, "Medical"],
  // Eyewear before Electronics so "Eyeglass Lens Cleaner" isn't caught by \blens\b.
  [/\b(eyeglass|eyewear|sunglasses|spectacle)\b/i,                                        "Health"],
  // Food before Health so "Moon Cheese … Protein" and "Ribeye Steak" don't get
  // pulled into supplements by the word "protein".
  [/\b(beef|steak|ribeye|sirloin|chicken|pork|salmon|cheese|snack|granola|cereal|protein bar|olive oil|spice|sauce|pasta|\brice\b|flour|sugar|honey|nuts|almond|jerky|coffee bean|ground coffee|\btea\b|soda|grocery|\bfood\b|oz\)?\s*$)/i, "Groceries"],
  [/\b(vitamin|multivitamin|supplement|ashwagandha|creatine|magnesium|melatonin|probiotic|whey|ibuprofen|advil|tylenol|bandage|first aid|toothpaste|toothbrush|floss|shampoo|conditioner|hair fiber|styling|razor|shave|deodorant|sunscreen|lotion|serum|skincare)\b/i, "Health"],
  // Prepping / outdoor survival — the user's existing SHTF bucket.
  [/(\b(survival|emergency blanket|mylar blanket|space blanket|stormproof|waterproof match|match kit|match case|paracord|tarp|balaclava|respirator|\bn95\b|tourniquet|\bifak\b|firestarter|fire starter|desiccant|silica gel|molle|ammo|ammunition|holster|optic|scope|rifle|pistol|firearm|range bag|camping|\bsawyer\b|glow stick|chemlight|cyalume)\b|hydration bladder|water filt)/i, "SHTF"],
  [/\b(ski\b|skis\b|snowboard|binding|goggles|helmet strap|chairlift)\b/i,               "Ski"],
  [/\b(cable|charger|usb|hdmi|adapter|battery|batteries|\bssd\b|hard drive|memory card|sd card|router|wifi|zigbee|sonoff|smart sensor|smart plug|keyboard|mouse\b|monitor|webcam|headphone|earbud|speaker|microphone|laptop|tablet|ipad|kindle|echo\b|fire tv|camera|\blens\b|tripod|gimbal|drone|logitech|anker|thunderbolt|screen protector|powerbank|power bank|electronic)\b/i, "Electronics"],
  [/\b(paper towel|toilet paper|charmin|brawny|detergent|fabric softener|laundry|dish soap|trash bag|cleaner|clorox|lysol|mrs\.? meyer|sponge|swiffer|air filter|light bulb|led bulb|\bhue\b|thermostat|vacuum|furniture|shelf|shelving|storage bin|curtain|\brug\b|pillow|mattress|bedding|sheet set|grill cover|smoker|insect control|pest|bifenthrin|lawn|garden|kitchen|cookware|\bpan\b|\bpot\b|blender|air fryer|breville|coffee maker|espresso|bottles? with|glass bottles|dropper|funnel)\b/i, "Home"],
  [/\b(shirt|pant|jean|shorts?\b|sock|jacket|coat|hoodie|sweater|dress\b|shoe|sneaker|boot|belt\b|underwear|beanie|\bhats?\b|baseball cap|\bcaps?\b|glove|scarf|levi|nike|adidas|under armour|apparel|clothing)\b/i, "Apparel"],
  [/\b(book|paperback|hardcover|novel|kindle edition)\b/i,                               "Books"],
  [/\b(drill|wrench|screwdriver|hammer|\bsaw\b|utility knife|milwaukee|tool kit|toolbox|socket set|tape measure|hardware|screw|bolt|\bnail\b|adhesive|glue|duct tape|acrylic sheet|plexiglass|\bblade\b)\b/i, "Tools"],
  [/\b(tire|motor oil|wiper|automotive|windshield|jack stand)\b/i,                       "Car"],
  [/\b(guitar|\bstring|\bamp\b|\bpedal\b|capo)\b/i,                                      "Guitar"],
  [/\b(aviation|pilot|kneeboard|sectional chart|foreflight)\b/i,                          "Flying"],
  [/\b(sim card|prepaid|phone plan|tello)\b/i,                                            "Utilities"],
  [/\b(\bpen\b|notebook|printer|\bink\b|toner|stapler|folder|envelope|\bdesk\b|office)\b/i, "Office"],
];
function categorizeProduct(name) {
  const n = (name ?? "").trim();
  if (!n) return null;
  for (const [rx, cat] of PRODUCT_CATEGORY_RULES) if (rx.test(n)) return cat;
  return null;
}

// ── CSV (RFC4180-ish) ─────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n") { row.push(cur); cur = ""; rows.push(row); row = []; }
    else if (c !== "\r") cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/['"]/g, "")); return Number.isFinite(n) ? n : 0; };
const day = (iso) => (iso ?? "").slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);
const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── AppSync ───────────────────────────────────────────────────────────────────
const o = JSON.parse(readFileSync("./amplify_outputs.json", "utf8"));
let JWT;
async function getJwt() {
  const c = new CognitoIdentityProviderClient({ region: o.auth.aws_region });
  const r = await c.send(new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: o.auth.user_pool_client_id,
    AuthParameters: { USERNAME: process.env.COGNITO_USER, PASSWORD: process.env.COGNITO_PASSWORD },
  }));
  if (!r.AuthenticationResult?.IdToken) throw new Error("Auth failed: " + r.ChallengeName);
  return r.AuthenticationResult.IdToken;
}
async function gql(query, variables = {}) {
  const r = await fetch(o.data.url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: JWT },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}
const LIST_TX = `query($from:String!,$to:String!,$next:String){listFinanceTransactions(filter:{and:[{date:{ge:$from}},{date:{le:$to}}]},limit:1000,nextToken:$next){items{id accountId amount description date category} nextToken}}`;
const UPDATE  = `mutation($input:UpdateFinanceTransactionInput!){updateFinanceTransaction(input:$input){id}}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Amazon itemizer — ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
  console.log(`CSV:    ${CSV_PATH}`);
  console.log(`Window: ${FROM} → ${TO}\n`);

  // 1. Parse export → shipments
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8")).filter((r) => r.length > 1);
  const hdr  = rows[0].map((h) => h.trim());
  const recs = rows.slice(1).map((r) => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? "").trim()])));

  const inWindow = recs.filter((r) => {
    const d = day(r["Order Date"]);
    return d >= FROM && d <= TO && (r["Order Status"] ?? "").toLowerCase() !== "cancelled";
  });

  // Amazon bills per shipment → group by (Order ID, Ship Date).
  const shipments = new Map();
  for (const r of inWindow) {
    const shipDay = day(r["Ship Date"]) || day(r["Order Date"]);
    const key = `${r["Order ID"]}|${shipDay}`;
    const s = shipments.get(key) ?? {
      orderId: r["Order ID"], shipDay, orderDay: day(r["Order Date"]),
      card: r["Payment Method Type"] ?? "", items: [], total: 0,
    };
    const amt = num(r["Total Amount"]);
    s.items.push({
      name: (r["Product Name"] ?? "").slice(0, 120),
      amount: Math.round(amt * 100) / 100,
      quantity: num(r["Original Quantity"]) || 1,
      category: categorizeProduct(r["Product Name"]),
    });
    s.total = Math.round((s.total + amt) * 100) / 100;
    shipments.set(key, s);
  }
  const shipList = [...shipments.values()].filter((s) => s.total > 0);
  console.log(`Export: ${inWindow.length} item rows in window → ${shipList.length} shipments, ${money(shipList.reduce((a, s) => a + s.total, 0))}`);

  // 2. Amazon charges from the ledger
  JWT = await getJwt();
  const txs = [];
  let next = null;
  do {
    const d = await gql(LIST_TX, { from: FROM, to: TO, next });
    txs.push(...d.listFinanceTransactions.items); next = d.listFinanceTransactions.nextToken;
  } while (next);
  const charges = txs.filter((t) => /amazon|amzn/i.test(t.description ?? "") && (t.amount ?? 0) < 0);
  console.log(`Ledger: ${charges.length} Amazon charges, ${money(charges.reduce((a, t) => a + t.amount, 0))}\n`);

  // 3. Greedy one-to-one match: amount within tolerance, date near ship date,
  //    nearest date wins. Ambiguity is left unmatched, never guessed.
  const usedTx = new Set();
  const matches = [];
  const unmatchedShipments = [];
  const ordered = [...shipList].sort((a, b) => a.shipDay.localeCompare(b.shipDay));
  for (const s of ordered) {
    const cands = charges
      .filter((t) => !usedTx.has(t.id))
      .filter((t) => Math.abs(Math.abs(t.amount) - s.total) <= AMOUNT_TOL)
      .map((t) => ({ t, gap: daysBetween(t.date, s.shipDay) }))
      .filter(({ gap }) => gap >= -DAYS_BEFORE && gap <= DAYS_AFTER)
      .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
    if (cands.length === 0) { unmatchedShipments.push(s); continue; }
    const { t } = cands[0];
    usedTx.add(t.id);
    matches.push({ shipment: s, tx: t });
  }

  // Pass 2 — order-level fallback. Amazon sometimes bills an entire order as a
  // single charge instead of one per shipment, so a multi-shipment order looks
  // unmatched at shipment level while a charge equal to the ORDER total sits
  // unclaimed. Only applied when none of the order's shipments matched in pass 1,
  // so we can't double-claim; items from all its shipments are merged.
  const stillUnmatched = [...unmatchedShipments];
  unmatchedShipments.length = 0;
  const byOrder = new Map();
  for (const s of stillUnmatched) {
    const g = byOrder.get(s.orderId) ?? [];
    g.push(s); byOrder.set(s.orderId, g);
  }
  const matchedOrderIds = new Set(matches.map((m) => m.shipment.orderId));
  let orderLevelMatches = 0;
  for (const [orderId, group] of byOrder) {
    if (matchedOrderIds.has(orderId) || group.length < 2) { unmatchedShipments.push(...group); continue; }
    const total = Math.round(group.reduce((a, s) => a + s.total, 0) * 100) / 100;
    const days  = group.map((s) => s.shipDay).sort();
    const cands = charges
      .filter((t) => !usedTx.has(t.id))
      .filter((t) => Math.abs(Math.abs(t.amount) - total) <= AMOUNT_TOL)
      .filter((t) => daysBetween(t.date, days[0]) >= -DAYS_BEFORE
                  && daysBetween(t.date, days[days.length - 1]) <= DAYS_AFTER)
      .sort((a, b) => Math.abs(daysBetween(a.date, days[0])) - Math.abs(daysBetween(b.date, days[0])));
    if (cands.length === 0) { unmatchedShipments.push(...group); continue; }
    const t = cands[0];
    usedTx.add(t.id);
    matches.push({
      shipment: {
        orderId, shipDay: days[0], orderDay: group[0].orderDay, card: group[0].card,
        items: group.flatMap((s) => s.items), total,
      },
      tx: t,
      orderLevel: true,
    });
    orderLevelMatches++;
  }
  if (orderLevelMatches) console.log(`  (order-level fallback recovered ${orderLevelMatches} multi-shipment order(s))`);

  const matchedAmt = matches.reduce((a, m) => a + m.shipment.total, 0);
  console.log(`── MATCH RESULTS ──`);
  console.log(`  Matched:   ${matches.length}/${shipList.length} shipments  (${money(matchedAmt)})`);
  console.log(`  Unmatched shipments: ${unmatchedShipments.length} (${money(unmatchedShipments.reduce((a, s) => a + s.total, 0))})`);
  const unmatchedCharges = charges.filter((t) => !usedTx.has(t.id));
  console.log(`  Unmatched charges:   ${unmatchedCharges.length} (${money(unmatchedCharges.reduce((a, t) => a + t.amount, 0))})`);

  // 4. Category coverage across matched items
  const catTotals = new Map();
  let uncatAmt = 0, uncatCount = 0;
  const uncatNames = [];
  for (const m of matches) for (const it of m.shipment.items) {
    if (it.category) catTotals.set(it.category, (catTotals.get(it.category) ?? 0) + it.amount);
    else { uncatAmt += it.amount; uncatCount++; uncatNames.push(it.name); }
  }
  console.log(`\n── ITEM CATEGORIES (matched shipments) ──`);
  for (const [c, a] of [...catTotals.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${c.padEnd(14)} ${money(a).padStart(11)}`);
  }
  console.log(`  ${"(unclassified)".padEnd(14)} ${money(uncatAmt).padStart(11)}  ${uncatCount} items`);

  if (uncatNames.length) {
    console.log(`\n── UNCLASSIFIED PRODUCT NAMES (first 40) ──`);
    for (const n of uncatNames.slice(0, 40)) console.log(`  · ${n.slice(0, 88)}`);
  }

  console.log(`\n── SAMPLE MATCHES ──`);
  for (const m of matches.slice(0, 8)) {
    console.log(`  ${m.tx.date}  ${money(m.tx.amount).padStart(10)}  ${(m.tx.description ?? "").slice(0, 30).padEnd(30)} ← ${m.shipment.items.length} item(s)`);
    for (const it of m.shipment.items) console.log(`        ${money(-it.amount).padStart(9)}  [${it.category ?? "?"}] ${it.name.slice(0, 56)}`);
  }

  if (SHOW_UNMAT) {
    console.log(`\n── UNMATCHED SHIPMENTS ──`);
    for (const s of unmatchedShipments.slice(0, 30)) {
      console.log(`  ${s.shipDay}  ${money(-s.total).padStart(10)}  order ${s.orderId}  ${s.items.length} item(s)  ${s.card}`);
    }
    console.log(`\n── UNMATCHED AMAZON CHARGES ──`);
    for (const t of unmatchedCharges.slice(0, 30)) {
      console.log(`  ${t.date}  ${money(t.amount).padStart(10)}  ${(t.description ?? "").slice(0, 44)}`);
    }
  }

  if (!APPLY) { console.log(`\nDry-run complete. Re-run with --apply to write lineItems.`); return; }

  // 5. Write. Items with no category inherit the transaction's own category so
  //    the split still sums correctly rather than dropping to Uncategorized.
  console.log(`\nWriting lineItems…`);
  let ok = 0, fail = 0;
  for (const m of matches) {
    const fallback = m.tx.category || "Amazon";
    const payload = m.shipment.items.map((it) => ({
      name: it.name, amount: it.amount, category: it.category ?? fallback, quantity: it.quantity,
    }));
    try {
      await gql(UPDATE, { input: { id: m.tx.id, lineItems: JSON.stringify(payload) } });
      ok++;
      if (ok % 25 === 0) console.log(`  ${ok}/${matches.length}`);
    } catch (e) { console.error(`  ✗ ${m.tx.id}: ${e.message}`); fail++; }
    await sleep(90);
  }
  console.log(`\nDone: ${ok} itemized, ${fail} failed.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
