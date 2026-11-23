import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBundle } from '../src/csv.mjs';
import { runPipelineFromBundle } from '../src/pipeline.mjs';

const bundle = await loadBundle(new URL('../fixtures/', import.meta.url));
const run = () => runPipelineFromBundle(bundle, { bootstrap: 500 });

test('基线管线：货权口径、分流分组与面板剔除口径', () => {
  const r = run();
  // 112 条凭证：1 对渠道再报合并为 1 笔，111 笔确认成交，其中批发 1、游客 110。
  assert.equal(r.transactions.quality.原始凭证数, 112);
  assert.equal(r.transactions.quality.确认成交数, 111);
  assert.equal(r.transactions.quality.批发笔数, 1);
  assert.equal(r.transactions.quality.游客笔数, 110);

  // P3 第 5 周分流 60/140 跨 0.20 门槛；P4/P5 为干净对照。
  assert.deepEqual(r.spillover.filter(s => s.spilloverEvidence).map(s => s.port), ['P3']);
  assert.deepEqual(r.spillover.filter(s => s.cleanControl).map(s => s.port), ['P4', 'P5']);

  // 停业/缺报/停航分别剔除且不以零填充。
  const reasons = Object.fromEntries(Object.entries(r.panel.exclusionSummary).map(([k, v]) => [k, v.count]));
  assert.equal(reasons['not-open'], 2);
  assert.equal(reasons['no-report'], 1);
  assert.equal(reasons['weather-closed'], 1);
  assert.ok(reasons.unobserved >= 1);
});

test('DiD 主口径只用游客收入，区间与证据等级随数据产出', () => {
  const r = run();
  const did = r.causal.did;
  assert.equal(typeof did.did, 'number');
  // 处理组通车前只有 V2 有观测，结论必须带该不确定性提示。
  assert.ok(did.evidence.caveats.some(c => c.includes('1 个经营户')));
  assert.equal(did.bootstrap.replications, 500);
  assert.ok(did.bootstrap.ci.low <= did.did && did.did <= did.bootstrap.ci.high);
  // 安慰剂窗口与通车前斜率必须同时报告。
  assert.equal(typeof did.placeboDid, 'number');
  assert.equal(typeof did.preTrend.treatedSlope, 'number');
});

test('户级反事实损失不被片区增减替代，且逐户给出可估性', () => {
  const r = run();
  const v3 = r.householdLoss.find(x => x.operator === 'V3');
  assert.equal(v3.estimable, false);
  assert.match(v3.note, /通车前无可比观测/);
  const v6 = r.householdLoss.find(x => x.operator === 'V6');
  assert.equal(v6.estimable, true);
  assert.equal(typeof v6.counterfactualLoss, 'number');
  // 分流污染组 V4 仍做户级判断，但结果带污染提示。
  const v4 = r.householdLoss.find(x => x.operator === 'V4');
  assert.equal(v4.portGroup, '分流污染组');
});

test('扶持分配：已拨付先占额度，家庭余量与基金余量双重约束', () => {
  const r = run();
  const { decisions, waitlist, ineligible, fundLedger, householdLedger } = r.allocation;
  const byClaim = new Map(decisions.map(d => [d.claim, d]));

  // C1 已拨付 300 先占 F1 额度。
  assert.equal(byClaim.get('C1').decision, '已拨付占用');
  // F1 额度 350，C2 申请 260 只剩 50，210 待审。
  assert.equal(byClaim.get('C2').approved, 50);
  assert.equal(byClaim.get('C2').pending, 210);
  const c2Wait = waitlist.find(w => w.claim === 'C2');
  assert.match(c2Wait.pendingReason, /家庭额度/);
  // C3 零损失 → 待核资格，不进排序。
  assert.ok(ineligible.some(i => i.claim === 'C3' && i.decision === '待核资格'));
  // C4 台账反事实损失为负，登记损失缺少收入侧支撑，标记复核。
  assert.equal(byClaim.get('C4').reviewRequired, true);

  assert.equal(fundLedger.occupied, 630);
  assert.equal(fundLedger.remaining, 20);
  assert.equal(fundLedger.pendingAmount, 210);
  const f1 = householdLedger.find(h => h.household === 'F1');
  assert.equal(f1.occupied, 350);
  assert.equal(f1.remaining, 0);
});

test('匿名发布：小样本抑制且项目级资金总额可对账', () => {
  const r = run();
  const { reconciliation, areas, villages } = r.published;
  assert.equal(reconciliation.programTotalMatches, true);
  assert.equal(reconciliation.bucketDetailMatches, true);
  // 每个片区/村在门槛 3 下均不足 3 户，金额必须抑制。
  assert.ok(areas.every(a => a.suppressed));
  assert.ok(villages.every(v => v.suppressed));
  // 公开总额仍与基金占用恒等。
  assert.equal(r.published.fundTotals.occupied, r.allocation.fundLedger.occupied);
});

test('口径清单留存输入文件哈希，支持原口径回查', () => {
  const r = run();
  const names = r.caliber.inputFiles.map(f => f.table).sort();
  assert.deepEqual(names, Object.keys(bundle.tables).sort());
  assert.ok(r.caliber.inputFiles.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
});
