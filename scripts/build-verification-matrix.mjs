#!/usr/bin/env node
/**
 * 正式规格基线的场景→测试矩阵生成脚本。
 *
 * 职责：
 * 1. 扫描 openspec/specs 下各能力的 spec.md，
 *    提取每个能力的 Requirement / Scenario。
 * 2. 读取 docs/verification/scenario-map.mjs 登记表（场景→测试证据 + 状态/备注）。
 * 3. 校验登记表证据真实性：测试文件的关键词必须出现在 it()/test()/describe() 标题字面量；
 *    README 和说明文档证据可全文匹配。找不到证据的场景如实标记为“缺证据”，不谎称覆盖。
 * 4. 生成 docs/verification/scenario-test-matrix.md，包含汇总统计、按能力分组对照表。
 *
 * active 或 archived change 的 delta 由各自的 `openspec validate <change> --strict`
 * 验证；只有归档或同步进入 openspec/specs/ 的场景才进入本矩阵。
 *
 * 运行：npm run verify:matrix
 * 存在缺证据/证据无效时以非 0 退出，作为 CI 可执行校验。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const specsDir = join(repoRoot, 'openspec', 'specs');
const registryUrl = new URL('../docs/verification/scenario-map.mjs', import.meta.url);
const outputPath = join(repoRoot, 'docs', 'verification', 'scenario-test-matrix.md');

const { scenarioMap } = await import(registryUrl.href);

/** 解析单份 spec 文件。 */
function parseSpec(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const capability = relative(specsDir, filePath).split('/')[0];
  const requirements = [];
  let current = null;
  for (const line of content.split('\n')) {
    const req = line.match(/^### Requirement: (.+)$/);
    const sc = line.match(/^#### Scenario: (.+)$/);
    if (req) {
      current = { title: req[1].trim(), scenarios: [] };
      requirements.push(current);
    } else if (sc && current) {
      current.scenarios.push(sc[1].trim());
    }
  }
  return { capability, requirements };
}

function listSpecFiles() {
  return readdirSync(specsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(specsDir, e.name, 'spec.md'))
    .filter((p) => existsSync(p))
    .sort();
}

function isTestSource(file) {
  return /^(?:tests|e2e)\/.*\.(?:ts|tsx)$/.test(file);
}

/** 提取 it/test/describe（含 .skip/.only/.todo）首个无插值字符串标题。 */
function testTitles(content) {
  const titles = [];
  const pattern = /\b(?:describe|it|test)(?:\.(?:skip|only|todo))*\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$])*)`)/g;
  for (const match of content.matchAll(pattern)) {
    const raw = match[1] ?? match[2] ?? match[3];
    try {
      titles.push(JSON.parse(`"${raw.replace(/"/g, '\\"')}"`));
    } catch {
      titles.push(raw);
    }
  }
  return titles;
}

/** 校验证据：测试源码仅匹配测试标题，文档证据可全文匹配。 */
function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return { valid: false, detail: '无证据' };
  const issues = [];
  for (const [file, keyword] of evidence) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) {
      issues.push(`${file}（文件不存在）`);
      continue;
    }
    const content = readFileSync(abs, 'utf-8');
    const found = Boolean(keyword) && (isTestSource(file) ? testTitles(content).some((title) => title.includes(keyword)) : content.includes(keyword));
    if (!keyword || !found) {
      issues.push(`${file}（标题中未找到「${keyword}」）`);
    }
  }
  return issues.length === 0 ? { valid: true } : { valid: false, detail: issues.join('；') };
}

const caps = listSpecFiles().map(parseSpec);
const rows = [];
let covered = 0;
let pending = 0;
let gap = 0;

for (const cap of caps) {
  const registry = scenarioMap[cap.capability] ?? {};
  for (const req of cap.requirements) {
    for (const scenario of req.scenarios) {
      const entry = registry[scenario];
      let status = 'unregistered';
      if (entry) {
        const check = validateEvidence(entry.evidence);
        status = check.valid ? 'covered' : 'invalid-evidence';
        if (entry.status === 'pending' && status === 'covered') status = 'pending';
      }
      rows.push({
        capability: cap.capability,
        requirement: req.title,
        scenario,
        status,
        evidence: entry?.evidence ?? [],
        note: entry?.note ?? '',
        issues: status === 'invalid-evidence' ? validateEvidence(entry.evidence).detail : '',
      });
      if (status === 'covered') covered += 1;
      else if (status === 'pending') pending += 1;
      else gap += 1;
    }
  }
}

const total = rows.length;
const lines = [];
lines.push('# 正式规格基线的场景→测试矩阵');
lines.push('');
lines.push('> 由 `npm run verify:matrix`（scripts/build-verification-matrix.mjs）自动生成，仅扫描 `openspec/specs/` 正式基线。');
lines.push('> 登记表：`docs/verification/scenario-map.mjs`。脚本校验每一条证据（文件存在且标题关键词出现），');
lines.push('> 找不到证据或证据无效时如实标记为缺口，不谎称覆盖。状态图例：✅ 有效证据 · ⏳ 待验证（真实源迁移/Windows）· ❌ 缺口。');
lines.push('');
lines.push('## 汇总');
lines.push('');
lines.push(`| 指标 | 数量 |`);
lines.push(`| --- | --- |`);
lines.push(`| 能力 spec 数 | ${caps.length} |`);
lines.push(`| ADDED Requirements 场景总数 | ${total} |`);
lines.push(`| 有有效测试证据（✅） | ${covered} |`);
lines.push(`| 待验证（⏳，真实源迁移 / Windows 验证） | ${pending} |`);
lines.push(`| 缺证据 / 证据无效（❌） | ${gap} |`);
lines.push('');
lines.push('### 待验证与阻塞项（诚实边界）');
lines.push('');
lines.push('| 项 | 状态 | 说明 |');
lines.push('| --- | --- | --- |');
lines.push('| 10.4/10.5 Windows 打包验证 | ⏳ | macOS 开发机 Electron E2E 已通过（e2e/electron-smoke.spec.ts、e2e/import-wizard-flow.spec.ts、e2e/import-worker-runtime.spec.ts）；Windows 安装包与 Windows 操作系统账户保护未验证 |');
lines.push('');
lines.push('## 按能力对照');
lines.push('');
for (const cap of caps) {
  lines.push(`### ${cap.capability}`);
  lines.push('');
  lines.push('| Requirement | Scenario | 状态 | 测试证据 | 备注 |');
  lines.push('| --- | --- | --- | --- | --- |');
  const capRows = rows.filter((r) => r.capability === cap.capability);
  for (const row of capRows) {
    const statusLabel = row.status === 'covered' ? '✅' : row.status === 'pending' ? '⏳' : '❌';
    const evidence =
      row.evidence.length > 0
        ? row.evidence.map(([file, kw]) => `\`${file}\`「${kw}」`).join('<br>')
        : '—';
    const note = row.note ? row.note.replace(/\|/g, '\\|') : '';
    lines.push(
      `| ${row.requirement.replace(/\|/g, '\\|')} | ${row.scenario.replace(/\|/g, '\\|')} | ${statusLabel} | ${evidence} | ${note} |`,
    );
  }
  lines.push('');
}

const invalid = rows.filter((r) => r.status !== 'covered' && r.status !== 'pending');
if (invalid.length > 0) {
  lines.push('## 缺口清单（缺证据或证据无效的场景）');
  lines.push('');
  lines.push('| 能力 | Scenario | 问题 |');
  lines.push('| --- | --- | --- |');
  for (const row of invalid) {
    lines.push(`| ${row.capability} | ${row.scenario} | ${row.issues || '未登记'} |`);
  }
  lines.push('');
}

writeFileSync(outputPath, lines.join('\n'), 'utf-8');
console.log(`矩阵已生成: ${relative(repoRoot, outputPath)}`);
console.log(`汇总: 总场景 ${total}，有效证据 ${covered}，待验证 ${pending}，缺口 ${gap}`);
if (invalid.length > 0) {
  console.error(`缺口: ${invalid.length} 个场景缺少有效证据或未登记`);
  process.exit(1);
}
