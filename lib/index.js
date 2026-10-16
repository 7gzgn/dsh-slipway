/**
 * dsh-slipway —— 宿主入口。
 *
 * 一句话：**把本地插件工程一条命令发到 GitHub、再开一条市场收录 PR，最后把线上文件逐字节拉回来比对。**
 *
 * 由来：前面三个作品每发一次，都要手写同一串脚本（建仓 → 逐文件 PUT → 打 topic →
 * fork 建分支 → 写登记 yml → 开 PR → 线上回拉校验），每次都掉同一个坑。这活该由代码干。
 *
 * 安全边界（README 里也写着）：
 *   - **默认 dry-run**：不显式给 `dryRun: false` 就只演算、只报告；
 *   - **目标必须显式给**：owner / repo / 分类 / 两种描述缺一不可，**不许猜**；
 *   - **token 永不进输出**：只出现前 4 位与长度的掩码；请求证据里只记方法与路径；
 *   - **幂等**：仓库、分支、PR 都先查再说，重复跑不会造出第二条。
 *
 * @module dsh-slipway
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createGitHub } from './github.js';
import { buildPlan, publishPlugin, summarizePlan, validateInput, verifyPublished } from './publish.js';
import { CATEGORIES } from './core.js';

/** 插件身份。 */
export const name = 'dsh-slipway';

/** 需要宿主提供的服务（拿不到就退化，不报错）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 206;
const TOOL_TIMEOUT_MS = 300000;

/** 面向模型的公告（常驻那一段）。 */
export const SLIPWAY_GUIDANCE = [
  '本机已安装 **dsh-slipway（滑道）**：`slipway_publish` 把本地插件工程发到 GitHub 并开一条市场收录 PR（逐文件上传 + 线上逐字节回验）；`slipway_verify` 只做线上回验。',
  '**默认 dry-run**：不给 `dryRun:false` 就只演算，先把报告给用户看，得到许可再真跑。',
  '**必填**：`projectDir`（绝对路径）、`repo`、`category`（市场分类）、`descriptionEn`、`descriptionZh` —— 一个都不许猜，缺了就报错。',
  'token 从 `--token-file` / env `DSH_SLIPWAY_TOKEN_FILE` / `~/.dsh/.gh-token` / `D:\\dsh\\.gh-token` 依次找；输出里只会出现掩码。',
  '**活代码树警告**：报告里若出现 `live-tree`，说明该工程被 profile 的 junction 挂着 —— 发布可以，**测试绝对不许在那里跑**（复制到沙箱再跑）。',
].join('\n');

/** 动态取 defineTool：宿主里有就用真的，单测/CLI 场景退化成恒等。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 找 PAT：显式路径 → 环境变量 → 本机约定位置。
 * @param {string} [explicit] 显式路径
 * @returns {Promise<{token:string|null, from:string|null}>} token 与出处
 */
export async function resolveToken(explicit) {
  const candidates = [];
  if (typeof explicit === 'string' && explicit !== '') candidates.push(explicit);
  if (typeof process.env.DSH_SLIPWAY_TOKEN_FILE === 'string' && process.env.DSH_SLIPWAY_TOKEN_FILE !== '') {
    candidates.push(process.env.DSH_SLIPWAY_TOKEN_FILE);
  }
  candidates.push(join(homedir(), '.dsh', '.gh-token'));
  candidates.push('D:\\dsh\\.gh-token');
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8');
      const token = text.trim();
      if (token !== '') return { token, from: file };
    } catch {
      /* 换下一个 */
    }
  }
  return { token: null, from: null };
}

/** 把 `a,b` 解析成数组（工具参数用逗号串，避免数组 schema 的兼容问题）。 */
function parseList(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** 默认 profile 的 node_modules（用来判定活代码树）。 */
function defaultProfileNodeModules() {
  const fromEnv = process.env.DSH_SLIPWAY_PROFILE_NODE_MODULES;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');
}

const STATUS_MARK = { ok: '✅', warn: '⚠️', error: '❌', planned: '🧪', skipped: '⏭️' };

/** 把一次 publish 的结果渲染成人话。 */
export function renderPublish(value) {
  const lines = [];
  const head = value.dryRun ? '🧪 dry-run（什么都没动）' : '🚢 真跑';
  lines.push(`slipway_publish｜${value.ok === true ? '成功' : '未完成'}｜${head}`);
  if (value.owner || value.repo) lines.push(`  目标：${value.owner ?? '?'}/${value.repo ?? '?'}`);
  for (const p of value.phases ?? []) {
    lines.push(`  ${STATUS_MARK[p.status] ?? '·'} ${p.name}：${p.detail}`);
    for (const w of p.warnings ?? []) lines.push(`      ⚠️ ${w.message}`);
    for (const n of p.notes ?? []) lines.push(`      · ${n.message}`);
    if (Array.isArray(p.uploaded) && p.uploaded.length > 0) {
      const total = p.uploaded.reduce((sum, f) => sum + f.bytes, 0);
      lines.push(`      · ${p.uploaded.length} 个文件、共 ${(total / 1024).toFixed(1)}KB`);
    }
  }
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    lines.push('  阻断项：');
    for (const e of value.errors) lines.push(`      ❌ ${e}`);
  }
  if (value.plan?.files && value.dryRun === true) {
    lines.push(`  文件清单（${value.plan.files.length} 个）：`);
    for (const f of value.plan.files.slice(0, 30)) lines.push(`      · ${f.path}（${f.bytes} 字节）`);
    if (value.plan.files.length > 30) lines.push(`      …还有 ${value.plan.files.length - 30} 个`);
  }
  lines.push(value.dryRun
    ? '  → 确认无误后，用 `dryRun:false` 再来一次才会真正动手。'
    : '  → 线上已逐字节回验；收录 PR 需要维护者合并，别催、别重复开。');
  return lines.join('\n');
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {object} [config] 插件配置
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const disposers = [];
  const profileNodeModules = cfg.profileNodeModules ?? defaultProfileNodeModules();

  /** 组一个 GitHub 客户端；没 token 就返回 null（调用方会说明原因）。 */
  async function clientFor(tokenFile) {
    const { token } = await resolveToken(tokenFile ?? cfg.tokenFile);
    if (token === null) return null;
    return createGitHub({ token });
  }

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'slipway_publish',
      description: [
        '把本地插件工程发到 GitHub，并（默认）向市场收录仓库开一条 PR，最后把线上文件逐个拉回来比 sha256。',
        '**默认 dry-run**：只演算 + 报告，什么都不动；确认后再传 dryRun:false。',
        '目标必须显式给：projectDir（绝对路径）、repo、category、descriptionEn、descriptionZh —— 缺一样就报错，绝不猜。',
        '典型用法：dryRun 先跑一次 → 把报告给用户看 → 得到许可 → dryRun:false。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        projectDir: { type: 'string', description: '本地工程目录的绝对路径（必须含 package.json）' },
        repo: { type: 'string', description: 'GitHub 仓库名（= 市场条目名），只含字母数字与 . _ -' },
        owner: { type: 'string', description: 'GitHub 账号（不填则必须显式写 ownerFromToken:true）' },
        ownerFromToken: { type: 'boolean', description: 'true = owner 用 token 本人的账号（读事实，不是猜）' },
        category: { type: 'string', description: `市场分类，必须是：${CATEGORIES.join(', ')}` },
        descriptionEn: { type: 'string', description: '市场条目英文简介（不自动生成）' },
        descriptionZh: { type: 'string', description: '市场条目中文简介（不自动生成）' },
        dryRun: { type: 'boolean', description: '默认 true = 只演算；false = 真动远端' },
        market: { type: 'boolean', description: '是否开市场收录 PR（默认 true）' },
        verify: { type: 'boolean', description: '是否做线上逐字节回验（默认 true）' },
        topics: { type: 'string', description: '要设置的 topics，逗号分隔（默认 dsh-plugin,deepseek-harness）' },
        tokenFile: { type: 'string', description: 'PAT 文件路径（不填则按 env / ~/.dsh / D:\\dsh 依次找）' },
        messagePrefix: { type: 'string', description: '逐文件提交信息的前缀（默认 Publish）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            data: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.ok === false && value.data === undefined
            ? `slipway_publish 失败：${String(value.error ?? '未知错误')}`
            : renderPublish(value.data ?? {}),
        }],
      },
      async execute(args) {
        const a = args ?? {};
        const client = await clientFor(a.tokenFile);
        const input = {
          projectDir: a.projectDir,
          repo: a.repo,
          owner: a.owner,
          ownerFromToken: a.ownerFromToken === true,
          category: a.category,
          descriptionEn: a.descriptionEn,
          descriptionZh: a.descriptionZh,
          dryRun: a.dryRun !== false,
          market: { enabled: a.market !== false },
          verify: a.verify !== false,
          topics: parseList(a.topics),
          messagePrefix: a.messagePrefix,
        };
        try {
          const result = await publishPlugin(input, { github: client, profileNodeModules });
          // **不能**写 `error: undefined`：宿主用 lossless-JSON 校验返回对象，
          // JSON.stringify 会悄悄丢掉 undefined，校验器不会 —— 会被判 "invalid output"。
          const out = { ok: result.ok === true, data: result };
          if (out.ok !== true) out.error = String((result.errors ?? [])[0] ?? '未完成');
          return out;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    })));

    disposers.push(ctx.tools.register(defineTool({
      name: 'slipway_verify',
      description: [
        '只读回验：把 GitHub 仓库里已发布的文件逐个拉回来，与本地工程比 sha256 与长度。',
        '用来回答"线上那份和我手里这份是不是同一份" —— 不看 size 字段，看内容。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        projectDir: { type: 'string', description: '本地工程目录的绝对路径' },
        repo: { type: 'string', description: 'GitHub 仓库名' },
        owner: { type: 'string', description: 'GitHub 账号' },
        tokenFile: { type: 'string', description: 'PAT 文件路径（可选）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            data: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok === false) return [{ type: 'text', text: `slipway_verify 失败：${String(value.error ?? '未知错误')}` }];
          const d = value.data ?? {};
          const lines = [`slipway_verify｜${d.ok === true ? '✅ 线上与本地逐字节一致' : '❌ 有不一致'}`];
          lines.push(`  · 目标：${d.owner}/${d.repo}`);
          lines.push(`  · 比对：${d.checked} 个文件通过`);
          for (const m of d.missing ?? []) lines.push(`  ❌ 线上缺文件：${m}`);
          for (const m of d.mismatched ?? []) lines.push(`  ❌ ${m.path}：${m.reason}`);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const a = args ?? {};
        const inputErrors = validateInput({
          projectDir: a.projectDir,
          repo: a.repo,
          owner: a.owner,
          category: 'tools',
          descriptionEn: 'verify',
          descriptionZh: 'verify',
        }).filter((e) => !e.includes('description') && !e.includes('category'));
        if (inputErrors.length > 0) return { ok: false, error: inputErrors.join('；') };
        const client = await clientFor(a.tokenFile);
        if (client === null) return { ok: false, error: 'PAT 读不到（试过 env / ~/.dsh/.gh-token / D:\\dsh\\.gh-token）' };
        try {
          const plan = await buildPlan({ projectDir: a.projectDir, repo: a.repo }, { profileNodeModules });
          if (plan.ok !== true) return { ok: false, error: plan.error };
          const res = await verifyPublished({ owner: a.owner, repo: a.repo, files: plan.files }, { github: client });
          // 同上：**不能**留 undefined 字段（lossless-JSON 校验会拒）
          const out = { ok: res.ok === true, data: { ...res, owner: a.owner, repo: a.repo, plan: summarizePlan(plan) } };
          if (out.ok !== true) out.error = '存在不一致';
          return out;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:slipway',
      order: SECTION_ORDER,
      text: SLIPWAY_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-slipway: teardown');
  }
}
