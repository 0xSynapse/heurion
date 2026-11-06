import { randomBytes } from 'node:crypto'

/**
 * 无模偏的随机整数（拒绝采样）。
 * `randomBytes(4) % n` 会让小余数出现概率更高；生成认领码、验证码等短码时必须避免。
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new RangeError('maxExclusive must be an integer in 1..2^32')
  }
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive
  let value = 0
  do {
    value = randomBytes(4).readUInt32BE(0)
  } while (value >= limit)
  return value % maxExclusive
}
