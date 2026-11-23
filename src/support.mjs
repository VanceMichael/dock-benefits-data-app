// 扶持提案：户级证据决策 + 家庭额度与基金占用两套账。
// 规则（fund 表为本季参数）：
//  1. 只处理 fund.period 内的申请；同户多个经营点共用 per_household 额度；
//  2. 已拨付（paid）先占用家庭额度与基金；
//  3. 新候选须有登记在案的正损失，按损失金额降序、等额按申请号稳定排序；
//  4. 每户批准额不超过 per_household 已占用后的余量，总额不超过基金余量；
//     放不下的部分保留待审；无正损失/来源不确定的列待核资格，不参与排序；
//  5. 台账反事实损失作为证据交叉核对，户级判断不用片区增减替代。

import { toAmount, toInt } from './csv.mjs';

/**
 * @param {object[]} supportRows support 表
 * @param {Map<string, object>} roster roster.operators
 * @param {object} fund fund 表单行（已转数值）
 * @param {object[]} lossRows operatorCounterfactualLoss 输出
 * @param {Set<string>} contaminatedOperators 分流污染港经营户
 */
export function allocateSupport({ supportRows, roster, fund, lossRows, contaminatedOperators }) {
  const lossByOperator = new Map(lossRows.map(r => [r.operator, r]));
  const period = toInt(fund.period, 'period');
  const total = toAmount(fund.total, 'total');
  const perHousehold = toAmount(fund.per_household, 'per_household');

  const claims = supportRows
    .filter(r => toInt(r.period, 'period') === period)
    .map(row => {
      const operator = roster.get(row.operator);
      const loss = lossByOperator.get(row.operator);
      const registeredLoss = toAmount(row.evidence_loss, 'evidence_loss');
      const requested = toAmount(row.amount, 'amount');
      const corroboration = classifyEvidence(registeredLoss, loss, contaminatedOperators.has(row.operator));
      return {
        claim: row.claim,
        operator: row.operator,
        household: operator?.household ?? null,
        period,
        state: row.state,
        updatedWeek: toInt(row.updated_week, 'updated_week'),
        registeredLoss,
        requested,
        ledger: loss ? {
          estimable: loss.estimable,
          counterfactualLoss: loss.counterfactualLoss,
          preMean: loss.preMean,
          postMean: loss.postMean,
          note: loss.note,
        } : null,
        evidence: corroboration,
      };
    });

  const outOfScope = supportRows
    .filter(r => toInt(r.period, 'period') !== period)
    .map(r => ({ claim: r.claim, reason: `申请期 ${r.period} 不在本季基金口径 ${period} 内` }));

  // 家庭额度账：先记已拨付占用。
  const householdUsed = new Map();
  const ensure = household => {
    if (!householdUsed.has(household)) householdUsed.set(household, 0);
    return householdUsed.get(household);
  };

  const decisions = [];
  const paid = claims.filter(c => c.state === 'paid');
  const candidates = claims.filter(c => c.state !== 'paid');

  for (const claim of paid) {
    ensure(claim.household);
    householdUsed.set(claim.household, (householdUsed.get(claim.household) ?? 0) + claim.requested);
    decisions.push({
      ...claim,
      decision: '已拨付占用',
      approved: claim.requested,
      pending: 0,
      reviewRequired: claim.evidence.ledgerCheck === '与台账反事实损失不符',
    });
  }

  // 待核资格：无登记正损失（含 unverified、零损失），不参与排序。
  const eligible = [];
  const ineligible = [];
  for (const claim of candidates) {
    if (!(claim.registeredLoss > 0)) {
      ineligible.push({
        ...claim,
        decision: '待核资格',
        approved: 0,
        pending: 0,
        holdReason: claim.registeredLoss === 0 ? '登记损失为 0，无正损失证据' : '损失来源未核实',
      });
    } else {
      eligible.push(claim);
    }
  }
  eligible.sort((a, b) =>
    (b.registeredLoss - a.registeredLoss) || a.claim.localeCompare(b.claim));

  let fundRemaining = total - paid.reduce((acc, c) => acc + c.requested, 0);
  const waitlist = [];

  for (const claim of eligible) {
    ensure(claim.household);
    const householdRemaining = perHousehold - (householdUsed.get(claim.household) ?? 0);
    const approved = Math.max(0, Math.min(claim.requested, householdRemaining, fundRemaining));
    const pending = claim.requested - approved;
    householdUsed.set(claim.household, (householdUsed.get(claim.household) ?? 0) + approved);
    fundRemaining -= approved;

    const base = {
      ...claim,
      approved,
      pending,
      householdCap: perHousehold,
      householdUsedAfter: householdUsed.get(claim.household),
      constraints: {
        householdRemainingBefore: Math.max(0, householdRemaining),
        fundRemainingBefore: approved + Math.max(0, fundRemaining),
      },
    };
    if (approved === claim.requested) {
      decisions.push({ ...base, decision: '建议批准', reviewRequired: claim.evidence.ledgerCheck === '与台账反事实损失不符' });
    } else if (approved > 0) {
      decisions.push({ ...base, decision: '部分批准，余额待审', reviewRequired: claim.evidence.ledgerCheck === '与台账反事实损失不符' });
      waitlist.push({ ...base, pendingReason: pendingReason(base) });
    } else {
      waitlist.push({ ...base, decision: '保留待审', pendingReason: pendingReason(base) });
    }
  }

  // 匿名汇总与资金占用对账所需的额度账。
  const householdLedger = [...householdUsed.entries()]
    .map(([household, used]) => ({
      household,
      cap: perHousehold,
      occupied: used,
      remaining: perHousehold - used,
      operators: [...new Set(claims.filter(c => c.household === household).map(c => c.operator))],
    }))
    .sort((a, b) => a.household.localeCompare(b.household));

  const totalApproved = decisions.reduce((acc, d) => acc + d.approved, 0);
  const fundLedger = {
    period,
    total,
    occupied: totalApproved,
    remaining: total - totalApproved,
    pendingAmount: waitlist.reduce((acc, w) => acc + w.pending, 0),
    paidCount: paid.length,
  };

  return {
    caliber: {
      period,
      rule: '已拨付先占家庭额度；正损失候选按金额降序、申请号升序；户额度与基金余量双重约束',
      note: '批准是资金口径动作；evidence.ledgerCheck 为台账证据核对，不符者转人工复核',
    },
    decisions: decisions.sort((a, b) => a.claim.localeCompare(b.claim)),
    waitlist: waitlist.sort((a, b) => a.claim.localeCompare(b.claim)),
    ineligible: ineligible.sort((a, b) => a.claim.localeCompare(b.claim)),
    householdLedger,
    fundLedger,
    outOfScope,
  };
}

function pendingReason(entry) {
  if (entry.constraints.householdRemainingBefore < entry.requested && entry.constraints.fundRemainingBefore <= 0) {
    return '家庭额度与基金余额同时不足';
  }
  if (entry.constraints.householdRemainingBefore < entry.requested) return '家庭额度不足（同户多经营点共用）';
  return '基金余额不足';
}

function classifyEvidence(registeredLoss, loss, contaminated) {
  const flags = [];
  if (contaminated) flags.push('经营点所在对照港有经新桥分流证据，片区增减不能替代户级判断');
  if (!loss) return { ledgerCheck: '台账不可比', flags };
  if (!loss.estimable) return { ledgerCheck: '反事实不可估', flags: [...flags, loss.note] };
  if (!(registeredLoss > 0)) {
    return {
      ledgerCheck: loss.counterfactualLoss > 0 ? '台账显示存在正损失但申请未登记' : '无正损失证据',
      flags,
    };
  }
  if (loss.counterfactualLoss <= 0) {
    return { ledgerCheck: '与台账反事实损失不符', flags: [...flags, '台账反事实损失≤0，登记损失缺少收入侧支撑'] };
  }
  return {
    ledgerCheck: '与台账反事实损失同向',
    flags,
    tolerance: Math.abs(loss.counterfactualLoss - registeredLoss),
  };
}
