/** 共享类型：命令契约、校验结果与 CLI 边界数据。 */

/** 契约字段的附加来源信息：schema 必须如实说明默认值可能来自环境变量。 */
interface FieldMeta {
  /** 该字段回退读取的环境变量名；只在调用方未显式传参时生效。 */
  env?: string
  /** default 的来源：字面量默认值，或由 env 提供的运行时默认值。 */
  defaultSource?: 'literal' | 'env'
}

export interface StringFieldDefinition extends FieldMeta {
  type: 'string'
  description: string
  required?: boolean
  default?: string
  enum?: readonly string[]
  pattern?: string
  maxLength?: number
}

export interface IntegerFieldDefinition extends FieldMeta {
  type: 'integer'
  description: string
  minimum: number
  maximum: number
  required?: boolean
  default?: number
}

export interface BooleanFieldDefinition extends FieldMeta {
  type: 'boolean'
  description: string
  required?: boolean
  default?: boolean
}

/** 字段按类型判别；integer 必须显式给出上下界，避免内部契约漏写时被 Infinity 掩盖。 */
export type FieldDefinition = StringFieldDefinition | IntegerFieldDefinition | BooleanFieldDefinition

export interface CommandDefinition {
  name: string
  description: string
  tool?: string
  write?: boolean
  /** 长期事件流命令：只能直接执行，不能走 application.execute 或 JSONL。 */
  stream?: true
  fields: Record<string, FieldDefinition>
}

/** contract.validate 的返回值：字段已按契约缩窄为标量。 */
export type ValidatedValue = string | number | boolean
export type ValidatedArgs = Record<string, ValidatedValue>

/** 只按“非 null 非数组对象”缩窄；调用方仍须继续检查字段。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** bridge run 的已校验入参共享 bridge 中唯一定义；未提供时由 bridge 按环境变量回退。 */
export type { BridgeRunArgs } from './bridge/main.mjs'

export type BridgeControlName = 'status' | 'stop'

/** application 对 CLI 暴露的有限接口；结果保持 unknown，由信封负责序列化。 */
export interface Application {
  execute: (name: string, input?: unknown, cli?: boolean) => Promise<unknown>
  close: () => void
}
