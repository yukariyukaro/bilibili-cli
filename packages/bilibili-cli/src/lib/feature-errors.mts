import { CliError } from './contract.mjs'

/**
 * 上游异常 -> CLI 错误码。
 * B 站风控（HTTP 412 或业务码 -352）必须单独暴露：它既不是格式错误也不是登录问题,
 * 混进 BACKEND 会让 Agent 误以为可以「稍后重试」，而实际上要停止并告知用户。
 */
export function toFeatureError(error: unknown, write: boolean): CliError {
  if (error instanceof CliError) return error
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = record.code
  if (code === 412 || code === -352) {
    return new CliError('RISK_CONTROL', 'B 站风控拒绝了本次请求；停止操作并告知用户，不要换方式重试', 5)
  }
  return new CliError('BACKEND', write ? '上游调用失败或结果未知；写操作不得自动重试，请人工核对' : '上游调用失败；请检查登录状态或稍后重试', 1)
}
