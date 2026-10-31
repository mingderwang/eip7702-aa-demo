import { formatEther } from 'viem'

/** Format wei as ETH with a stable, human-readable precision. */
export function formatEth(wei: bigint | null | undefined, digits = 6): string {
  if (wei === null || wei === undefined) return '—'
  const value = Number(formatEther(wei))
  const fixed = value.toFixed(digits)
  const trimmed = fixed.replace(/\.?0+$/, '')
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed
}

/** Signed delta between two balances, e.g. `-0.001234`. */
export function formatDelta(before: bigint | null | undefined, after: bigint | null | undefined): string {
  if (before === null || before === undefined || after === null || after === undefined) return '—'
  const diff = after - before
  if (diff === 0n) return '0'
  const sign = diff > 0n ? '+' : '-'
  const abs = diff < 0n ? -diff : diff
  return `${sign}${formatEth(abs, 6)}`
}

/** Shorten a hex string for display: `0x1234…abcd`. */
export function shortHex(value: string | null | undefined, lead = 6, tail = 4): string {
  if (!value) return '—'
  if (value.length <= lead + tail + 2) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

export function shortAddress(address: string | null | undefined): string {
  return shortHex(address, 6, 4)
}
