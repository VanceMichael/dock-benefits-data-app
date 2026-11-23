// 季度会分析入口：node tools/analyze.mjs [资料目录] [输出目录]
// 默认读 fixtures/，写到 outputs/baseline/。

import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runPipeline } from '../src/pipeline.mjs';

const sourceArg = process.argv[2] ?? 'fixtures';
const outputArg = process.argv[3] ?? 'outputs/baseline';
const source = new URL(`../${sourceArg.replace(/\/+$/, '')}/`, import.meta.url);
const output = new URL(`../${outputArg.replace(/\/+$/, '')}/`, import.meta.url);

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const result = await runPipeline(source);

await mkdir(output, { recursive: true });
const files = {
  'caliber.json': result.caliber,
  'roster.json': result.roster,
  'transactions-canonical.json': result.transactions,
  'spillover.json': result.spillover,
  'panel.json': result.panel,
  'causal.json': result.causal,
  'household-loss.json': result.householdLoss,
  'allocation.json': result.allocation,
  'published.json': result.published,
};
for (const [name, data] of Object.entries(files)) {
  await writeFile(new URL(name, output), `${JSON.stringify(data, null, 2)}\n`);
}
await writeFile(
  new URL('run-manifest.json', output),
  `${JSON.stringify({ runId, source: source.href, files: Object.keys(files), caliberGeneratedAt: result.caliber.generatedAt }, null, 2)}\n`);

const did = result.causal.did;
const fund = result.allocation.fundLedger;
console.log(JSON.stringify({
  runId,
  规范化: result.transactions.quality,
  待核凭证: result.transactions.review.map(r => r.receipt),
  分流污染港: result.spillover.filter(s => s.spilloverEvidence).map(s => s.port),
  干净对照港: result.spillover.filter(s => s.cleanControl).map(s => s.port),
  DiD: did.did,
  自助区间: did.bootstrap.ci,
  证据等级: did.evidence.grade,
  安慰剂DiD: did.placeboDid,
  基金占用: fund,
  发布对账: result.published.reconciliation.programTotalMatches,
  桶级对账: result.published.reconciliation.bucketDetailMatches,
  输出目录: outputArg,
}, null, 2));
