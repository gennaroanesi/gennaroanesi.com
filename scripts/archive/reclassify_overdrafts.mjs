/**
 * reclassify_overdrafts.mjs — one-off: retype Schwab "overdraft" cash-sweep rows
 * (Brokerage ↔ Investor/Schwab Checking) as TRANSFER/Transfers with a toAccountId
 * cross-ref, instead of the mislabeled Fees/EXPENSE. The two Schwab accounts are
 * each other's counterparty.
 *
 *   node --env-file=.env.local scripts/reclassify_overdrafts.mjs          # dry-run
 *   node --env-file=.env.local scripts/reclassify_overdrafts.mjs --apply
 */
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { getConfig } from "./aws-config.mjs";
const APPLY = process.argv.includes("--apply");
const cfg = getConfig();
let JWT;
const getJwt = async () => { const c = new CognitoIdentityProviderClient({ region: cfg.region }); const r = await c.send(new InitiateAuthCommand({ AuthFlow:"USER_PASSWORD_AUTH", ClientId:cfg.clientId, AuthParameters:{ USERNAME:process.env.COGNITO_USER, PASSWORD:process.env.COGNITO_PASSWORD }})); return r.AuthenticationResult.IdToken; };
const gql = async (q,v={}) => { const j = await (await fetch(cfg.appsyncUrl,{method:"POST",headers:{"Content-Type":"application/json",Authorization:JWT},body:JSON.stringify({query:q,variables:v})})).json(); if(j.errors)throw new Error(JSON.stringify(j.errors)); return j.data; };
const pa = async (q,k,v={}) => { const o=[]; let n=null; do { const d=await gql(q,{...v,n}); o.push(...d[k].items); n=d[k].nextToken; } while(n); return o; };

async function main(){
  console.log(`Overdraft reclassify — ${APPLY?"APPLY":"DRY-RUN"}\n`);
  JWT = await getJwt();
  const accts = (await gql(`query{listFinanceAccounts(limit:500){items{id name type}}}`)).listFinanceAccounts.items;
  const brokerage = accts.find(a => /schwab brok/i.test(a.name));
  const checking  = accts.find(a => /schwab checking|investor checking/i.test(a.name));
  if (!brokerage || !checking) throw new Error(`Missing account: brokerage=${!!brokerage} checking=${!!checking}`);
  const other = { [brokerage.id]: checking, [checking.id]: brokerage };
  let all = [];
  for (const id of [brokerage.id, checking.id]) all = all.concat(await pa(`query($a:ID!,$n:String){listFinanceTransactions(filter:{accountId:{eq:$a}},limit:1000,nextToken:$n){items{id date amount type category description accountId toAccountId} nextToken}}`,"listFinanceTransactions",{a:id}));
  const targets = all.filter(t => /overdraft/i.test(t.description||"") && (t.type !== "TRANSFER" || !t.toAccountId || t.category !== "Transfers"));
  console.log(`Overdraft rows needing fix: ${targets.length}`);
  for (const t of targets) {
    const dest = other[t.accountId];
    console.log(`  ${t.date} ${String(t.amount).padStart(9)}  ${(t.type||"").padEnd(8)}/${(t.category||"-").padEnd(12)} → TRANSFER/Transfers → ${dest.name}   "${(t.description||"").slice(0,30)}"`);
  }
  if (!APPLY) { console.log("\nDry-run. Re-run with --apply."); return; }
  let ok=0;
  for (const t of targets) {
    await gql(`mutation($i:UpdateFinanceTransactionInput!){updateFinanceTransaction(input:$i){id}}`,{i:{id:t.id, type:"TRANSFER", category:"Transfers", toAccountId: other[t.accountId].id}});
    ok++;
  }
  console.log(`\nDone. Updated ${ok}.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
