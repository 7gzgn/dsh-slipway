/**
 * dsh-slipway · github —— GitHub REST 通道（api.github.com 直连，不需要梯子）。
 *
 * 三条纪律：
 *   ① **token 永不进输出**：本模块只经 `maskToken()` 暴露痕迹，日志里只记方法与路径；
 *   ② **可注入 fetch**：测试注入假的 fetch，全流程就能在沙箱里跑，不碰真网络；
 *   ③ **「不存在」是正常答案**：查询类接口 404 返回 null，而不是抛错 —— 调用方要靠它做幂等。
 *
 * @module dsh-slipway/github
 */

import { maskToken } from './core.js';

/** GitHub 侧的失败；带上状态码与路径，方便判断是权限、限流还是真没有。 */
export class GithubError extends Error {
  /**
   * @param {string} message 说明
   * @param {object} info 细节
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = info.status ?? 0;
    this.path = info.path ?? '';
    this.body = info.body ?? null;
  }
}

/**
 * 造一个 GitHub 客户端。
 * @param {object} options 选项
 * @param {string} options.token PAT（`ghp_…`）
 * @param {Function} [options.fetchImpl] fetch 实现（测试注入）
 * @param {string} [options.baseUrl] API 根
 * @param {number} [options.timeoutMs] 单次请求上限
 * @returns {object} 客户端
 */
export function createGitHub({ token, fetchImpl = fetch, baseUrl = 'https://api.github.com', timeoutMs = 60000 }) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new GithubError('缺少 GitHub token（PAT 文件读不到或为空）');
  }
  const calls = [];

  /**
   * 发一次请求。
   * @param {string} method 方法
   * @param {string} path 路径（/ 开头）
   * @param {object} [body] JSON body
   * @param {object} [opts] 选项
   * @returns {Promise<{status:number, ok:boolean, json:any, headers:object, path:string}>} 响应
   */
  async function request(method, path, body, opts = {}) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'dsh-slipway',
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      calls.push({ method, path, status: 0, note: 'transport-failed' });
      throw new GithubError(`请求 ${method} ${path} 失败：${err instanceof Error ? err.message : String(err)}`, { path });
    }
    clearTimeout(timer);

    let json = null;
    let text = '';
    try {
      text = await res.text();
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    // 证据里只记方法与路径（**绝不记 body**，body 里可能有内容也可能有凭据）
    calls.push({ method, path, status: res.status });
    return { status: res.status, ok: res.ok === true || (res.status >= 200 && res.status < 300), json, text, headers: res.headers, path };
  }

  return {
    calls,
    request,
    tokenHint: maskToken(token),

    /** 当前 token 是谁。 */
    async whoami() {
      const res = await request('GET', '/user');
      if (res.ok !== true) throw new GithubError(`/user 失败（HTTP ${res.status}）`, { status: res.status, path: '/user', body: res.json });
      return res.json;
    },

    /** 取仓库；不存在返回 null。 */
    async getRepo(owner, repo) {
      const res = await request('GET', `/repos/${owner}/${repo}`);
      if (res.status === 404) return null;
      if (res.ok !== true) throw new GithubError(`读仓库失败（HTTP ${res.status}）`, { status: res.status, path: `/repos/${owner}/${repo}`, body: res.json });
      return res.json;
    },

    /** 建仓库（auto_init:false —— 空仓等我们逐文件推）。 */
    async createRepo(name, { description = '', private: isPrivate = false } = {}) {
      const res = await request('POST', '/user/repos', { name, description, private: isPrivate, auto_init: false });
      if (res.ok !== true) throw new GithubError(`建仓库失败（HTTP ${res.status}）：${res.json?.message ?? ''}`, { status: res.status, path: '/user/repos', body: res.json });
      return res.json;
    },

    /** 读一个文件（contents API）；不存在返回 null。 */
    async getFile(owner, repo, path, ref) {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const res = await request('GET', `/repos/${owner}/${repo}/contents/${encodeURI(path)}${q}`);
      if (res.status === 404) return null;
      if (res.ok !== true) throw new GithubError(`读文件失败（HTTP ${res.status}）：${path}`, { status: res.status, path, body: res.json });
      return res.json;
    },

    /** 写一个文件（contents API）；body 里给 base64 内容，更新时带 sha。 */
    async putFile(owner, repo, path, { content, message, branch, sha }) {
      const body = { message, content: content.toString('base64') };
      if (branch) body.branch = branch;
      if (sha) body.sha = sha;
      const res = await request('PUT', `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, body);
      if (res.ok !== true) throw new GithubError(`写文件失败（HTTP ${res.status}）：${path}`, { status: res.status, path, body: res.json });
      return res.json;
    },

    /** 设置 topics（需要 mercy-preview accept）。 */
    async setTopics(owner, repo, names) {
      const res = await request('PUT', `/repos/${owner}/${repo}/topics`, { names }, { accept: 'application/vnd.github.mercy-preview+json' });
      if (res.ok !== true) throw new GithubError(`设置 topics 失败（HTTP ${res.status}）`, { status: res.status, path: '/topics', body: res.json });
      return res.json;
    },

    /** 取某个分支的 head sha。 */
    async getRef(owner, repo, branch) {
      const res = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
      if (res.status === 404) return null;
      if (res.ok !== true) throw new GithubError(`读分支失败（HTTP ${res.status}）：${branch}`, { status: res.status, path: `/git/ref/heads/${branch}`, body: res.json });
      return res.json?.object?.sha ?? null;
    },

    /** 从给定 sha 建分支；已存在返回 null。 */
    async createBranch(owner, repo, branch, sha) {
      const res = await request('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      if (res.status === 422) return null; // 已存在
      if (res.ok !== true) throw new GithubError(`建分支失败（HTTP ${res.status}）：${branch}`, { status: res.status, path: '/git/refs', body: res.json });
      return res.json;
    },

    /** 找一个已有 PR（按 head 分支）；没有返回 null —— 幂等靠它。 */
    async findPull(owner, repo, head) {
      const res = await request('GET', `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=10`);
      if (res.ok !== true) throw new GithubError(`查 PR 失败（HTTP ${res.status}）`, { status: res.status, path: '/pulls', body: res.json });
      return Array.isArray(res.json) && res.json.length > 0 ? res.json[0] : null;
    },

    /**
     * 按标题再找一次已有 PR —— 分支名可能被改过（老版本用过 `add-<repo>`），
     * 只按 head 查会漏，于是重复开 PR。标题里带 `owner/repo` 就够了。
     * @param {string} owner 上游 owner
     * @param {string} repo 上游仓库
     * @param {string} needle 标题里必须出现的片段（形如 `7gzgn/dsh-x`）
     * @returns {Promise<object|null>} 命中的 PR（含 number/state/html_url）或 null
     */
    async findPullByTitle(owner, repo, needle) {
      const q = encodeURIComponent(`repo:${owner}/${repo} is:pr in:title "${needle}"`);
      const res = await request('GET', `https://api.github.com/search/issues?q=${q}&per_page=10`);
      if (res.ok !== true) return null;
      const items = Array.isArray(res.json?.items) ? res.json.items : [];
      return items.length > 0 ? items[0] : null;
    },

    /** 开 PR。 */
    async createPull(owner, repo, { title, body, head, base }) {
      const res = await request('POST', `/repos/${owner}/${repo}/pulls`, { title, body, head, base });
      if (res.status === 422) return null; // 多半是已存在
      if (res.ok !== true) throw new GithubError(`开 PR 失败（HTTP ${res.status}）：${res.json?.message ?? ''}`, { status: res.status, path: '/pulls', body: res.json });
      return res.json;
    },
  };
}

/** 从 PAT 文件读 token（默认 `D:\dsh\.gh-token`）；读不到返回 null。 */
export async function readTokenFile(path, { readFileImpl } = {}) {
  const read = readFileImpl ?? (await import('node:fs/promises')).readFile;
  try {
    const text = await read(path, 'utf8');
    const token = String(text).trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}
