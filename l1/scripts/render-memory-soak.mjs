#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const launcher = resolve(repoRoot, "l1/scripts/render-private-testnet.mjs");
const HARD_RSS_BYTES = 430 * 1024 * 1024;
const MAX_GROWTH_BYTES = 128 * 1024 * 1024;

async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  await new Promise((ok) => server.close(ok)); return address.port;
}
async function status(base) {
  const r = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`status HTTP ${r.status}`); return r.json();
}
async function waitHeight(base, height, timeout=180000) {
  const end=Date.now()+timeout; let last;
  while(Date.now()<end){ try { last=await status(base); if(last.minHeight>=height && last.nodes?.every(n=>n.processAlive)) return last; } catch {} await new Promise(r=>setTimeout(r,1000)); }
  throw new Error(`height ${height} timeout: ${JSON.stringify(last)}`);
}
async function treeRss(rootPid) {
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss="]);
  const rows=stdout.trim().split(/\n+/).map(line=>line.trim().split(/\s+/).map(Number));
  const children=new Map(); for(const [pid,ppid,rss] of rows){ const a=children.get(ppid)||[]; a.push([pid,rss]); children.set(ppid,a); }
  let total=0, count=0; const stack=[rootPid]; const seen=new Set();
  while(stack.length){ const pid=stack.pop(); if(seen.has(pid)) continue; seen.add(pid); const row=rows.find(r=>r[0]===pid); if(row){ total+=row[2]*1024; count++; } for(const [child] of children.get(pid)||[]) stack.push(child); }
  return { bytes: total, processes: count };
}
const port=await freePort(); const base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[launcher],{cwd:repoRoot,env:{...process.env,PORT:String(port),ZYRON_TESTNET_CHAIN_ID:`zyron-memory-soak-${process.pid}`},stdio:["ignore","pipe","pipe"]});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
async function stop(){ if(child.exitCode!==null||child.signalCode!==null)return; const done=new Promise(r=>child.once("exit",r)); child.kill("SIGTERM"); await Promise.race([done,new Promise(r=>setTimeout(r,10000))]); if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL"); }
try {
  await waitHeight(base,2); const baseline=await treeRss(child.pid); const samples=[{height:2,...baseline}];
  let next=3; while(next<=6){ const s=await waitHeight(base,next); const rss=await treeRss(child.pid); samples.push({height:s.minHeight,...rss}); assert.ok(rss.bytes < HARD_RSS_BYTES,`RSS exceeded hard budget: ${rss.bytes}`); next=s.minHeight+1; }
  const peak=Math.max(...samples.map(s=>s.bytes)); const final=samples.at(-1).bytes; const growth=final-baseline.bytes;
  assert.ok(growth < MAX_GROWTH_BYTES,`RSS growth exceeded budget: ${growth}`);
  const finalStatus=await status(base); assert.equal(finalStatus.converged,true); assert.equal(finalStatus.publicTestnetAuthorized,false); assert.equal(finalStatus.mainnetAuthorized,false);
  console.log(JSON.stringify({status:"ok",scenario:"render-four-validator-memory-soak",samples,baselineBytes:baseline.bytes,peakBytes:peak,finalBytes:final,growthBytes:growth,hardBudgetBytes:HARD_RSS_BYTES,maxGrowthBytes:MAX_GROWTH_BYTES,finalHeight:finalStatus.minHeight,validatorsAlive:true},null,2));
} finally { await stop(); }
