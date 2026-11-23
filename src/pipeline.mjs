// 季度会主管线：装载 → 规范化 → 名册/状态 → 分流评估 → 面板与因果 →
// 扶持分配 → 匿名发布 → 口径清单。纯函数组装，便于复核与补数重跑。

import { loadBundle, toAmount, toInt } from './csv.mjs';
import { canonicalizeTransactions, weeklyRevenue } from './canonical.mjs';
import { buildOpenIndex, buildRoster } from './roster.mjs';
import { assessSpillover } from './spillover.mjs';
import {
  buildPanel, differenceInDifferences, incomeDistributions,
  operatorCounterfactualLoss, trafficContext, wholesaleMemo,
} from './causal.mjs';
import { allocateSupport } from './support.mjs';
import { publishSummary } from './publish.mjs';

/**
 * 从资料目录装载并运行管线。
 * @param {string|URL} source 资料目录 URL
 * @param {object} [options]
 * @param {number} [options.bootstrap] 自助次数
 */
export async function runPipeline(source, options = {}) {
  const bundle = await loadBundle(source);
  return runPipelineFromBundle(bundle, options);
}

/**
 * 从已装载（或补数合并后）的内存 bundle 运行同一管线，
 * 保证补数重跑与基线使用完全一致的口径。
 */
export function runPipelineFromBundle(bundle, options = {}) {
  const { tables, files, format } = bundle;

  const periods = buildPeriods(tables['period-weeks']);
  const fund = buildFund(tables.fund);
  const ports = tables.ports.map(row => ({ ...row, openingWeek: row.opening_week === '' ? null : toInt(row.opening_week, 'opening_week') }));

  // 1. 交易规范化与货权口径。
  const canonical = canonicalizeTransactions(tables.transactions);
  const weekly = weeklyRevenue(canonical.sales);

  // 2. 名册、家庭与营业状态。
  const roster = buildRoster(tables.movements);
  const openIndex = buildOpenIndex(tables['operator-open']);

  // 3. 对照港分流评估（通车后窗口）。
  const spillover = assessSpillover(
    tables.visits, tables.ports,
    { first: periods.post.first, last: periods.post.last },
    fund.spilloverThreshold,
  );

  // 4. 面板与因果证据。
  const allWeeks = [];
  for (let w = periods.pre.first; w <= periods.post.last; w += 1) allWeeks.push(w);
  const panel = buildPanel({
    weekly, roster, openIndex, ports: tables.ports, spillover, weeks: allWeeks,
  });
  const did = differenceInDifferences(panel, {
    pre: { weeks: range(periods.pre) },
    post: { weeks: range(periods.post) },
  }, { bootstrap: options.bootstrap ?? 2000 });
  const distributions = incomeDistributions(panel, {
    pre: { weeks: range(periods.pre) },
    post: { weeks: range(periods.post) },
  });
  const wholesale = wholesaleMemo(panel, {
    pre: { weeks: range(periods.pre) },
    post: { weeks: range(periods.post) },
  });
  const lossRows = operatorCounterfactualLoss(panel, did);
  const traffic = trafficContext(tables.visits, tables.ports, spillover, {
    pre: { weeks: range(periods.pre) },
    post: { weeks: range(periods.post) },
  });

  // 5. 扶持分配。
  const contaminated = new Set(
    spillover.filter(s => s.spilloverEvidence).flatMap(s =>
      [...new Set(panel.filter(e => e.port === s.port).map(e => e.operator))]));
  const allocation = allocateSupport({
    supportRows: tables.support,
    roster: roster.operators,
    fund: tables.fund[0],
    lossRows,
    contaminatedOperators: contaminated,
  });

  // 6. 匿名发布与对账。
  const published = publishSummary({
    panel,
    distributions,
    allocation,
    rosterOperators: roster.operators,
    ports: tables.ports,
    periods: { pre: { weeks: range(periods.pre) }, post: { weeks: range(periods.post) } },
  }, fund.publishMinimum);

  return {
    caliber: buildCaliber({ format, files, periods, fund, options }),
    periods,
    fund,
    ports,
    roster: {
      operators: [...roster.operators.values()].map(r => ({
        operator: r.operator, household: r.household,
        basePort: r.basePort, currentPort: r.currentPort,
        moves: r.moves.map(m => ({
          event: m.event, fromPort: m.fromPort, toPort: m.toPort,
          effectiveWeek: m.effectiveWeek, verifiedWeek: m.verifiedWeek,
        })),
      })),
      households: [...roster.households.entries()].map(([household, operators]) => ({ household, operators })),
    },
    openStatus: tables['operator-open'].map(row => ({
      operator: row.operator,
      week: toInt(row.week, 'week'),
      declared: row.declared,
      knownWeek: toInt(row.known_week, 'known_week'),
    })),
    transactions: canonical,
    spillover,
    panel: {
      entries: panel,
      exclusionSummary: summarizeExclusions(panel),
    },
    causal: { did, distributions, wholesale, traffic },
    householdLoss: lossRows,
    allocation,
    published,
  };
}

function summarizeExclusions(panel) {
  const summary = {};
  for (const entry of panel) {
    if (entry.included) continue;
    const key = entry.reason;
    summary[key] = summary[key] ?? { count: 0, label: entry.reasonLabel, operators: new Set() };
    summary[key].count += 1;
    summary[key].operators.add(entry.operator);
  }
  return Object.fromEntries(Object.entries(summary).map(([k, v]) => [
    k, { count: v.count, label: v.label, operators: [...v.operators].sort() },
  ]));
}

function buildPeriods(rows) {
  const map = new Map(rows.map(r => [
    toInt(r.period, 'period'),
    { first: toInt(r.first_week, 'first_week'), last: toInt(r.last_week, 'last_week') },
  ]));
  return {
    pre: { period: 1, ...map.get(1) },
    post: { period: 2, ...map.get(2) },
  };
}

function buildFund(rows) {
  const row = rows[0];
  return {
    period: toInt(row.period, 'period'),
    total: toAmount(row.total, 'total'),
    perHousehold: toAmount(row.per_household, 'per_household'),
    spilloverThreshold: Number(row.spillover_threshold),
    publishMinimum: toInt(row.publish_minimum, 'publish_minimum'),
  };
}

function range(period) {
  const out = [];
  for (let w = period.first; w <= period.last; w += 1) out.push(w);
  return out;
}

function buildCaliber({ format, files, periods, fund, options }) {
  return {
    generatedAt: new Date().toISOString(),
    engine: 'node:test 管线（仅依赖 Node.js 标准库）',
    bootstrapReplications: options.bootstrap ?? 2000,
    periodWindows: periods,
    fundParameters: fund,
    definitions: {
      渠道再报: '同 lot、同经营户、等额的 dock/online 两条凭证视为同一成交，只计一次',
      批发与游客: 'wholesale 为入手后再售，visitor 为最终购买；因果与扶持的主口径只用 visitor',
      迁摊: '归属按 effective_week，核实日期按 verified_week；迁摊不新增经营户',
      分流门槛: `对照港通车后任一周 via_new_bridge/traffic ≥ ${fund.spilloverThreshold} 即移出干净对照组`,
      缺失处理: 'not-open/no-report/weather-closed 分别剔除并披露；无观测不以零填充',
      扶持排序: '正损失按登记金额降序、申请号升序；paid 先占家庭额度与基金',
      发布门槛: `分组可识别主体 < ${fund.publishMinimum} 抑制；村与片区同时小样本禁止凑差`,
    },
    inputFiles: files,
    tableHeaders: format.tables,
    links: format.links,
  };
}
