// 评审补数：在不改动原始交接资料的前提下，叠加一个独立补录目录，
// 重跑同一管线并逐项对比，报告：
//  - 哪些规范化成交、面板观测、分布与 DiD 发生变化；
//  - 哪些扶持候选由建议变为不再符合（或相反）；
//  - 已拨付款项为何需要另行复核；
//  - 每次运行的原口径与输入证据哈希均可回查。

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadBundle, parseTable } from './csv.mjs';
import { runPipelineFromBundle } from './pipeline.mjs';

/**
 * 读取补录目录。允许只提供部分表：
 *  - transactions-补录.csv       淡季交易/后续结算补录（表头同 transactions）
 *  - support-补录.csv            凭据核实后的申请覆盖行（claim 相同则整行替换）
 *  - operator-open-补录.csv      营业状态更正（operator+week 相同则整行替换）
 *  - review-notes.json           归属凭据与结算状态的人工说明
 */
export async function loadSupplement(supplementUrl) {
  const format = JSON.parse(await readFile(new URL('format.json', supplementUrl), 'utf8'));
  const readOptional = async (name, fields) => {
    try {
      const content = await readFile(new URL(`${name}.csv`, supplementUrl), 'utf8');
      return { rows: parseTable(content, fields, name), hash: createHash('sha256').update(content).digest('hex') };
    } catch (error) {
      if (error.code === 'ENOENT') return { rows: [], hash: null };
      throw error;
    }
  };

  const tx = await readOptional('transactions-补录', format.tables.transactions);
  const support = await readOptional('support-补录', format.tables.support);
  const open = await readOptional('operator-open-补录', format.tables['operator-open']);

  let notes = [];
  try {
    const raw = await readFile(new URL('review-notes.json', supplementUrl), 'utf8');
    const parsed = JSON.parse(raw);
    notes = Array.isArray(parsed) ? parsed : parsed.notes ?? [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    transactions: tx.rows,
    support: support.rows,
    open: open.rows,
    notes,
    files: [
      ...(tx.hash ? [{ table: 'transactions-补录', sha256: tx.hash }] : []),
      ...(support.hash ? [{ table: 'support-补录', sha256: support.hash }] : []),
      ...(open.hash ? [{ table: 'operator-open-补录', sha256: open.hash }] : []),
    ],
  };
}

/** 把补录合并进基线表，返回新 bundle（内存对象，不落盘覆盖原资料）。 */
export function mergeSupplement(base, supplement) {
  const tables = Object.fromEntries(Object.entries(base.tables).map(([k, v]) => [k, v.slice()]));

  // 交易：补录凭证号不得与基线冲突，冲突说明归属问题未在补录层解决。
  const baseReceipts = new Set(tables.transactions.map(r => r.receipt));
  for (const row of supplement.transactions) {
    if (baseReceipts.has(row.receipt)) {
      throw new Error(`补录凭证 ${row.receipt} 与基线交易凭证冲突，应走 support 凭据覆盖而非新增交易`);
    }
    tables.transactions.push(row);
  }

  // 申请：同 claim 整行替换（凭据核实/结算状态更新）。
  const claimIndex = new Map(tables.support.map((r, i) => [r.claim, i]));
  const replaced = [];
  for (const row of supplement.support) {
    if (claimIndex.has(row.claim)) {
      const idx = claimIndex.get(row.claim);
      replaced.push({ claim: row.claim, before: tables.support[idx], after: row });
      tables.support[idx] = row;
    } else {
      claimIndex.set(row.claim, tables.support.length);
      tables.support.push(row);
    }
  }

  // 营业状态：同 operator+week 整行替换；新增状态直接追加。
  const openIndex = new Map(tables['operator-open'].map((r, i) => [`${r.operator}|${r.week}`, i]));
  const openChanges = [];
  for (const row of supplement.open ?? []) {
    const key = `${row.operator}|${row.week}`;
    if (openIndex.has(key)) {
      const idx = openIndex.get(key);
      openChanges.push({ key, before: tables['operator-open'][idx], after: row });
      tables['operator-open'][idx] = row;
    } else {
      openIndex.set(key, tables['operator-open'].length);
      tables['operator-open'].push(row);
      openChanges.push({ key, before: null, after: row });
    }
  }
  return {
    tables, replaced, openChanges,
    addedTransactions: supplement.transactions.length,
  };
}

/** 用合并后的内存 bundle 重跑管线（loadBundle 的校验在基线上已完成，这里复用）。 */
export async function rerunWithMerged(baseUrl, mergedTables, format, options = {}) {
  const base = await loadBundle(baseUrl);
  const bundle = { tables: mergedTables, files: base.files, format };
  return runPipelineFromBundle(bundle, options);
}

/**
 * 对比两次运行结果，产出评审变更清单。
 */
export function diffRuns(baseline, reviewed, supplement) {
  const keySale = s => `${s.receipt}|${s.lot}|${s.operator}|${s.week}|${s.buyer}|${s.amount}`;
  const baseSales = new Set(baseline.transactions.sales.map(keySale));
  const newSales = reviewed.transactions.sales.filter(s => !baseSales.has(keySale(s)));

  const cellKey = e => `${e.operator}|${e.week}`;
  const basePanel = new Map(baseline.panel.entries.map(e => [cellKey(e), e]));
  const changedPanel = reviewed.panel.entries
    .filter(e => {
      const old = basePanel.get(cellKey(e));
      if (!old) return true;
      return old.included !== e.included || old.visitor !== e.visitor || old.reason !== e.reason;
    })
    .map(e => ({
      operator: e.operator, week: e.week,
      before: summarizeCell(basePanel.get(cellKey(e))),
      after: summarizeCell(e),
    }));

  const claimKey = c => c.claim;
  const baseClaims = indexClaims(baseline);
  const reviewedClaims = indexClaims(reviewed);
  const claimChanges = [];
  for (const [claim, after] of reviewedClaims) {
    const before = baseClaims.get(claim);
    if (!before || sameDecision(before, after)) continue;
    claimChanges.push({
      claim,
      operator: after.operator,
      before: { decision: before.decision, approved: before.approved, pending: before.pending, evidence: before.evidence.ledgerCheck },
      after: { decision: after.decision, approved: after.approved, pending: after.pending, evidence: after.evidence.ledgerCheck },
      flippedToIneligible: after.decision === '待核资格' && before.decision !== '待核资格',
      flippedFromIneligible: before.decision === '待核资格' && after.decision !== '待核资格',
    });
  }

  // 已拨付项：证据核对结论变化或补录说明精确涉及时，转另行复核。
  const allReviewedReceipts = new Set(reviewed.transactions.sales.flatMap(s => s.mergedReceipts));
  const paidReview = [...reviewed.allocation.decisions]
    .filter(d => d.state === 'paid')
    .map(d => {
      const before = baseClaims.get(d.claim);
      // 精确命中：说明显式指向该 claim、该经营户，或列出的凭证确在本成交集合内。
      const noteHit = supplement.notes.filter(n => {
        if (n.claim && n.claim !== d.claim) return false;
        if (n.operator && n.operator !== d.operator) return false;
        if (n.receipts?.length) return n.receipts.some(r => allReviewedReceipts.has(r));
        return n.claim === d.claim || n.operator === d.operator;
      });
      return {
        claim: d.claim,
        operator: d.operator,
        amount: d.requested,
        ledgerCheckBefore: before?.evidence.ledgerCheck,
        ledgerCheckAfter: d.evidence.ledgerCheck,
        needsSeparateReview: d.reviewRequired
          || before?.evidence.ledgerCheck !== d.evidence.ledgerCheck
          || noteHit.length > 0,
        reasons: [
          ...(d.reviewRequired ? ['台账反事实损失与登记损失不符'] : []),
          ...(before?.evidence.ledgerCheck !== d.evidence.ledgerCheck ? ['补数后证据核对结论改变'] : []),
          ...noteHit.map(n => `补录说明：${n.summary ?? JSON.stringify(n)}`),
        ],
      };
    });

  return {
    supplementEvidence: supplement.files,
    notes: supplement.notes,
    addedCanonicalSales: newSales.map(s => ({
      receipt: s.receipt, lot: s.lot, operator: s.operator, port: s.port,
      week: s.week, buyer: s.buyer, amount: s.amount, status: s.status,
    })),
    reviewQueueDelta: reviewed.transactions.review.length - baseline.transactions.review.length,
    changedPanel,
    causal: {
      didBefore: baseline.causal.did.did,
      didAfter: reviewed.causal.did.did,
      ciBefore: baseline.causal.did.bootstrap.ci,
      ciAfter: reviewed.causal.did.bootstrap.ci,
      evidenceGradeBefore: baseline.causal.did.evidence.grade,
      evidenceGradeAfter: reviewed.causal.did.evidence.grade,
      placeboBefore: baseline.causal.did.placeboDid,
      placeboAfter: reviewed.causal.did.placeboDid,
    },
    lossBefore: baseline.householdLoss,
    lossAfter: reviewed.householdLoss,
    claimChanges,
    paidReview,
    fundLedger: {
      before: baseline.allocation.fundLedger,
      after: reviewed.allocation.fundLedger,
    },
  };
}

function summarizeCell(e) {
  if (!e) return null;
  return { included: e.included, visitor: e.visitor, reason: e.reason, reasonLabel: e.reasonLabel };
}

function indexClaims(run) {
  const all = [...run.allocation.decisions, ...run.allocation.waitlist, ...run.allocation.ineligible];
  return new Map(all.map(c => [c.claim, c]));
}

function sameDecision(a, b) {
  return a.decision === b.decision && a.approved === b.approved
    && a.pending === b.pending && a.evidence.ledgerCheck === b.evidence.ledgerCheck;
}

/** 生成带运行编号的复核目录清单（原口径回查）。 */
export function auditTrail(baseline, reviewed, diff) {
  return {
    baseline: {
      generatedAt: baseline.caliber.generatedAt,
      inputFiles: baseline.caliber.inputFiles,
      bootstrapSeed: baseline.caliber.bootstrapReplications,
    },
    reviewed: {
      generatedAt: reviewed.caliber.generatedAt,
      inputFiles: reviewed.caliber.inputFiles,
      supplementFiles: diff.supplementEvidence,
    },
    scope: {
      changedPanelCells: diff.changedPanel.length,
      changedClaims: diff.claimChanges.length,
      paidClaimsRequiringSeparateReview: diff.paidReview.filter(p => p.needsSeparateReview).length,
    },
  };
}
