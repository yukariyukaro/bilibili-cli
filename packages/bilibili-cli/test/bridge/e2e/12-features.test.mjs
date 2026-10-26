import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { freshDir, installedOrSkip, WORKDIR } from './lib/env.mjs'
import { runBilibili, runBilibiliRaw, runJsonl, schema } from './lib/cli.mjs'

// Independent release contract; do not derive expectations from the implementation,
// and do not replace or extend the historical 23-command snapshot.
const features = JSON.parse(readFileSync(new URL('../../contracts/features-2.1.0.json', import.meta.url), 'utf8'))
const writes = features.filter((definition) => definition.write === true)
const LONG_ID = '1234567890123456789'
const BVID = 'BV1xx411c7mD'
const BODY = 'offline-feature-body-not-for-backend-正文'
const TITLE = 'offline-private-title'
const DESCRIPTION = 'offline-private-description'
const FILE_CONTENT = 'offline-cover-content-must-not-appear-in-audit'
const flag = (key) => '--' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())

function exampleArgs(definition, file = join(WORKDIR, 'not-read-by-dry-run.png')) {
  const samples = {
    bvid: BVID, uid: 1, rpid: 1, id: LONG_ID, dmid: LONG_ID,
    mediaIds: '1,2', ids: '1,2', aids: '1,2', mediaId: 1, packageId: 1,
    seasonId: 1, seriesId: 1, tid: 1, timeMs: 0,
    text: BODY, title: TITLE, description: DESCRIPTION, file,
  }
  const args = {}
  for (const [key, field] of Object.entries(definition.fields)) {
    if (field.required || ['text', 'title', 'description', 'file', 'id', 'dmid'].includes(key)) {
      assert.ok(Object.hasOwn(samples, key), 'Add an explicit example for ' + definition.name + '.' + key)
      args[key] = samples[key]
    }
  }
  return args
}

function expectedParams(definition, args) {
  const result = {}
  for (const [key, field] of Object.entries(definition.fields)) {
    if (['confirm', 'dryRun'].includes(key)) continue
    const value = args[key] === undefined ? field.default : args[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

function cliArgs(name, args) {
  return [...name.split(' '), ...Object.entries(args).flatMap(([key, value]) =>
    typeof value === 'boolean' ? (value ? [flag(key)] : []) : [flag(key), String(value)]), '--json']
}

function assertEnvelope(row, name, { ok, code, id } = {}) {
  assert.equal(row.schemaVersion, 1)
  assert.equal(row.command, name)
  assert.equal(row.ok, ok)
  if (id !== undefined) assert.equal(row.id, id)
  if (code) assert.equal(row.error?.code, code)
}

function assertNoSideEffects(home) {
  for (const file of ['audit.jsonl', 'bili_credential.json', 'credential.json']) {
    assert.equal(existsSync(join(home, file)), false, 'Unexpected state file: ' + file)
  }
}

async function installedModules(installed) {
  // Always resolve under the real npm install, never src/dist in this checkout.
  const load = (name) => import(pathToFileURL(join(installed.packageDir, 'dist', 'lib', name + '.mjs')).href)
  const [application, contract] = await Promise.all([load('application'), load('contract')])
  return { ...application, ...contract }
}

async function withApplication(modules, { enabled = false, reply = { success: true }, auditFailure = 0 } = {}, run) {
  // These tests are intentionally sequential: the app reads this process env lazily.
  const home = freshDir('home-feature-runtime-')
  const previousHome = process.env.BILIBILI_SKILL_HOME
  const calls = []
  const audits = []
  let auditAttempts = 0
  const runtime = {
    async call(tool, params) {
      calls.push({ tool, params: structuredClone(params) })
      if (reply instanceof Error) throw reply
      return structuredClone(reply)
    },
    async setup() { throw new Error('Feature execution must not set up a backend') },
    async login() { throw new Error('Feature execution must not log in') },
    close() {},
  }
  process.env.BILIBILI_SKILL_HOME = home
  const app = modules.createApplication({
    runtime,
    audit(entry) {
      auditAttempts += 1
      if (auditAttempts === auditFailure) throw new Error('offline audit failure')
      audits.push(structuredClone(entry))
    },
  })
  try {
    // Bind the application's lazy state context while the isolated home is active.
    await app.execute('config get')
    if (enabled) await app.execute('config set', { key: 'writesEnabled', value: 'true' })
    return await run({ app, home, calls, audits, auditAttempts: () => auditAttempts })
  } finally {
    app.close()
    if (previousHome === undefined) delete process.env.BILIBILI_SKILL_HOME
    else process.env.BILIBILI_SKILL_HOME = previousHome
    assert.equal(existsSync(join(home, 'bili_credential.json')), false)
    assert.equal(existsSync(join(home, 'credential.json')), false)
  }
}

function rejectsCode(promise, code, exitCode) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code)
    if (exitCode !== undefined) assert.equal(error.exitCode, exitCode)
    return true
  })
}

function assertAudit(entries, definition, statuses, args) {
  assert.deepEqual(entries.map((entry) => entry.status), statuses)
  assert.ok(entries.length > 0)
  const operationId = entries[0].operationId
  assert.equal(typeof operationId, 'string')
  assert.ok(operationId.length > 0)
  for (const entry of entries) {
    assert.equal(entry.command, definition.name)
    assert.equal(entry.operationId, operationId)
    assert.ok(Number.isFinite(Date.parse(entry.at)))
    if (args.text) assert.equal(entry.textSha256, createHash('sha256').update(args.text).digest('hex'))
    const serialized = JSON.stringify(entry)
    for (const secret of [args.text, args.title, args.description, args.file, FILE_CONTENT].filter(Boolean)) {
      const encoded = JSON.stringify(secret).slice(1, -1)
      assert.equal(serialized.includes(encoded), false, definition.name + ': audit leaked body/path/content')
    }
    for (const key of ['text', 'title', 'description', 'file']) assert.equal(Object.hasOwn(entry, key), false)
  }
}

test('features: installed help/schema/JSONL use the independent additive contract', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-feature-contract-')
  const options = { home, installed, cwd: WORKDIR }
  const contract = await schema(home, options)
  assert.equal(new Set(features.map((item) => item.name)).size, features.length)
  for (const group of ['danmaku', 'dynamic', 'favorite', 'season', 'stats', 'emoji', 'upload']) {
    assert.ok(features.some((item) => item.name.startsWith(group + ' ')), 'Missing group: ' + group)
  }
  const names = new Set(features.map((item) => item.name))
  assert.deepEqual(contract.commands.filter((item) => names.has(item.name)), features)
  const jsonl = await runJsonl([{ id: 'feature-schema', command: 'schema' }], options)
  assert.equal(jsonl.code, 0, jsonl.stderr)
  assert.equal(jsonl.rows.length, 1)
  assertEnvelope(jsonl.rows[0], 'schema', { ok: true, id: 'feature-schema' })
  assert.deepEqual(jsonl.rows[0].result, contract)

  for (const definition of features) {
    await t.test(definition.name, async () => {
      const help = await runBilibiliRaw([...definition.name.split(' '), '--help'], options)
      assert.equal(help.code, 0, help.stderr)
      assert.ok(help.stdout.includes(definition.description))
      const flags = [...help.stdout.matchAll(/^\s+(--[a-z][a-z0-9-]*)/gm)].map((match) => match[1])
      assert.deepEqual(flags.sort(), Object.keys(definition.fields).map(flag).sort(), 'help/schema field drift')
      for (const field of Object.values(definition.fields)) assert.ok(help.stdout.includes(field.description))
    })
  }
  assertNoSideEffects(home)
})

test('features: every installed command rejects unknown CLI and JSONL arguments before backend work', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-feature-unknown-')
  const options = { home, installed, cwd: WORKDIR }
  for (const definition of features) {
    await t.test(definition.name, async () => {
      const result = await runBilibili(cliArgs(definition.name, { ...exampleArgs(definition), unexpectedFeatureArg: 'bad' }), options)
      assert.equal(result.code, 2, result.stderr)
      assert.equal(result.envelope.ok, false)
      assert.equal(result.envelope.error.code, 'USAGE')
    })
  }
  const requests = features.map((definition, index) => ({
    id: 'unknown-' + index, command: definition.name,
    args: { ...exampleArgs(definition), unexpectedFeatureArg: 'bad' },
  }))
  const jsonl = await runJsonl(requests, options)
  assert.equal(jsonl.code, 2, jsonl.stderr)
  assert.equal(jsonl.rows.length, requests.length)
  jsonl.rows.forEach((row, index) => assertEnvelope(row, requests[index].command, {
    ok: false, code: 'VALIDATION', id: requests[index].id,
  }))
  assertNoSideEffects(home)
})

test('features: every new installed write is disabled without authorization; dry-run preserves targets without audit', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-feature-write-cli-')
  const options = { home, installed, cwd: WORKDIR }
  // 批量 JSONL 请求先算好再跑：如果只在子用例里 push，任何子用例提前结束时
  // requests 会是空数组，CLI 读到空 stdin 会「静默无输出」，把真实断言掩盖成
  // 「bilibili 无输出(code=0)」。这里与子用例执行顺序解耦。
  const requests = writes.flatMap((definition) => {
    const args = exampleArgs(definition)
    return [
      { id: definition.tool + '-dry', command: definition.name, args: { ...args, dryRun: true } },
      { id: definition.tool + '-disabled', command: definition.name, args: { ...args, confirm: true } },
    ]
  })
  for (const definition of writes) {
    await t.test(definition.name, async () => {
      const args = exampleArgs(definition)
      const dry = await runBilibili(cliArgs(definition.name, { ...args, dryRun: true }), options)
      assert.equal(dry.code, 0, dry.stderr)
      assertEnvelope(dry.envelope, definition.name, { ok: true })
      assert.equal(dry.envelope.result.dryRun, true)
      assert.deepEqual(dry.envelope.result.target, expectedParams(definition, args))
      assert.equal(Object.hasOwn(dry.envelope.result.target, 'confirm'), false)
      assert.equal(Object.hasOwn(dry.envelope.result.target, 'dryRun'), false)
      const refused = await runBilibili(cliArgs(definition.name, args), options)
      assert.equal(refused.code, 3, refused.stderr)
      assertEnvelope(refused.envelope, definition.name, { ok: false, code: 'WRITE_DISABLED' })

    })
  }
  const jsonl = await runJsonl(requests, options)
  assert.equal(jsonl.code, 3, jsonl.stderr)
  assert.equal(jsonl.rows.length, requests.length)
  jsonl.rows.forEach((row, index) => {
    const request = requests[index]
    const dry = index % 2 === 0
    assertEnvelope(row, request.command, { ok: dry, ...(!dry ? { code: 'WRITE_DISABLED' } : {}), id: request.id })
    if (dry) {
      assert.equal(row.result.dryRun, true)
      const definition = features.find((item) => item.name === request.command)
      assert.deepEqual(row.result.target, expectedParams(definition, request.args))
    }
  })
  assertNoSideEffects(home)
})

function invalidCases() {
  const result = []
  for (const definition of features) {
    const args = exampleArgs(definition)
    for (const key of ['mediaIds', 'ids', 'aids']) {
      if (!definition.fields[key]) continue
      for (const value of ['1,,2', '1,', ',1', '1, 2', '0,1', '-1,2', '1.5,2', '9007199254740992', Array(21).fill('1').join(',')]) {
        result.push({ name: definition.name, args: { ...args, [key]: value }, label: key + '=' + value })
      }
    }
    for (const key of ['text', 'title', 'description']) {
      const max = definition.fields[key]?.maxLength
      if (max) result.push({ name: definition.name, args: { ...args, [key]: 'x'.repeat(max + 1) }, label: key + ' too long' })
    }
  }
  result.push({ name: 'danmaku send', args: { bvid: BVID, text: BODY, timeMs: -1 }, label: 'negative time' })
  result.push({ name: 'danmaku send', args: { bvid: BVID, text: BODY, timeMs: 0.5 }, label: 'fractional milliseconds' })
  for (const definition of features) {
    for (const key of ['id', 'dmid']) {
      if (!definition.fields[key]) continue
      for (const value of [Number(LONG_ID), 1, '0', '-1', '1e18', '1.0']) {
        result.push({ name: definition.name, args: { ...exampleArgs(definition), [key]: value }, label: key + ' invalid type/format ' + value })
      }
    }
  }
  return result
}

test('features: installed contract/application and CLI reject bad CSV, long bodies, lossy IDs and negative time offline', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const modules = await installedModules(installed)
  const home = freshDir('home-feature-invalid-cli-')
  const options = { home, installed, cwd: WORKDIR }
  const cases = invalidCases()
  await withApplication(modules, {}, async ({ app, calls, audits }) => {
    for (const item of cases) {
      const definition = modules.commands.find((command) => command.name === item.name)
      assert.ok(definition, item.name)
      assert.throws(() => modules.validate(definition, item.args), (error) => error.code === 'VALIDATION', item.label)
      await rejectsCode(app.execute(item.name, item.args), 'VALIDATION', 2)
    }
    assert.deepEqual(calls, [])
    assert.deepEqual(audits, [])
  })
  // CLI arguments are strings: numeric JSON ID rejection belongs to JSONL/contract,
  // while malformed decimal IDs must also fail through the installed executable.
  for (const item of cases.filter((item) => !['id', 'dmid'].some((key) => typeof item.args[key] === 'number'))) {
    const result = await runBilibili(cliArgs(item.name, { ...item.args, ...(writes.some((item2) => item2.name === item.name) ? { dryRun: true } : {}) }), options)
    assert.equal(result.code, 2, item.name + ': ' + item.label + '\n' + result.stderr)
    assertEnvelope(result.envelope, item.name, { ok: false, code: 'VALIDATION' })
  }
  const requests = cases.map((item, index) => ({ id: 'invalid-' + index, command: item.name, args: item.args }))
  const jsonl = await runJsonl(requests, options)
  assert.equal(jsonl.code, 2, jsonl.stderr)
  assert.equal(jsonl.rows.length, requests.length)
  jsonl.rows.forEach((row, index) => assertEnvelope(row, requests[index].command, { ok: false, code: 'VALIDATION', id: requests[index].id }))
  assertNoSideEffects(home)
})

test('features: installed application routes every feature tool and keeps 19-digit dynamic IDs/dmids exact', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const modules = await installedModules(installed)
  await withApplication(modules, { enabled: true, reply: { success: true, id: LONG_ID, dmid: LONG_ID } }, async ({ app, calls, audits }) => {
    for (const definition of features) {
      const args = exampleArgs(definition)
      const result = await app.execute(definition.name, { ...args, ...(definition.write ? { confirm: true } : {}) })
      const call = calls.at(-1)
      assert.equal(call.tool, definition.tool)
      assert.deepEqual(call.params, expectedParams(definition, args))
      for (const key of ['id', 'dmid']) {
        if (Object.hasOwn(args, key)) {
          assert.equal(call.params[key], LONG_ID)
          assert.equal(typeof call.params[key], 'string')
        }
      }
      assert.equal(result.success, true)
      const serializedResult = JSON.parse(JSON.stringify(result))
      assert.equal(serializedResult.id, LONG_ID)
      assert.equal(serializedResult.dmid, LONG_ID)
      if (definition.write) {
        assert.equal(result.audited, true)
        assert.equal(result.visibilityVerified, false)
        assertAudit(audits.slice(-2), definition, ['attempt', 'accepted'], args)
        assert.equal(result.operationId, audits.at(-1).operationId)
      }
    }
    assert.equal(calls.length, features.length, 'Each command must issue exactly one runtime call')
    assert.equal(audits.length, writes.length * 2, 'Read commands must not audit')
  })
})

test('features: all new writes share both authorization gates and dry-run never calls or audits', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const modules = await installedModules(installed)
  for (const enabled of [false, true]) {
    await withApplication(modules, { enabled }, async ({ app, calls, audits }) => {
      for (const definition of writes) {
        const args = exampleArgs(definition)
        for (const confirm of [false, true]) {
          const dry = await app.execute(definition.name, { ...args, confirm, dryRun: true })
          assert.equal(dry.dryRun, true)
          assert.deepEqual(dry.target, expectedParams(definition, args))
          if (!enabled || !confirm) await rejectsCode(app.execute(definition.name, { ...args, confirm }), 'WRITE_DISABLED', 3)
        }
      }
      assert.deepEqual(calls, [], 'No unauthorized/dry-run call may reach Runtime')
      assert.deepEqual(audits, [], 'No unauthorized/dry-run attempt may be audited')
    })
  }
})

test('features: every new write fails closed without retry, with failed_or_unknown and public success:true only', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const modules = await installedModules(installed)
  const failures = [
    { label: 'transport failure', reply: new Error('offline transport unknown'), code: 'BACKEND' },
    { label: 'explicit business failure', reply: { success: false }, code: 'BUSINESS' },
    { label: 'ok:false wins over success', reply: { success: true, ok: false }, code: 'BUSINESS' },
    { label: 'error wins over success', reply: { success: true, error: 'offline rejection' }, code: 'BUSINESS' },
    { label: 'raw API code zero is not public success', reply: { code: 0 }, code: 'UNKNOWN_STATE' },
    { label: 'ok:true is not public success', reply: { ok: true }, code: 'UNKNOWN_STATE' },
    { label: 'truthy success is not public success', reply: { success: 'true' }, code: 'UNKNOWN_STATE' },
    { label: 'null is unknown', reply: null, code: 'UNKNOWN_STATE' },
  ]
  for (const definition of writes) {
    await t.test(definition.name, async () => {
      for (const failure of failures) {
        await withApplication(modules, { enabled: true, reply: failure.reply }, async ({ app, calls, audits }) => {
          const args = exampleArgs(definition)
          await rejectsCode(app.execute(definition.name, { ...args, confirm: true }), failure.code)
          assert.equal(calls.length, 1, failure.label + ': do not retry')
          assertAudit(audits, definition, ['attempt', 'failed_or_unknown'], args)
        })
      }
    })
  }
})

test('features: AUDIT failure blocks initial writes or reports terminal uncertainty without retry, including file privacy', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const modules = await installedModules(installed)
  const file = join(freshDir('feature-cover-private-'), 'private-cover-image.png')
  writeFileSync(file, FILE_CONTENT, 'utf8')
  for (const definition of writes) {
    await t.test(definition.name, async () => {
      for (const auditFailure of [1, 2]) {
        for (const reply of [{ success: true }, new Error('offline failed write')]) {
          await withApplication(modules, { enabled: true, reply, auditFailure }, async ({ app, calls, audits, auditAttempts }) => {
            const args = exampleArgs(definition, file)
            await rejectsCode(app.execute(definition.name, { ...args, confirm: true }), 'AUDIT', 4)
            assert.equal(calls.length, auditFailure === 1 ? 0 : 1)
            assert.equal(auditAttempts(), auditFailure, 'Audit/backend failure must not trigger any retry')
            if (auditFailure === 1) assert.deepEqual(audits, [])
            else assertAudit(audits, definition, ['attempt'], args)
          })
        }
      }
    })
  }
})
