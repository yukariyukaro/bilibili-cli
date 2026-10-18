import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const append = fs.appendFileSync
let count = 0
fs.appendFileSync = (file, ...args) => {
  if (String(file).endsWith('audit.jsonl') && ++count === Number(process.env.TEST_AUDIT_FAIL_AT)) throw new Error('模拟审计失败')
  return append(file, ...args)
}
syncBuiltinESMExports()
