// 因果证据分析：
// 可比面板（剔除停业/缺报/停航/无观测，不用零填充）→ 通车前趋势 →
// 干净对照组 DiD → 周级区块自助法不确定性 → 安慰剂对照窗口与分流污染单列。

import { distribution, linearTrend, mean, mulberry32, percentileInterval, round2 } from './stats.mjs';
import { openStatus, portAtWeek } from './roster.mjs';

const EXCLUDED_STATUS = new Set(['not-open', 'no-report', 'weather-closed']);

/**
 * 构建经营户×周面板（游客最终购买为主口径，批发单列备忘）。
 */
export function buildPanel({ weekly, roster, openIndex, ports, spillover, weeks }) {
  const treatedPorts = new Set(ports.filter(p => p.opening_week !== '').map(p => p.port));
  const cleanPorts = new Set(spillover.filter(s => s.cleanControl).map(s => s.port));
  const contaminatedPortsSet = new Set(spillover.filter(s => s.spilloverEvidence).map(s => s.port));
  const portArea = new Map(ports.map(p => [p.port, p.area]));

  const entries = [];
  for (const [operator, record] of roster.operators) {
    for (const week of weeks) {
      const port = portAtWeek(record, week);
      const cell = weekly.get(operator)?.get(week);
      const status = openStatus(openIndex, operator, week);
      const base = {
        operator, household: record.household, week, port,
        area: portArea.get(port) ?? null,
        treatedPort: treatedPorts.has(port),
        cleanControlPort: cleanPorts.has(port),
        contaminatedPort: contaminatedPortsSet.has(port),
      };

      if (status && EXCLUDED_STATUS.has(status.declared)) {
        // 风浪停航属于外部冲击：即使交易簿留有凭证也不纳入常规可比样本，
        // 冲击在 causal.traffic 的 closureDays 与剔除摘要中单列。
        if (status.declared === 'weather-closed') {
          entries.push({
            ...base,
            visitor: cell?.visitor ?? null, wholesale: cell?.wholesale ?? null,
            included: false,
            reason: status.declared, reasonLabel: status.label,
            receipts: cell?.receipts ?? [],
          });
          continue;
        }
        if (cell) {
          // 实际成交凭证与停业/缺报登记冲突：以交易证据纳入可比样本，同时保留冲突标记，
          // 供评审回查（典型场景：补录结算把 no-report 周补成有成交）。
          entries.push({
            ...base,
            visitor: cell.visitor, wholesale: cell.wholesale,
            included: true,
            reason: null,
            reasonLabel: null,
            receipts: cell.receipts,
            statusConflict: { declared: status.declared, label: status.label, resolvedBy: '交易凭证优先' },
          });
          continue;
        }
        entries.push({
          ...base,
          visitor: null, wholesale: null, included: false,
          reason: status.declared, reasonLabel: status.label,
        });
        continue;
      }
      if (!cell) {
        entries.push({
          ...base,
          visitor: null, wholesale: null, included: false,
          reason: 'unobserved', reasonLabel: '无交易且无状态记录（不推断为零）',
        });
        continue;
      }
      entries.push({
        ...base,
        visitor: cell.visitor,
        wholesale: cell.wholesale,
        included: true,
        reason: null,
        reasonLabel: null,
        receipts: cell.receipts,
      });
    }
  }
  return entries;
}

function groupWeekMeans(panel, group, period) {
  const result = [];
  for (const week of period.weeks) {
    const rows = panel.filter(e => e.week === week && e.included && group(e));
    const values = rows.map(e => e.visitor);
    result.push({
      week,
      n: values.length,
      mean: values.length ? round2(mean(values)) : null,
      operators: rows.map(e => e.operator),
    });
  }
  return result;
}

/**
 * DiD 主分析。处理组=通车港经营户；干净对照组=无分流证据对照港经营户；
 * 分流污染港经营户不并入对照组。
 */
export function differenceInDifferences(panel, periods, { bootstrap = 2000, seed = 20261123, alpha = 0.1 } = {}) {
  const pre = periods.pre;
  const post = periods.post;
  const treated = e => e.treatedPort;
  const control = e => e.cleanControlPort;
  const contaminated = e => e.contaminatedPort;

  const treatedPreWeeks = groupWeekMeans(panel, treated, pre);
  const treatedPostWeeks = groupWeekMeans(panel, treated, post);
  const controlPreWeeks = groupWeekMeans(panel, control, pre);
  const controlPostWeeks = groupWeekMeans(panel, control, post);

  const calc = (preWeeksT, postWeeksT, preWeeksC, postWeeksC) => {
    const a = mean(preWeeksT.filter(w => w.mean !== null).map(w => w.mean));
    const b = mean(postWeeksT.filter(w => w.mean !== null).map(w => w.mean));
    const c = mean(preWeeksC.filter(w => w.mean !== null).map(w => w.mean));
    const d = mean(postWeeksC.filter(w => w.mean !== null).map(w => w.mean));
    if ([a, b, c, d].some(v => v === null || Number.isNaN(v))) return null;
    return (b - a) - (d - c);
  };

  const point = calc(treatedPreWeeks, treatedPostWeeks, controlPreWeeks, controlPostWeeks);
  const controlChange = round2(
    mean(controlPostWeeks.filter(w => w.mean !== null).map(w => w.mean))
    - mean(controlPreWeeks.filter(w => w.mean !== null).map(w => w.mean)));
  const treatedChange = round2(
    mean(treatedPostWeeks.filter(w => w.mean !== null).map(w => w.mean))
    - mean(treatedPreWeeks.filter(w => w.mean !== null).map(w => w.mean)));

  // 周级区块自助：在通车前/后区块内分别有放回重抽周，重算 DiD。
  const rng = mulberry32(seed);
  const picks = weeks => Array.from({ length: weeks.length }, () => weeks[Math.floor(rng() * weeks.length)]);
  const boot = [];
  for (let i = 0; i < bootstrap; i += 1) {
    const value = calc(
      picks(treatedPreWeeks), picks(treatedPostWeeks),
      picks(controlPreWeeks), picks(controlPostWeeks));
    if (value !== null) boot.push(round2(value));
  }
  const ci = percentileInterval(boot, alpha);

  // 安慰剂对照窗口：通车前内部切两半（1-2 周 vs 3-4 周）做一次"假通车"DiD。
  const placeboPeriod = {
    placeboPre: { weeks: pre.weeks.slice(0, Math.ceil(pre.weeks.length / 2)) },
    placeboPost: { weeks: pre.weeks.slice(Math.ceil(pre.weeks.length / 2)) },
  };
  const placeboTPre = groupWeekMeans(panel, treated, placeboPeriod.placeboPre);
  const placeboTPost = groupWeekMeans(panel, treated, placeboPeriod.placeboPost);
  const placeboCPre = groupWeekMeans(panel, control, placeboPeriod.placeboPre);
  const placeboCPost = groupWeekMeans(panel, control, placeboPeriod.placeboPost);
  const placebo = calc(placeboTPre, placeboTPost, placeboCPre, placeboCPost);

  // 通车前趋势：组-周均值序列的 OLS 斜率。
  const toPoints = weekly => weekly.filter(w => w.mean !== null).map(w => ({ x: w.week, y: w.mean }));
  const preTrend = {
    treated: linearTrend(toPoints(treatedPreWeeks)),
    control: linearTrend(toPoints(controlPreWeeks)),
  };

  // 样本与剔除计数。
  const countSample = group => ({
    pre: panel.filter(e => group(e) && pre.weeks.includes(e.week)).map(e => ({ e, included: e.included }))
      .reduce((acc, x) => {
        if (x.e.included) acc.included += 1; else acc.excluded[x.e.reason] = (acc.excluded[x.e.reason] ?? 0) + 1;
        return acc;
      }, { included: 0, excluded: {} }),
    post: panel.filter(e => group(e) && post.weeks.includes(e.week)).reduce((acc, e) => {
      if (e.included) acc.included += 1; else acc.excluded[e.reason] = (acc.excluded[e.reason] ?? 0) + 1;
      return acc;
    }, { included: 0, excluded: {} }),
  });

  // 分流污染组单独描述，不并入对照。
  const contaminatedOperators = [...new Set(panel.filter(contaminated).map(e => e.operator))];

  const evidence = gradeEvidence(point, ci, {
    treatedPreOperators: new Set(treatedPreWeeks.flatMap(w => w.operators)).size,
    controlOperators: new Set(controlPreWeeks.flatMap(w => w.operators)).size,
  });

  return {
    caliber: {
      metric: '游客最终购买口径的经营户-周净收入（批发转售单列，不计入）',
      treatedDefinition: '港口 opening_week 非空的处理港经营户',
      controlDefinition: '未通车且分流比率无任何一周达到门槛的干净对照港经营户',
      exclusion: 'not-open/no-report/weather-closed 与无观测周剔除，不以零值填充',
    },
    weeklyMeans: {
      treatedPre: treatedPreWeeks, treatedPost: treatedPostWeeks,
      controlPre: controlPreWeeks, controlPost: controlPostWeeks,
    },
    changes: { treated: treatedChange, control: controlChange },
    did: round2(point),
    bootstrap: { replications: boot.length, seed, alpha, ci },
    placeboDid: placebo === null ? null : round2(placebo),
    preTrend: {
      treatedSlope: preTrend.treated.slope,
      controlSlope: preTrend.control.slope,
      note: '处理组通车前趋势仅由有通车前观测的经营户支撑',
    },
    samples: {
      treated: countSample(treated),
      control: countSample(control),
      contaminatedOperators,
    },
    evidence,
  };
}

function gradeEvidence(point, ci, meta) {
  const caveats = [];
  if (meta.treatedPreOperators < 2) caveats.push('处理组仅有 1 个经营户具备通车前可比观测，户间异质性无法检验');
  if (meta.controlOperators < 2) caveats.push('干净对照组经营户不足 2 个');
  if (ci.low === null) return { grade: '不足', reason: '自助样本不足，无法构造区间', caveats };
  const spansZero = ci.low <= 0 && ci.high >= 0;
  if (spansZero) {
    return { grade: '有限', reason: '90% 自助区间跨越 0，方向证据不稳健', caveats };
  }
  if (Math.abs(point) < 30) {
    return { grade: '中等', reason: '区间不跨 0 但估计量绝对值较小，实际意义需结合金额判断', caveats };
  }
  return { grade: '较强', reason: '90% 自助区间不跨 0 且估计量具备金额意义', caveats };
}

/** 收入分布：只描述实际可比的经营户-周。 */
export function incomeDistributions(panel, periods) {
  const pick = (group, period) =>
    panel.filter(e => group(e) && period.weeks.includes(e.week) && e.included).map(e => e.visitor);
  const groups = {
    处理组: e => e.treatedPort,
    干净对照组: e => e.cleanControlPort,
    分流污染组: e => e.contaminatedPort,
  };
  const out = {};
  for (const [name, group] of Object.entries(groups)) {
    out[name] = {
      pre: distribution(pick(group, periods.pre)),
      post: distribution(pick(group, periods.post)),
    };
  }
  return out;
}

/** 批发转售单列汇总（避免与游客最终购买混算）。 */
export function wholesaleMemo(panel, periods) {
  const sum = rows => rows.reduce((acc, e) => acc + (e.wholesale ?? 0), 0);
  return {
    pre: {
      treated: sum(panel.filter(e => e.treatedPort && periods.pre.weeks.includes(e.week) && e.included)),
      control: sum(panel.filter(e => e.cleanControlPort && periods.pre.weeks.includes(e.week) && e.included)),
    },
    post: {
      treated: sum(panel.filter(e => e.treatedPort && periods.post.weeks.includes(e.week) && e.included)),
      control: sum(panel.filter(e => e.cleanControlPort && periods.post.weeks.includes(e.week) && e.included)),
    },
  };
}

/**
 * 户级反事实损失（扶持判断的收入证据，不使用片区增减替代）。
 * 反事实 post 均值 = 该户通车前周均值 + 干净对照组的组级变化；
 * 损失 = 反事实 − 实际 post 均值，正值才构成损失证据。
 */
export function operatorCounterfactualLoss(panel, did) {
  const controlDelta = did.changes.control;
  const result = [];
  const operators = [...new Set(panel.map(e => e.operator))];
  for (const operator of operators) {
    const rows = panel.filter(e => e.operator === operator);
    const preValues = rows.filter(e => e.included && e.week <= 4).map(e => e.visitor);
    const postValues = rows.filter(e => e.included && e.week >= 5).map(e => e.visitor);
    const preMean = preValues.length ? round2(mean(preValues)) : null;
    const postMean = postValues.length ? round2(mean(postValues)) : null;
    let loss = null;
    let estimable = true;
    let note = '';
    if (preMean === null) { estimable = false; note = '通车前无可比观测，无法构造反事实'; }
    else if (postMean === null) { estimable = false; note = '通车后无可比观测'; }
    else if (controlDelta === null) { estimable = false; note = '干净对照组变化不可估'; }
    else loss = round2(preMean + controlDelta - postMean);
    result.push({
      operator,
      portGroup: rows[0].treatedPort ? '处理组' : rows[0].cleanControlPort ? '干净对照组' : '分流污染组',
      preMean, postMean,
      controlDelta,
      counterfactualLoss: loss,
      estimable,
      note,
      preWeeks: preValues.length,
      postWeeks: postValues.length,
    });
  }
  return result.sort((a, b) => a.operator.localeCompare(b.operator));
}

/** 客流口径的组级前后对比（外部需求背景，不与户级收入混同）。 */
export function trafficContext(visits, ports, spillover, periods) {
  const treatedPorts = new Set(ports.filter(p => p.opening_week !== '').map(p => p.port));
  const cleanPorts = new Set(spillover.filter(s => s.cleanControl).map(s => s.port));
  const rows = visits.map(v => ({
    port: v.port,
    week: Number(v.week),
    traffic: Number(v.traffic),
    viaNewBridge: Number(v.via_new_bridge),
    closureDays: Number(v.closure_days),
  }));
  const summarize = (portSet, period) => {
    const subset = rows.filter(r => portSet.has(r.port) && period.weeks.includes(r.week));
    return {
      weeklyMeanTraffic: round2(mean(subset.map(r => r.traffic))),
      totalViaNewBridge: subset.reduce((a, r) => a + r.viaNewBridge, 0),
      totalClosureDays: subset.reduce((a, r) => a + r.closureDays, 0),
      n: subset.length,
    };
  };
  return {
    treated: { pre: summarize(treatedPorts, periods.pre), post: summarize(treatedPorts, periods.post) },
    cleanControl: { pre: summarize(cleanPorts, periods.pre), post: summarize(cleanPorts, periods.post) },
  };
}
