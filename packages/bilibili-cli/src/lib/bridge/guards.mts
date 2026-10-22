export type PlainObject = Record<string, unknown>

export function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
}

export function isIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+$/.test(value)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    const text = JSON.stringify(error)
    return typeof text === 'string' ? text : String(error)
  } catch {
    return String(error)
  }
}

/** 读取异常对象的 code；Error/自定义 Error 的原型不是 Object.prototype，不能用 strict plain-object guard。 */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  try {
    const code: unknown = Reflect.get(error, 'code')
    return typeof code === 'string' && code.length > 0 ? code : undefined
  } catch {
    return undefined
  }
}