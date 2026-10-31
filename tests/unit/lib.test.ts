import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, getAddress, parseEther } from 'viem'
import { decodeDesignator, DELEGATION_PREFIX, encodeExecute, ERC1271_MAGIC, authorizationNonce } from '../../src/lib/eip7702'
import { formatDelta, formatEth, shortHex } from '../../src/lib/format'
import { batchExecutorAbi } from '../../src/lib/generated/batchExecutor'
import { explorerTxUrl } from '../../src/lib/chain'

const IMPL = '0x1234567890abcdef1234567890abcdef12345678'
const TO = '0x000000000000000000000000000000000000dEaD'

describe('decodeDesignator', () => {
  test('plain EOA has no code', () => {
    expect(decodeDesignator('0x')).toEqual({ delegated: false, code: null })
    expect(decodeDesignator(undefined)).toEqual({ delegated: false, code: null })
  })

  test('decodes 0xef0100 || implementation', () => {
    const result = decodeDesignator(`${DELEGATION_PREFIX}${IMPL.slice(2)}` as `0x${string}`)
    expect(result.delegated).toBe(true)
    if (result.delegated) expect(result.implementation).toBe(IMPL)
  })

  test('is case insensitive', () => {
    const result = decodeDesignator(`0xEF0100${IMPL.slice(2).toUpperCase()}` as `0x${string}`)
    expect(result.delegated).toBe(true)
    if (result.delegated) expect(result.implementation).toBe(IMPL)
  })

  test('rejects malformed designators', () => {
    expect(decodeDesignator('0xef0100deadbeef' as `0x${string}`).delegated).toBe(false)
    expect(decodeDesignator('0x6080604052' as `0x${string}`).delegated).toBe(false)
  })
})

describe('encodeExecute', () => {
  test('round-trips a batch of calls', () => {
    const calls = [
      { to: TO, value: parseEther('0.001'), data: '0x' as const },
      { to: IMPL, value: 0n, data: '0xdeadbeef' as const },
    ]
    const encoded = encodeExecute(calls)
    const decoded = decodeFunctionData({ abi: batchExecutorAbi, data: encoded })
    expect(decoded.functionName).toBe('execute')
    expect(decoded.args?.[0]).toEqual([
      { to: getAddress(TO), value: parseEther('0.001'), data: '0x' },
      { to: getAddress(IMPL), value: 0n, data: '0xdeadbeef' },
    ])
  })
})

describe('authorizationNonce', () => {
  test('is tx nonce + 1 for self-executing type-4 transactions', () => {
    expect(authorizationNonce(0n)).toBe(1n)
    expect(authorizationNonce(41n)).toBe(42n)
  })
})

describe('formatting', () => {
  test('formats ETH without trailing zeros', () => {
    expect(formatEth(parseEther('1'))).toBe('1')
    expect(formatEth(parseEther('0.01'))).toBe('0.01')
    expect(formatEth(0n)).toBe('0')
    expect(formatEth(null)).toBe('—')
  })

  test('formats signed deltas', () => {
    expect(formatDelta(parseEther('0.01'), parseEther('0.008'))).toBe('-0.002')
    expect(formatDelta(0n, parseEther('0.01'))).toBe('+0.01')
    expect(formatDelta(parseEther('1'), parseEther('1'))).toBe('0')
  })

  test('shortens hex', () => {
    expect(shortHex('0x1234567890abcdef', 6, 4)).toBe('0x1234…cdef')
    expect(shortHex('0x1234')).toBe('0x1234')
  })
})

describe('constants and links', () => {
  test('ERC-1271 magic value', () => {
    expect(ERC1271_MAGIC).toBe('0x1626ba7e')
  })

  test('explorer links only for Sepolia', () => {
    expect(explorerTxUrl(11155111, '0xabc')).toBe('https://sepolia.etherscan.io/tx/0xabc')
    expect(explorerTxUrl(31337, '0xabc')).toBeNull()
  })
})
