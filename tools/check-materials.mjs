import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { checkLinks, loadBundle, parseTable } from '../src/csv.mjs';

export { checkLinks, parseTable };

const folder = new URL('../fixtures/', import.meta.url);

export async function checkMaterials(source = folder) {
  const { tables } = await loadBundle(source);
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const counts = await checkMaterials();
  console.log(JSON.stringify({ 状态: '资料可读取', 记录数: counts }, null, 2));
}
