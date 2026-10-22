#!/usr/bin/env node
/**
 * 安装产物 bridge 回归红灯入口（独立 node 脚本，不改产品 src）。
 *
 * 两个 case 都在真实 main 子进程上运行：真实安装的 bilibili CLI + 本地 cc-connect
 * 协议子集 WebSocket + 仓库外隔离状态目录。CLI 读取因隔离目录没有凭证返回 AUTH；
 * 不连接 B 站、不读写真实凭证、不打开写开关、不模拟 dm read/send 成功。
 *
 * 输出：stdout 一行 JSON，scope=bridge-regressions，cases 收集全部结果（不首错退出）。
 * 退出码：有 failed => 1；filter 未匹配 => 2；全部通过 => 0。
 *
 * 用法（cwd 应在仓库外）：
 *   node packages/bilibili-cli/test/bridge/regressions/run.mjs
 *   node packages/bilibili-cli/test/bridge/regressions/run.mjs --case=pending-allowlist-and-order
 *   node packages/bilibili-cli/test/bridge/regressions/run.mjs --filter=pending
 *   import { runner } from './run.mjs'; await runner({ env, cwd })
 *
 * 前置：BILIBILI_E2E_INSTALLED_PREFIX 指向统一安装前缀；缺少时两个 case 记 failed。
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertNoCredential,
  buildChildEnv,
  evidenceOf,
  freshCaseDir,
  pendingEntry,
  readState,
  resolveInstalledPrefix,
  resolveWorkdir,
  runInstalledCliVersion,
  sleep,
  startMain,
  startWsServer,
  tail,
  waitFor,
  writeState,
} from './lib/harness.mjs'

const OWNER_UID = '424242'
const OWNER_ALT_UID = '424243'

function fail(message, evidence) {
  const error = new Error(message)
  if (evidence) error.evidence = evidence
  return error
}

async function ensurePreflight(ctx) {
  if (ctx.preflight) return ctx.preflight
  const installed = ctx.installed
  if (!installed.ok) throw new Error(installed.reason + '；本轮不构建/不安装，必须由统一安装提供前缀')
  const result = await runInstalledCliVersion(installed, { baseEnv: ctx.env, cwd: ctx.workdir })
  if (result.timedOut) throw new Error('bilibili --version 超时（20s），安装前缀不可用：' + installed.bin)
  if (result.error) throw new Error('无法启动 bilibili --version：' + result.error)
  if (result.code !== 0) {
    throw new Error('bilibili --version 失败（退出码 ' + result.code + '）：' + tail(result.stderr, 800))
  }
  const version = result.stdout.trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('bilibili --version 输出不是版本号：' + JSON.stringify(version))
  ctx.preflight = { version, bin: installed.bin, prefix: installed.prefix }
  return ctx.preflight
}

async function startCase(ctx, { name, ownerUid, pending, cursorSeqno = 5 }) {
  const { dir, home, statePath } = freshCaseDir(ctx.workdir, name)
  writeState(statePath, { ownerUid, cursorSeqno, pending })
  const token = 'regress-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
  const server = await startWsServer({ token })
  const env = buildChildEnv({
    baseEnv: ctx.env,
    installed: ctx.installed,
    home,
    statePath,
    port: server.port,
    token,
    ownerUid,
  })
  const proc = startMain({ env, cwd: dir, name })
  return { dir, home, statePath, server, proc }
}

/**
 * 观察注册或早退：坏状态可以被明确拒绝（fail closed），但不能静默转发。
 * 返回 'registered' | 'exited'。
 */
async function awaitRegistered(stage, { timeout = 20000 } = {}) {
  return waitFor(
    () => {
      if (stage.server.hasEvent((event) => event.message?.type === 'register')) return 'registered'
      if (stage.proc.exitInfo()) return 'exited'
      return null
    },
    { timeout, interval: 100, description: 'main 完成 register 或退出' },
  )
}

function framesEvidence(stage, extra = {}) {
  const frames = stage.server.messages()
  const state = readState(stage.statePath)
  return evidenceOf({
    frames,
    stderr: stage.proc.output(),
    state: state ? { pending: state.pending?.length ?? null, seen: state.seen?.length ?? null } : null,
    extra,
  })
}

export async function casePendingAllowlistAndOrder(ctx) {
  const preflight = await ensurePreflight(ctx)
  const stage = await startCase(ctx, {
    name: 'pending-allowlist-and-order',
    ownerUid: OWNER_UID,
    cursorSeqno: 5,
    pending: [
      pendingEntry({ uid: OWNER_UID, seqno: 6, content: 'allowed-6' }),
      pendingEntry({ uid: OWNER_UID, seqno: 7, content: 'allowed-7' }),
      // 合法 v1 结构 + 合法正安全整数 uid，但不在 BILIBILI_OWNER_UID 白名单。
      pendingEntry({ uid: OWNER_ALT_UID, seqno: 6, content: 'foreign-6' }),
    ],
  })
  try {
    const outcome = await awaitRegistered(stage)
    if (outcome === 'exited') {
      const info = stage.proc.exitInfo()
      const errors = stage.proc.events.filter((event) => event.type === 'error')
      const frames = stage.server.messages()
      if (frames.length > 0) {
        throw fail('进程退出前仍转发了磁盘 pending：' + JSON.stringify(frames), framesEvidence(stage, { outcome }))
      }
      if (info.code === 0 || errors.length === 0) {
        throw fail(
          'main 在注册前退出（code=' + info.code + '），但没有明确 error 事件；既未拒绝也未服务，属于静默失败',
          framesEvidence(stage, { outcome, exit: info, errors }),
        )
      }
      // fail closed 且报错：允许（坏/越权 pending 不得服务），不是本轮红灯。
      return { mode: 'fail-closed', exitCode: info.code, errors: errors.map((event) => event.code) }
    }

    // 已注册：允许的 pending 应被转发，越权 uid 绝不能出现在 message 帧里。
    const allowed = await waitFor(
      () => {
        const frames = stage.server.messages().filter((frame) => frame.user_id === OWNER_UID)
        return frames.length >= 2 ? frames : null
      },
      { timeout: 12000, interval: 100, description: '2 条白名单 pending 被转发' },
    ).catch((error) => {
      throw fail(
        'main 已注册，但 12s 内没有转发 2 条白名单 pending（' + OWNER_UID + '）：' + error.message,
        framesEvidence(stage),
      )
    })
    await sleep(500)
    const frames = stage.server.messages()
    const allowedFrames = frames.filter((frame) => frame.user_id === OWNER_UID)
    const foreignFrames = frames.filter((frame) => frame.user_id !== OWNER_UID)
    const evidence = framesEvidence(stage, { preflight })

    assert.deepEqual(
      allowedFrames.map((frame) => frame.content),
      ['allowed-6', 'allowed-7'],
      '白名单 pending 必须按 seqno 正序转发；实际：' + JSON.stringify(allowedFrames.map((frame) => ({ user_id: frame.user_id, content: frame.content }))),
    )
    if (foreignFrames.length > 0) {
      throw fail(
        '磁盘 pending 中不在 BILIBILI_OWNER_UID=' + OWNER_UID + ' 白名单的条目被直接转发给 agent：' +
        JSON.stringify(foreignFrames.map((frame) => ({ user_id: frame.user_id, msg_id: frame.msg_id, content: frame.content }))) +
        '；期望：越权 uid 不得转发（应隔离/剔除或 fail closed），允许条目继续按序转发',
        evidence,
      )
    }
    assertNoCredential(stage.home)
    return {
      mode: 'served',
      order: allowedFrames.map((frame) => frame.content),
      foreignForwarded: 0,
      pendingOnDisk: readState(stage.statePath)?.pending?.length ?? null,
    }
  } finally {
    await stage.proc.stop()
    await stage.server.close()
  }
}

export async function casePendingSaturationDrain(ctx) {
  const preflight = await ensurePreflight(ctx)
  // MAX_PENDING=1000：恰好饱和。正确行为是只停止再接收新消息，已持久化的 pending
  // 仍必须在注册后 drain；当前 _poll 在饱和时直接 return，绕过 _drainPending。
  const pending = Array.from({ length: 1000 }, (_, index) => pendingEntry({
    uid: OWNER_UID,
    seqno: 6 + index,
    content: 'pending-' + (6 + index),
  }))
  const stage = await startCase(ctx, {
    name: 'pending-saturation-drain',
    ownerUid: OWNER_UID,
    cursorSeqno: 5,
    pending,
  })
  try {
    const outcome = await awaitRegistered(stage)
    if (outcome === 'exited') {
      const info = stage.proc.exitInfo()
      const errors = stage.proc.events.filter((event) => event.type === 'error')
      throw fail(
        'pending=1000 饱和时 main 在注册前退出（code=' + info.code + '）；队列饱和是正常背压状态，' +
        '不是坏状态：应继续 drain 已持久化 pending，而不是拒绝启动。error=' + JSON.stringify(errors.map((event) => event.code)),
        framesEvidence(stage, { outcome, exit: info, errors }),
      )
    }

    const first = await waitFor(
      () => stage.server.messages()[0] ?? null,
      { timeout: 20000, interval: 150, description: '饱和 pending 被 drain 后的首条 message 帧' },
    ).catch(() => null)

    const state = readState(stage.statePath)
    const evidence = framesEvidence(stage, {
      preflight,
      pendingOnDisk: state?.pending?.length ?? null,
      framesAfter20s: stage.server.messages().length,
    })
    if (!first) {
      throw fail(
        'pending 恰好 1000（MAX_PENDING）时，注册后 20s 内 0 条 message 帧被转发；' +
        'main 仍存活且 pending 未减少，说明饱和分支永久跳过 _drainPending，队列与所有后续入站消息永久堵塞。' +
        '期望：饱和只限制新消息入库（pendingFull），已有 pending 在 bridge ready 后按 seqno 正序 drain。',
        evidence,
      )
    }
    assert.equal(first.user_id, OWNER_UID)
    assert.equal(first.content, 'pending-6', '饱和 pending drain 必须从最旧 seqno 开始（正序）；实际首条：' + first.content)
    assertNoCredential(stage.home)
    return {
      mode: 'drained',
      firstContent: first.content,
      firstSeqno: 6,
      framesObserved: stage.server.messages().length,
      pendingOnDisk: state?.pending?.length ?? null,
    }
  } finally {
    await stage.proc.stop()
    await stage.server.close()
  }
}

export const CASES = [
  { name: 'pending-allowlist-and-order', fn: casePendingAllowlistAndOrder },
  { name: 'pending-saturation-drain', fn: casePendingSaturationDrain },
]

/**
 * 可编程入口：收集全部 case，不首错退出。
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, filter?: string, log?: (line: string) => void}} options
 */
export async function runner({ env = process.env, cwd = process.cwd(), filter = null, log = (line) => process.stderr.write(line + '\n') } = {}) {
  const workdir = resolveWorkdir(env)
  const installed = resolveInstalledPrefix(env)
  const selected = filter
    ? CASES.filter((entry) => entry.name.includes(filter))
    : [...CASES]
  const ctx = { env, cwd, workdir, installed, preflight: null }
  const cases = []

  if (selected.length === 0) {
    return {
      result: {
        scope: 'bridge-regressions',
        at: new Date().toISOString(),
        workdir,
        installedPrefix: installed.ok ? installed.prefix : null,
        cases,
        counts: { total: 0, passed: 0, failed: 0, selected: 0 },
        error: '没有 case 匹配 filter=' + JSON.stringify(filter),
      },
      ok: false,
      exitCode: 2,
    }
  }

  for (const entry of selected) {
    const started = Date.now()
    log('[bridge-regressions] 开始：' + entry.name)
    try {
      const evidence = await entry.fn(ctx)
      cases.push({ name: entry.name, status: 'passed', durationMs: Date.now() - started, evidence })
      log('[bridge-regressions] PASS：' + entry.name)
    } catch (error) {
      const payload = {
        name: entry.name,
        status: 'failed',
        durationMs: Date.now() - started,
        error: error?.message || String(error),
      }
      if (error?.evidence) payload.evidence = error.evidence
      cases.push(payload)
      log('[bridge-regressions] FAIL：' + entry.name + '：' + (error?.message || error))
    }
  }

  const failed = cases.filter((entry) => entry.status === 'failed').length
  const result = {
    scope: 'bridge-regressions',
    at: new Date().toISOString(),
    workdir,
    installedPrefix: installed.ok ? installed.prefix : null,
    cases,
    counts: { total: cases.length, passed: cases.length - failed, failed },
  }
  return { result, ok: failed === 0, exitCode: failed === 0 ? 0 : 1 }
}

function parseArgs(argv) {
  const options = { filter: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--case=')) options.filter = arg.slice('--case='.length)
    else if (arg === '--case') options.filter = argv[++index] ?? null
    else if (arg.startsWith('--filter=')) options.filter = arg.slice('--filter='.length)
    else if (arg === '--filter') options.filter = argv[++index] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stderr.write('用法：node packages/bilibili-cli/test/bridge/regressions/run.mjs [--case=<name>|--filter=<substr>]\n')
  } else {
    try {
      const { result, exitCode } = await runner({ env: process.env, cwd: process.cwd(), filter: options.filter })
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode = exitCode
    } catch (error) {
      const result = {
        scope: 'bridge-regressions',
        at: new Date().toISOString(),
        cases: [],
        counts: { total: 0, passed: 0, failed: 0 },
        error: 'runner 初始化失败：' + (error?.message || String(error)),
      }
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exitCode = 1
    }
  }
}
