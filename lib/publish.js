/**
 * dsh-slipway · publish —— 编排层：自检 → 建仓 → 逐文件上传 → 市场条目 PR → 线上逐字节回验。
 *
 * 纪律（都写进 README，也一样是代码的边界）：
 *   - **默认 dry-run**：不给 `dryRun: false` 就只演算、只报告，不动任何远端；
 *   - **目标必须显式给**：owner / repo / category / 两种描述全都由调用方提供；
 *     缺一个就报错，绝不从目录名或包名去猜；
 *   - **幂等**：仓库已存在不重建、分支已存在不重开、PR 已有就报它的号；
 *   - **每一步留证据**：文件数、字节数、短 sha、PR 号、线上回验的 sha256 比对结果。
 *
 * @module dsh-slipway/publish
 */

import { join } from 'node:path';
import {
  CATEGORIES,
  buildMarketYml,
  collectFiles,
  detectLiveTree,
  marketEntryPath,
  preflight,
  readManifest,
  sha256,
} from './core.js';

/** 市场收录仓库（上游）。 */
export const DEFAULT_UPSTREAM = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin', branch: 'main' };

/** 默认 topics：市场靠 `dsh-plugin` 认亲。 */
export const DEFAULT_TOPICS = ['dsh-plugin', 'deepseek-harness'];

/** 造一条阶段记录。 */
function phase(name, status, detail, extra = {}) {
  return { name, status, detail, ...extra };
}

/** 参数体检：**必填的一个都不能少，不做任何补全与猜测**。 */
export function validateInput(input = {}) {
  const errors = [];
  if (typeof input.projectDir !== 'string' || input.projectDir.trim() === '') {
    errors.push('projectDir 必填：本地工程目录的**绝对路径**');
  }
  if (typeof input.repo !== 'string' || input.repo.trim() === '') {
    errors.push('repo 必填：GitHub 上的仓库名（也叫市场条目名）');
  } else if (!/^[A-Za-z0-9._-]+$/.test(input.repo)) {
    errors.push(`repo 只能含字母数字与 . _ -：${input.repo}`);
  }
  if (typeof input.owner !== 'string' || input.owner.trim() === '') {
    if (input.ownerFromToken !== true) {
      errors.push('owner 必填（或显式写 ownerFromToken: true 表示"用 token 本人的账号"）');
    }
  } else if (!/^[A-Za-z0-9._-]+$/.test(input.owner)) {
    errors.push(`owner 只能含字母数字与 . _ -：${input.owner}`);
  }
  if (!CATEGORIES.includes(String(input.category ?? ''))) {
    errors.push(`category 必填且必须是市场分类之一（${CATEGORIES.join(', ')}）`);
  }
  if (typeof input.descriptionEn !== 'string' || input.descriptionEn.trim() === '') {
    errors.push('descriptionEn 必填（不自动生成 —— 市场条目上的英文简介由人给）');
  }
  if (typeof input.descriptionZh !== 'string' || input.descriptionZh.trim() === '') {
    errors.push('descriptionZh 必填（同上）');
  }
  return errors;
}

/**
 * 只读地算出「要发什么」：读清单、收集文件、自检、探测活代码树。
 * dry-run 与真跑共用它 —— 保证"演的"和"跑的"是同一份计划。
 * @param {object} input 参数
 * @param {object} [deps] 依赖
 * @returns {Promise<object>} 计划
 */
export async function buildPlan(input = {}, deps = {}) {
  // 活代码检测的兜底放在**最里面**：调用方漏传一次，这条警告就整个失效
  // （实测：CLI 的 plan 一开始就漏了，活代码工程上照样不出警告）
  const profileNodeModules = deps.profileNodeModules
    ?? (process.env.DSH_SLIPWAY_PROFILE_NODE_MODULES
      || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop', 'node_modules'));

  const projectDir = String(input.projectDir ?? '');
  const manifestRes = await readManifest(projectDir);
  if (manifestRes.ok !== true) return { ok: false, error: manifestRes.error };

  const manifest = manifestRes.manifest;
  const collected = await collectFiles(projectDir, manifest);
  const liveTree = await detectLiveTree(projectDir, profileNodeModules);
  const checks = await preflight({
    projectDir,
    manifest,
    files: collected.files,
    missing: collected.missing,
    liveTree,
    repo: typeof input.repo === 'string' ? input.repo : undefined,
  });
  return {
    ok: true,
    projectDir,
    manifest,
    files: collected.files,
    missing: collected.missing,
    liveTree,
    checks,
    total: collected.total,
  };
}

/** 把计划压成便于阅读与断言的摘要（不含文件内容）。 */
export function summarizePlan(plan) {
  return {
    projectDir: plan.projectDir,
    name: plan.manifest?.name ?? null,
    version: plan.manifest?.version ?? null,
    files: plan.files.map((f) => ({ path: f.path, bytes: f.bytes })),
    totalBytes: plan.total,
    errors: plan.checks.errors,
    warnings: plan.checks.warnings,
    notes: plan.checks.notes,
    liveTree: plan.liveTree,
  };
}

/**
 * 线上逐字节回验：把仓库里的文件拉回来，比 sha256 与长度。
 * @param {object} args 参数
 * @param {object} deps 依赖
 * @returns {Promise<{checked:number, mismatched:Array, missing:Array, ok:boolean}>} 比对结果
 */
export async function verifyPublished({ owner, repo, files }, { github }) {
  const mismatched = [];
  const missing = [];
  let checked = 0;

  for (const file of files) {
    const entry = await github.getFile(owner, repo, file.path);
    if (!entry) {
      missing.push(file.path);
      continue;
    }
    let buf = null;
    if (typeof entry.content === 'string' && entry.content !== '') {
      buf = Buffer.from(entry.content.replace(/\s+/g, ''), 'base64');
    } else if (typeof entry.git_url === 'string' && entry.git_url !== '') {
      // >1MB 的文件 contents API 不给 content，退回 blob API
      const blob = await github.request('GET', entry.git_url.replace('https://api.github.com', ''));
      if (blob.ok === true && typeof blob.json?.content === 'string') {
        buf = Buffer.from(blob.json.content.replace(/\s+/g, ''), 'base64');
      }
    }
    if (buf === null) {
      mismatched.push({ path: file.path, reason: '线上拿不到内容' });
      continue;
    }
    checked += 1;
    const got = sha256(buf);
    const want = sha256(file.content);
    if (got !== want || buf.length !== file.bytes) {
      mismatched.push({
        path: file.path,
        reason: `sha256 不一致（线上 ${got.slice(0, 12)} vs 本地 ${want.slice(0, 12)}）`,
        remoteBytes: buf.length,
        localBytes: file.bytes,
      });
    }
  }
  return { checked, mismatched, missing, ok: mismatched.length === 0 && missing.length === 0 };
}

/**
 * 干活：把本地工程发到 GitHub，并（可选）开一条市场收录 PR，最后线上回验。
 * @param {object} input 参数（见 README 的参数表）
 * @param {object} deps 依赖：`{ github, profileNodeModules }`
 * @returns {Promise<object>} 结果 `{ ok, dryRun, phases, errors, plan, owner, repo }`
 */
export async function publishPlugin(input = {}, deps = {}) {
  const dryRun = input.dryRun !== false; // **默认 true**
  const phases = [];

  const inputErrors = validateInput(input);
  if (inputErrors.length > 0) {
    return { ok: false, dryRun, phases, errors: inputErrors };
  }

  const plan = await buildPlan(input, deps);
  if (plan.ok !== true) {
    return { ok: false, dryRun, phases, errors: [plan.error] };
  }

  const blocking = plan.checks.errors;
  phases.push(phase(
    'preflight',
    blocking.length > 0 ? 'error' : (plan.checks.warnings.length > 0 ? 'warn' : 'ok'),
    `${plan.files.length} 个文件、共 ${(plan.total / 1024).toFixed(1)}KB`
      + (plan.checks.errors.length > 0 ? `｜${plan.checks.errors.length} 项阻断` : '')
      + (plan.checks.warnings.length > 0 ? `｜${plan.checks.warnings.length} 项提醒` : ''),
    { errors: plan.checks.errors, warnings: plan.checks.warnings, notes: plan.checks.notes },
  ));
  if (blocking.length > 0) {
    return { ok: false, dryRun, phases, errors: blocking.map((e) => e.message), plan: summarizePlan(plan) };
  }

  const github = deps.github;
  if (!github) {
    return { ok: false, dryRun, phases, errors: ['没有可用的 GitHub 客户端：token 读不到或为空'] };
  }

  let me;
  try {
    me = await github.whoami();
  } catch (err) {
    return { ok: false, dryRun, phases, errors: [`token 自检失败：${err instanceof Error ? err.message : String(err)}`] };
  }
  const owner = typeof input.owner === 'string' && input.owner !== '' ? input.owner : me.login;
  if (owner !== me.login) {
    return {
      ok: false,
      dryRun,
      phases,
      errors: [`owner 与 token 本人对不上：你给的是 ${owner}，token 属于 ${me.login} —— 不猜，直接停`],
    };
  }
  const repo = input.repo;

  try {
    // ① 仓库
    const existingRepo = await github.getRepo(owner, repo);
    if (existingRepo) {
      phases.push(phase('repo', 'ok', `仓库已存在：${owner}/${repo}（默认分支 ${existingRepo.default_branch}）`));
    } else if (dryRun) {
      phases.push(phase('repo', 'planned', `会新建仓库 ${owner}/${repo}（public、auto_init:false）`));
    } else {
      const created = await github.createRepo(repo, { description: input.descriptionEn, private: input.private === true });
      phases.push(phase('repo', 'ok', `已新建仓库 ${owner}/${repo}`, { url: created?.html_url ?? null }));
    }

    // ② 逐文件上传（每个文件都先查 sha，更新式写入）
    if (dryRun) {
      phases.push(phase('upload', 'planned', `会推送 ${plan.files.length} 个文件、共 ${(plan.total / 1024).toFixed(1)}KB`, {
        files: summarizePlan(plan).files,
      }));
    } else {
      const uploaded = [];
      for (const file of plan.files) {
        const existing = await github.getFile(owner, repo, file.path);
        const res = await github.putFile(owner, repo, file.path, {
          content: file.content,
          message: `${input.messagePrefix ?? 'Publish'} ${file.path}`,
          sha: existing?.sha,
        });
        uploaded.push({ path: file.path, bytes: file.bytes, blob: String(res?.content?.sha ?? '').slice(0, 7) });
      }
      phases.push(phase('upload', 'ok', `已推送 ${uploaded.length} 个文件`, { uploaded }));
    }

    // ③ topics
    const topics = Array.isArray(input.topics) && input.topics.length > 0 ? input.topics : DEFAULT_TOPICS;
    if (dryRun) {
      phases.push(phase('topics', 'planned', `会设置 topics：${topics.join(', ')}`));
    } else {
      await github.setTopics(owner, repo, topics);
      phases.push(phase('topics', 'ok', topics.join(', ')));
    }

    // ④ 市场条目 PR
    const market = input.market ?? {};
    if (market.enabled === false) {
      phases.push(phase('market', 'skipped', '调用方关了（market.enabled=false）'));
    } else {
      const upstream = { ...DEFAULT_UPSTREAM, ...(market.upstream ?? {}) };
      const forkOwner = market.forkOwner ?? me.login;
      const branch = market.branch ?? `add-${owner}-${repo}`;
      const entryPath = marketEntryPath(owner, repo);
      const yml = buildMarketYml({
        url: `https://github.com/${owner}/${repo}`,
        name: repo,
        category: input.category,
        descriptionEn: input.descriptionEn,
        descriptionZh: input.descriptionZh,
      });
      const prTitle = `Add ${owner}/${repo} (${input.category})`;

      const existingPr =
        (await github.findPull(upstream.owner, upstream.repo, `${forkOwner}:${branch}`)) ??
        (await github.findPullByTitle(upstream.owner, upstream.repo, `${owner}/${repo}`));
      if (existingPr) {
        phases.push(phase('market', 'ok', `PR 已存在：#${existingPr.number}（${existingPr.state}）`, {
          pr: { number: existingPr.number, state: existingPr.state, url: existingPr.html_url },
        }));
      } else if (dryRun) {
        phases.push(phase('market', 'planned', `会 fork(若无) → 从 ${upstream.branch} 建分支 ${forkOwner}:${branch} → 写 ${entryPath} → 开 PR「${prTitle}」`, { yml }));
      } else {
        const forkRepo = await github.getRepo(forkOwner, upstream.repo);
        if (!forkRepo) {
          await github.request('POST', `/repos/${upstream.owner}/${upstream.repo}/forks`, {});
          phases.push(phase('fork', 'ok', `已 fork ${upstream.owner}/${upstream.repo} → ${forkOwner}`));
        }
        // 分支要在 **fork 自己的**基线上建：上游 head 可能还没同步进 fork，
        // 拿上游 sha 去 fork 建 ref 会 404（fork 落后时必然发生）。fork 读不到再退回上游。
        const baseSha =
          (await github.getRef(forkOwner, upstream.repo, upstream.branch)) ??
          (await github.getRef(upstream.owner, upstream.repo, upstream.branch));
        if (!baseSha) {
          phases.push(phase('market', 'error', `拿不到上游 ${upstream.owner}/${upstream.repo}:${upstream.branch} 的 head sha`));
          return { ok: false, dryRun, phases, errors: ['上游分支读不到'], owner, repo };
        }
        await github.createBranch(forkOwner, upstream.repo, branch, baseSha);
        const existingEntry = await github.getFile(forkOwner, upstream.repo, entryPath, branch);
        await github.putFile(forkOwner, upstream.repo, entryPath, {
          content: Buffer.from(yml, 'utf8'),
          message: `Add ${owner}/${repo}`,
          branch,
          sha: existingEntry?.sha,
        });
        const pr = await github.createPull(upstream.owner, upstream.repo, {
          title: prTitle,
          head: `${forkOwner}:${branch}`,
          base: upstream.branch,
          body: [
            `Adds [${owner}/${repo}](https://github.com/${owner}/${repo}) under \`${input.category}\`.`,
            '',
            input.descriptionEn,
            '',
            '---',
            input.descriptionZh,
          ].join('\n'),
        });
        phases.push(phase('market', 'ok', pr ? `PR #${pr.number} 已开` : `分支已推（PR 可能已存在）`, {
          pr: pr ? { number: pr.number, url: pr.html_url, state: pr.state } : null,
          entryPath,
        }));
      }
    }

    // ⑤ 线上逐字节回验
    if (dryRun) {
      phases.push(phase('verify', 'planned', `会逐文件拉回来比 sha256（${plan.files.length} 个）`));
    } else if (input.verify === false) {
      phases.push(phase('verify', 'skipped', '调用方关了（verify:false）'));
    } else {
      const res = await verifyPublished({ owner, repo, files: plan.files }, { github });
      phases.push(phase(
        'verify',
        res.ok ? 'ok' : 'error',
        res.ok
          ? `${res.checked} 个文件线上 sha256 与本地完全一致`
          : `有 ${res.mismatched.length + res.missing.length} 个文件对不上`,
        res,
      ));
      if (!res.ok) {
        return { ok: false, dryRun, phases, errors: ['线上回验不通过'], owner, repo, plan: summarizePlan(plan) };
      }
    }

    return { ok: true, dryRun, phases, errors: [], owner, repo, plan: summarizePlan(plan) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    phases.push(phase('error', 'error', message));
    return { ok: false, dryRun, phases, errors: [message], owner, repo, plan: summarizePlan(plan) };
  }
}
