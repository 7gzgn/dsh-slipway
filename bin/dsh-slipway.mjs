#!/usr/bin/env node
/**
 * dsh-slipway · CLI —— 不开会话也能发。
 *
 *   dsh-slipway plan    --project <绝对路径> --repo <名> --category <类> --desc-en "…" --desc-zh "…"
 *   dsh-slipway publish … [--go]        # 不给 --go 就是 dry-run
 *   dsh-slipway verify  --project <绝对路径> --repo <名> --owner <账号>
 *
 * 退出码：0 = 成功 / dry-run 通过；1 = 有阻断；2 = 用法错误。
 *
 * @module dsh-slipway/bin
 */

import { createGitHub } from '../lib/github.js';
import { buildPlan, publishPlugin, summarizePlan, verifyPublished } from '../lib/publish.js';
import { resolveToken } from '../lib/index.js';

/** 极简参数解析：`--key value` 与 `--flag`。 */
function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

const USAGE = `dsh-slipway —— 把本地插件工程发到 GitHub 与市场

用法：
  dsh-slipway plan    --project <绝对路径> --repo <名> --category <类> --desc-en "…" --desc-zh "…"
  dsh-slipway publish --project … --repo … --category … --desc-en … --desc-zh … [--go] [--owner <账号>] [--token-file <路径>] [--no-market] [--no-verify]
  dsh-slipway verify  --project <绝对路径> --repo <名> --owner <账号>

说明：
  · 不给 --go 就是 dry-run（只演算、只报告，什么都不动）。
  · category 必须属于市场分类；全部 ${23} 类见 README。
  · token 依次找：--token-file → env DSH_SLIPWAY_TOKEN_FILE → ~/.dsh/.gh-token → D:\\dsh\\.gh-token
`;

/** 打印阶段报告（与工具输出同一套口径，简单版）。 */
function printPhases(result) {
  const mark = { ok: '✅', warn: '⚠️', error: '❌', planned: '🧪', skipped: '⏭️' };
  console.log(`${result.dryRun ? '🧪 dry-run' : '🚢 真跑'}｜${result.ok ? '成功' : '未完成'}`);
  for (const p of result.phases ?? []) {
    console.log(`  ${mark[p.status] ?? '·'} ${p.name}：${p.detail}`);
    for (const w of p.warnings ?? []) console.log(`      ⚠️ ${w.message}`);
    for (const n of p.notes ?? []) console.log(`      · ${n.message}`);
  }
  for (const e of result.errors ?? []) console.log(`  ❌ ${e}`);
  if (result.plan?.files) {
    console.log(`  文件清单（${result.plan.files.length} 个，共 ${(result.plan.totalBytes / 1024).toFixed(1)}KB）：`);
    for (const f of result.plan.files) console.log(`      · ${f.path}（${f.bytes} 字节）`);
  }
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0] ?? 'plan';

  if (cmd === 'help' || argv.help === true) {
    console.log(USAGE);
    return 0;
  }

  const { token, from } = await resolveToken(argv['token-file']);
  const client = token === null ? null : createGitHub({ token });
  if (client !== null) console.log(`token：${client.tokenHint}（来自 ${from}）`);

  const base = {
    projectDir: argv.project,
    repo: argv.repo,
    owner: argv.owner,
    ownerFromToken: argv.owner === undefined,
    category: argv.category,
    descriptionEn: argv['desc-en'],
    descriptionZh: argv['desc-zh'],
  };

  if (cmd === 'plan') {
    const plan = await buildPlan(base, {});
    if (plan.ok !== true) {
      console.error(`❌ ${plan.error}`);
      return 1;
    }
    const summary = summarizePlan(plan);
    console.log(`工程：${summary.projectDir}`);
    console.log(`包名：${summary.name}@${summary.version}`);
    console.log(`文件：${summary.files.length} 个、共 ${(summary.totalBytes / 1024).toFixed(1)}KB`);
    for (const f of summary.files) console.log(`  · ${f.path}（${f.bytes} 字节）`);
    for (const n of summary.notes) console.log(`  · ${n.message}`);
    for (const w of summary.warnings) console.log(`  ⚠️ ${w.message}`);
    for (const e of summary.errors) console.log(`  ❌ ${e.message}`);
    return summary.errors.length > 0 ? 1 : 0;
  }

  if (cmd === 'publish') {
    if (client === null) {
      console.error('❌ PAT 读不到（试过 --token-file / env / ~/.dsh/.gh-token / D:\\dsh\\.gh-token）');
      return 2;
    }
    const result = await publishPlugin({
      ...base,
      dryRun: argv.go !== true,
      market: { enabled: argv['no-market'] !== true },
      verify: argv['no-verify'] !== true,
      messagePrefix: argv['message-prefix'],
    }, { github: client });
    printPhases(result);
    return result.ok === true ? 0 : 1;
  }

  if (cmd === 'verify') {
    if (client === null) {
      console.error('❌ PAT 读不到');
      return 2;
    }
    const plan = await buildPlan(base, {});
    if (plan.ok !== true) {
      console.error(`❌ ${plan.error}`);
      return 1;
    }
    const res = await verifyPublished({ owner: base.owner, repo: base.repo, files: plan.files }, { github: client });
    console.log(`比对 ${res.checked} 个文件：${res.ok ? '✅ 全部一致' : '❌ 有不一致'}`);
    for (const m of res.missing) console.log(`  ❌ 线上缺：${m}`);
    for (const m of res.mismatched) console.log(`  ❌ ${m.path}：${m.reason}`);
    return res.ok ? 0 : 1;
  }

  console.error(`未知子命令：${cmd}\n\n${USAGE}`);
  return 2;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
