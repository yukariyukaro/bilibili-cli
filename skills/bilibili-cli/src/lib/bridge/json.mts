/**
 * 无损 JSON 解析：安全整数的精度由 Node JSON.parse reviver 的 context.source 保真。
 * 上游 Node 若没有 context.source（或运行时未提供原始文本），拒绝把已丢精度的
 * number 当字符串使用，保持旧实现的 fail-closed 回退。
 */
export function parseJsonLossless(text: string): unknown {
  if (typeof text !== 'string') throw new TypeError('JSON text must be a string')
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      const source = context?.source
      if (typeof source !== 'string' || !/^-?\d+$/.test(source)) {
        throw new SyntaxError('unsafe JSON integer without exact source')
      }
      return source
    }
    return value
  }
  const parsed: unknown = JSON.parse(text, reviver)
  return parsed
}

export function parseJsonText(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  return parsed
}
