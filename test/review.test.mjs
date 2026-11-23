import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBundle } from '../src/csv.mjs';
import { runPipelineFromBundle } from '../src/pipeline.mjs';
import { diffRuns, loadSupplement, mergeSupplement } from '../src/review.mjs';

const baseUrl = new URL('../fixtures/', import.meta.url);
const supplementUrl = new URL('../fixtures-review/', import.meta.url);

async function reviewedRun() {
  const base = await loadBundle(baseUrl);
  const supplement = await loadSupplement(supplementUrl);
  const merged = mergeSupplement(base, supplement);
  const baseline = await runPipelineFromBundle(base);
  const reviewed = await runPipelineFromBundle(
    { tables: merged.tables, files: base.files, format: base.format });
  return { baseline, reviewed, supplement, merged };
}

test('补录目录只允许新增凭证，冲突凭证号直接报错', async () => {
  const base = await loadBundle(baseUrl);
  await assert.rejects(
    async () => mergeSupplement(base, {
      transactions: [{ receipt: 'TX1' }], support: [], open: [], notes: [],
    }),
    /TX1/,
  );
});

test('淡季补录把停业/缺报周转为可比观测，并保留状态变化证据', async () => {
  const { baseline, reviewed, supplement, merged } = await reviewedRun();
  const diff = diffRuns(baseline, reviewed, supplement);
  const cells = new Map(diff.changedPanel.map(c => [`${c.operator}-${c.week}`, c]));
  assert.equal(cells.get('V3-3').before.included, false);
  assert.equal(cells.get('V3-3').after.included, true);
  assert.equal(cells.get('V5-7').after.visitor, 507);
  // 合并层保留状态更正记录。
  assert.ok(merged.openChanges.some(c => c.key === 'V5|7'));
});

test('补数改变因果结论：DiD 与证据等级均重算，结果随证据变化', async () => {
  const { baseline, reviewed, supplement } = await reviewedRun();
  const diff = diffRuns(baseline, reviewed, supplement);
  assert.notEqual(diff.causal.didBefore, diff.causal.didAfter);
  assert.notEqual(diff.causal.evidenceGradeBefore, diff.causal.evidenceGradeAfter);
  // V3 由反事实不可估变为可估。
  const v3After = reviewed.householdLoss.find(x => x.operator === 'V3');
  assert.equal(v3After.estimable, true);
});

test('候选翻转：C4 由建议批准变为待核资格；C2 证据结论改变但仍受家庭额度约束', async () => {
  const { baseline, reviewed, supplement } = await reviewedRun();
  const diff = diffRuns(baseline, reviewed, supplement);
  const c4 = diff.claimChanges.find(c => c.claim === 'C4');
  assert.equal(c4.flippedToIneligible, true);
  assert.equal(c4.after.decision, '待核资格');
  const c2 = diff.claimChanges.find(c => c.claim === 'C2');
  assert.notEqual(c2.before.evidence, c2.after.evidence);
  assert.equal(c2.after.approved, 50);
});

test('已拨付款项单独列出复核，补录说明精确命中', async () => {
  const { baseline, reviewed, supplement } = await reviewedRun();
  const diff = diffRuns(baseline, reviewed, supplement);
  const c1 = diff.paidReview.find(p => p.claim === 'C1');
  assert.equal(c1.needsSeparateReview, true);
  // 只有指向 C1/V2 或其凭证的说明进入理由，V3/V5 的说明不挂进来。
  assert.ok(c1.reasons.every(r => !r.includes('S001') && !r.includes('S010')));
  assert.ok(c1.reasons.some(r => r.includes('TX1')));
});

test('补数后基金占用变化可对账，待审金额与家庭账保持一致', async () => {
  const { reviewed } = await reviewedRun();
  const ledger = reviewed.allocation.fundLedger;
  assert.equal(ledger.occupied + ledger.remaining, ledger.total);
  assert.equal(ledger.occupied, 350);
  assert.equal(ledger.pendingAmount, 210);
});
