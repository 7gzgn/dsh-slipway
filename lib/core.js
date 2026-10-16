/**
 * dsh-slipway · core —— 纯逻辑层：读工程、自检、收集要发布的文件、扫敏感串、拼市场条目。
 *
 * 这一层**不碰网络、不写任何东西**（只读磁盘），所以能在沙箱里随便跑。
 *
 * 「目标必须显式指认」在这里落地：owner / repo / 分类 / 描述统统由调用方给；
 * 解析不出来就**报错**，绝不从当前工作目录、包名相似度或"看起来像"去猜。
 *
 * @module dsh-slipway/core
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, readlink } from 'node:fs/promises';
import { join, isAbsolute, sep } from 'node:path';

/** 市场分类白名单（2026-10-16 从 registry.categories 实读的 23 类）。 */
export const CATEGORIES = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools',
  'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify',
  'dev', 'security', 'remote', 'market', 'fun',
];

/** 无论 files 白名单怎么写，都一定要推上去的文件。 */
const ALWAYS_SHIP = ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'LICENSE.md'];

/** 收集文件时永远跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', 'coverage', '.cache', 'dist']);

/** GitHub contents API 的单文件软上限（超过 1MB 用普通 PUT 也在允许范围，但值得提醒）。 */
const SOFT_FILE_LIMIT = 1024 * 1024;
/** 硬上限：超过就走 Git Data API 了，v0.1 不收。 */
const HARD_FILE_LIMIT = 25 * 1024 * 1024;

/** 敏感串规则。命中即**拒绝发布**，且只报位置与掩码，不打印明文。 */
const SECRET_RULES = [
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'github-pat', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { kind: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'deepseek-key', re: /\bsk-[0-9a-f]{32}\b/i },
];

/** 去掉 UTF-8 BOM（本机不少 JSON 带它，`JSON.parse` 会直接炸）。 */
export function stripBom(text) {
  return typeof text === 'string' ? text.replace(/^\uFEFF/, '') : text;
}

/** 解析可能带 BOM 的 JSON。 */
export function parseJsonLoose(text) {
  return JSON.parse(stripBom(String(text)));
}

/** 内容 sha256（十六进制）——「线上是不是同一份」用它比对，比长度硬。 */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 把路径归一化：去 `\\?\` 前缀、统一分隔符、去尾斜杠、小写（Windows 比较用）。 */
export function normPath(p) {
  let s = String(p ?? '').replace(/^\\\\\?\\/, '').replace(/[\\/]+/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

/** 脱敏显示 token：只留前 4 位与长度。输出里**永远**用这个，绝不打印原文。 */
export function maskToken(token) {
  const s = String(token ?? '');
  if (s === '') return '(none)';
  return `${s.slice(0, 4)}****(${s.length})`;
}

/** 在文本里找敏感串；返回位置与掩码（**不含明文**）。 */
export function scanSecrets(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(lines[i]);
      if (m) {
        const raw = m[0];
        out.push({
          kind: rule.kind,
          line: i + 1,
          masked: `${raw.slice(0, 4)}…${raw.slice(-2)}(${raw.length})`,
        });
      }
    }
  }
  return out;
}

/** 把 files 白名单里的一项转成正则：目录名 = 该目录下全部文件；支持 `*` 与 `**`。 */
export function globToRegExp(pattern) {
  const norm = String(pattern ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (norm === '') return /^$/;
  let src = '';
  for (let i = 0; i < norm.length; i += 1) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') {
        src += '.*';
        i += 1;
        if (norm[i + 1] === '/') i += 1;
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // 目录名天然匹配其下所有文件
  return new RegExp(`^(?:${src})(?:/.*)?$`);
}

/** 递归列出目录下的文件（相对路径、`/` 分隔）；不跟符号链接出去。 */
async function walk(dir, prefix = '', out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await walk(full, rel, out);
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** 读工程的 package.json；失败时给出人能看懂的原因。 */
export async function readManifest(projectDir) {
  const file = join(projectDir, 'package.json');
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    return { ok: false, error: `读不到 package.json：${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { ok: true, manifest: parseJsonLoose(text) };
  } catch (err) {
    return { ok: false, error: `package.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * 按 `files` 白名单 + 必带文件收集要发布的全部文件。
 * @param {string} projectDir 工程目录
 * @param {object} manifest package.json 内容
 * @returns {Promise<{files:Array<{path:string,bytes:number,content:Buffer}>, missing:string[], total:number}>} 收集结果
 */
export async function collectFiles(projectDir, manifest) {
  const all = await walk(projectDir);
  const wanted = new Set();
  const missing = [];

  for (const name of ALWAYS_SHIP) {
    if (all.includes(name)) wanted.add(name);
  }

  const patterns = Array.isArray(manifest?.files) ? manifest.files : [];
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    const hit = all.filter((rel) => re.test(rel));
    if (hit.length === 0) missing.push(String(pattern));
    for (const rel of hit) wanted.add(rel);
  }

  const files = [];
  let total = 0;
  for (const rel of [...wanted].sort()) {
    const content = await readFile(join(projectDir, rel));
    files.push({ path: rel, bytes: content.length, content });
    total += content.length;
  }
  return { files, missing, total };
}

/**
 * 探测工程目录是不是「活代码树」：被 profile 的 junction 挂进 node_modules 的工程。
 * 活代码树里跑测试 = 在真宿主上生效（2026-10-16 的六次重启事故就是这么来的）。
 * @param {string} projectDir 工程目录
 * @param {string} profileNodeModules 形如 `C:\Users\x\.dsh\profiles\desktop\node_modules`
 * @returns {Promise<{checked:boolean, hits:Array<{name:string,target:string}>}>} 结果
 */
export async function detectLiveTree(projectDir, profileNodeModules) {
  const hits = [];
  if (typeof profileNodeModules !== 'string' || profileNodeModules === '') {
    return { checked: false, hits };
  }
  let entries;
  try {
    entries = await readdir(profileNodeModules, { withFileTypes: true });
  } catch {
    return { checked: false, hits };
  }
  const target = normPath(projectDir);
  for (const entry of entries) {
    const full = join(profileNodeModules, entry.name);
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    let link = null;
    try {
      link = await readlink(full);
    } catch {
      continue;
    }
    const linkNorm = normPath(link);
    if (linkNorm === target || target.startsWith(`${linkNorm}/`) || linkNorm.startsWith(`${target}/`)) {
      hits.push({ name: entry.name, target: String(link) });
    }
  }
  return { checked: true, hits };
}

/**
 * 发布前自检。
 * @param {object} args 参数
 * @param {string} args.projectDir 工程目录
 * @param {object} args.manifest package.json
 * @param {Array<{path:string,bytes:number,content:Buffer}>} args.files 收集到的文件
 * @param {string[]} args.missing 没匹配到任何文件的白名单项
 * @param {object} [args.liveTree] detectLiveTree 的结果
 * @param {string} [args.repo] 目标仓库名（用来核对 package.json 里的 repository）
 * @returns {Promise<{errors:Array, warnings:Array, notes:Array}>} 自检结论
 */
export async function preflight({ projectDir, manifest, files, missing, liveTree, repo }) {
  const errors = [];
  const warnings = [];
  const notes = [];

  if (!isAbsolute(String(projectDir ?? ''))) {
    errors.push({ code: 'dir-not-absolute', message: 'projectDir 必须是绝对路径（不许靠相对路径猜）' });
  }
  if (!manifest || typeof manifest !== 'object') {
    errors.push({ code: 'no-manifest', message: 'package.json 读不到或不是对象' });
    return { errors, warnings, notes };
  }

  const name = String(manifest.name ?? '');
  if (name === '') errors.push({ code: 'no-name', message: 'package.json 缺 name' });
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version ?? ''))) {
    warnings.push({ code: 'version-not-semver', message: `version 不像 semver：${String(manifest.version ?? '(空)')}` });
  }
  if (typeof manifest.main === 'string') {
    const hit = files.some((f) => f.path === manifest.main);
    if (!hit) errors.push({ code: 'main-missing', message: `main 指向的文件不在发布清单里：${manifest.main}` });
  }
  if (manifest.exports !== undefined && typeof manifest.exports === 'object') {
    for (const value of Object.values(manifest.exports)) {
      if (typeof value !== 'string' || value.startsWith('.')) continue;
      if (!files.some((f) => f.path === value || f.path === value.replace(/^\.\//, ''))) {
        warnings.push({ code: 'export-missing', message: `exports 指向的文件不在清单里：${value}` });
      }
    }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    warnings.push({ code: 'no-files-whitelist', message: 'package.json 没有 files 白名单 —— 只有必带文件会被推上去' });
  }
  for (const miss of missing) {
    warnings.push({ code: 'pattern-empty', message: `files 里的 "${miss}" 没匹配到任何文件` });
  }

  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch === 'string' && !files.some((f) => f.path === patch.replace(/^\.\//, ''))) {
    errors.push({ code: 'patch-missing', message: `dsh.bundle.patch 指向的文件不在清单里：${patch}` });
  }
  if (manifest?.dsh?.compatibility === undefined) {
    warnings.push({ code: 'no-compatibility', message: 'dsh.compatibility 未声明（市场与用户都看不到兼容范围）' });
  }

  const peers = manifest.peerDependencies ?? {};
  for (const [dep, range] of Object.entries(peers)) {
    if (String(range).startsWith('^')) {
      warnings.push({ code: 'caret-range', message: `peerDependencies 用了 ^：${dep}@${range}（本项目统一用显式范围）` });
    }
  }

  for (const file of files) {
    if (file.bytes > HARD_FILE_LIMIT) {
      errors.push({ code: 'file-too-big', message: `${file.path} 有 ${(file.bytes / 1048576).toFixed(1)}MB，超过 25MB 上限（要走 Git Data API，v0.1 不支持）` });
    } else if (file.bytes > SOFT_FILE_LIMIT) {
      warnings.push({ code: 'file-big', message: `${file.path} 有 ${(file.bytes / 1024).toFixed(0)}KB，超过 1MB 提醒线` });
    }
  }

  // 敏感串：只在文本文件里扫（二进制跳过），命中即 error，且**不回显明文**
  for (const file of files) {
    if (file.bytes > 2 * 1024 * 1024) continue;
    if (/\.(png|jpg|jpeg|gif|webp|ico|zip|tgz|exe|bin|woff2?)$/i.test(file.path)) continue;
    const hits = scanSecrets(file.content.toString('utf8'));
    for (const hit of hits) {
      errors.push({
        code: 'secret-found',
        message: `${file.path}:${hit.line} 命中 ${hit.kind}（${hit.masked}）—— 先清理再发布`,
      });
    }
  }

  if (liveTree?.checked === true && Array.isArray(liveTree.hits) && liveTree.hits.length > 0) {
    const names = liveTree.hits.map((h) => h.name).join(', ');
    notes.push({
      code: 'live-tree',
      message: `这是活代码树（profile 里以 junction 挂着：${names}）—— **发布可以，测试绝对不许在这里跑**；把副本复制到沙箱再跑`,
    });
  }

  if (typeof repo === 'string' && repo !== '' && typeof manifest.repository?.url === 'string') {
    if (!manifest.repository.url.includes(`/${repo}`)) {
      warnings.push({
        code: 'repo-mismatch',
        message: `package.json 的 repository.url 里没有 "${repo}"：${manifest.repository.url}`,
      });
    }
  }

  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  notes.push({ code: 'stats', message: `${files.length} 个文件、共 ${(total / 1024).toFixed(1)}KB` });
  return { errors, warnings, notes };
}

/**
 * 生成市场条目 yml（awesome-dsh-plugin 的 `data/plugins/<owner>__<repo>.yml`）。
 * 含「: 」的值一律加引号 —— 不加会让 YAML 解析出岔子。
 * @param {object} entry 条目
 * @returns {string} yml 文本
 */
export function buildMarketYml(entry) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[:#\-?*&!|>'"%@`{}[\],]/.test(s) || s.trim() !== s || s === '' ? `"${s.replace(/"/g, '\\"')}"` : s;
  };
  return [
    `url: ${q(entry.url)}`,
    `name: ${q(entry.name)}`,
    `category: ${q(entry.category)}`,
    'description:',
    `  en: ${q(entry.descriptionEn)}`,
    `  zh: ${q(entry.descriptionZh)}`,
    '',
  ].join('\n');
}

/** 市场条目文件名：上游的约定是 `<owner>__<repo>.yml`。 */
export function marketEntryPath(owner, repo) {
  return `data/plugins/${owner}__${repo}.yml`;
}
