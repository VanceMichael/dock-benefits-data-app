// 评审补数入口：node tools/review.mjs [补录目录] [输出目录]
// 默认读 fixtures-review/，写到 outputs/review/。基线固定取 fixtures/。

import { mkdir, writeFile } from 'node:fs/promises';
import { loadBundle } from '../src/csv.mjs';
import { runPipelineFromBundle } from '../src/pipeline.mjs';
import { auditTrail, diffRuns, loadSupplement, mergeSupplement, rerunWithMerged } from '../src/review.mjs';

const supplementArg = process.argv[2] ?? 'fixtures-review';
const outputArg = process.argv[3] ?? 'outputs/review';
const baseUrl = new URL('../fixtures/', import.meta.url);
const supplementUrl = new URL(`../${supplementArg.replace(/\/+$/, '')}/`, import.meta.url);
const output = new URL(`../${outputArg.replace(/\/+$/, '')}/`, import.meta.url);

const baseline = await runPipelineFromBundle(await loadBundle(baseUrl));
const supplement = await loadSupplement(supplementUrl);
const baseBundle = await loadBundle(baseUrl);
const merged = mergeSupplement(baseBundle, supplement);
const reviewed = await rerunWithMerged(baseUrl, merged.tables, baseBundle.format);
const diff = diffRuns(baseline, reviewed, supplement);
const trail = auditTrail(baseline, reviewed, diff);

await mkdir(output, { recursive: true });
await writeFile(new URL('reviewed-full.json', output), `${JSON.stringify(reviewed, null, 2)}\n`);
await writeFile(new URL('review-diff.json', output), `${JSON.stringify(diff, null, 2)}\n`);
await writeFile(new URL('audit-trail.json', output), `${JSON.stringify(trail, null, 2)}\n`);

console.log(JSON.stringify({
  补录文件: supplement.files,
  新增规范化成交: diff.addedCanonicalSales.length,
  变化面板格: diff.changedPanel.length,
  DiD: { 前: diff.causal.didBefore, 后: diff.causal.didAfter },
  证据等级: { 前: diff.causal.evidenceGradeBefore, 后: diff.causal.evidenceGradeAfter },
  候选翻转: diff.claimChanges.map(c => ({
    claim: c.claim, 前: c.before.decision, 后: c.after.decision,
    变为不符合: c.flippedToIneligible,
  })),
  已拨付需复核: diff.paidReview.filter(p => p.needsSeparateReview).map(p => p.claim),
  基金: diff.fundLedger,
  输出目录: outputArg,
}, null, 2));
