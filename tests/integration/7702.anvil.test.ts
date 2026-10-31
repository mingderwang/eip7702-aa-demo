import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { ANVIL_MNEMONIC, startAnvil, type AnvilInstance } from '../../scripts/lib/anvil'
import { batchExecutorAbi, batchExecutorBytecode } from '../../src/lib/generated/batchExecutor'
import { decodeDesignator, ERC1271_MAGIC } from '../../src/lib/eip7702'
import { buildDelegatedBatchTx, buildPlainTx, quoteFees } from '../../src/lib/tx'

let instance: AnvilInstance
let publicClient: PublicClient
let funderWallet: WalletClient
let implementation: Address

const mnemonic = ANVIL_MNEMONIC
// Fresh, keyless recipients so pre-funded anvil accounts do not skew balance assertions.
const recipientA = privateKeyToAccount(generatePrivateKey()).address
const recipientB = privateKeyToAccount(generatePrivateKey()).address

async function fund(to: Address, value: bigint) {
  const hash = await funderWallet.sendTransaction({ account: funderWallet.account!, chain: anvil, to, value })
  await publicClient.waitForTransactionReceipt({ hash })
}

async function broadcast(raw: Hex): Promise<Hex> {
  return publicClient.request({ method: 'eth_sendRawTransaction', params: [raw] })
}

beforeAll(async () => {
  instance = await startAnvil()
  publicClient = createPublicClient({ chain: anvil, transport: http(instance.rpcUrl) })
  const funder = mnemonicToAccount(mnemonic)
  funderWallet = createWalletClient({ account: funder, chain: anvil, transport: http(instance.rpcUrl) })

  const hash = await funderWallet.deployContract({
    abi: batchExecutorAbi,
    bytecode: batchExecutorBytecode,
    chain: anvil,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error('BatchExecutor deployment failed')
  implementation = receipt.contractAddress
}, 90_000)

afterAll(async () => {
  await instance?.stop()
})

describe('EIP-7702 delegation on anvil (prague)', () => {
  test('one type-0x04 transaction delegates the EOA and executes a batch', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({ account, chain: anvil, transport: http(instance.rpcUrl) })

    await fund(account.address, parseEther('0.01'))

    const balanceBefore = await publicClient.getBalance({ address: account.address })
    const nonceBefore = await publicClient.getTransactionCount({ address: account.address })

    const built = await buildDelegatedBatchTx({
      publicClient,
      wallet,
      account,
      implementation,
      chainId: anvil.id,
      calls: [
        { to: recipientA, value: parseEther('0.001'), data: '0x' },
        { to: recipientB, value: parseEther('0.0005'), data: '0x' },
      ],
    })

    // the authorization must be scoped to txNonce + 1
    expect(built.authorization?.nonce).toBe(built.nonce + 1n)
    expect(built.raw.slice(0, 4)).toBe('0x04')

    const hash = await broadcast(built.raw)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    expect(receipt.status).toBe('success')
    expect(receipt.type).toBe('eip7702')
    expect(receipt.from.toLowerCase()).toBe(account.address.toLowerCase())
    expect(receipt.to?.toLowerCase()).toBe(account.address.toLowerCase())

    // 1. the EOA now carries the delegation designator 0xef0100 || implementation
    const code = await publicClient.getCode({ address: account.address })
    const designator = decodeDesignator(code)
    expect(designator.delegated).toBe(true)
    if (!designator.delegated) throw new Error('unreachable')
    expect(designator.implementation.toLowerCase()).toBe(implementation.toLowerCase())
    expect(code?.toLowerCase().startsWith('0xef0100')).toBe(true)

    // 2. both batch calls executed
    expect(await publicClient.getBalance({ address: recipientA })).toBe(parseEther('0.001'))
    expect(await publicClient.getBalance({ address: recipientB })).toBe(parseEther('0.0005'))

    // 3. the account paid for its own transaction: value + gas
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
    const balanceAfter = await publicClient.getBalance({ address: account.address })
    expect(balanceAfter).toBe(balanceBefore - parseEther('0.0015') - gasCost)
    expect(gasCost).toBeGreaterThan(0n)

    // 4. nonce advanced by 2: the type-4 tx itself + the applied authorization
    const nonceAfter = await publicClient.getTransactionCount({ address: account.address })
    expect(nonceAfter).toBe(nonceBefore + 2)

    // 5. the delegated account is a real smart account: ERC-1271 signature validation
    const messageHash = `0x${'11'.repeat(32)}` as Hex
    const signature = await account.sign({ hash: messageHash })
    const magic = await publicClient.readContract({
      address: account.address,
      abi: batchExecutorAbi,
      functionName: 'isValidSignature',
      args: [messageHash, signature],
    })
    expect(magic).toBe(ERC1271_MAGIC)

    // 6. the batch emitted Executed from the account address
    const executed = receipt.logs
      .filter((log) => log.address.toLowerCase() === account.address.toLowerCase())
      .map((log) => {
        try {
          return decodeEventLog({ abi: batchExecutorAbi, data: log.data, topics: log.topics })
        } catch {
          return null
        }
      })
      .filter((event) => event?.eventName === 'Executed')
    expect(executed.length).toBe(1)
    expect(executed[0]!.args).toMatchObject({ callCount: 2n, totalValue: parseEther('0.0015') })
  }, 60_000)

  test('a second transaction runs without re-delegating', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({ account, chain: anvil, transport: http(instance.rpcUrl) })
    await fund(account.address, parseEther('0.01'))

    const first = await buildDelegatedBatchTx({
      publicClient,
      wallet,
      account,
      implementation,
      chainId: anvil.id,
      calls: [{ to: recipientA, value: 0n, data: '0x' }],
    })
    await publicClient.waitForTransactionReceipt({ hash: await broadcast(first.raw) })

    const before = await publicClient.getBalance({ address: recipientA })
    const second = await buildPlainTx({
      publicClient,
      wallet,
      account,
      to: recipientA,
      value: parseEther('0.0002'),
      chainId: anvil.id,
    })
    expect(second.authorization).toBeNull()
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await broadcast(second.raw) })

    expect(receipt.status).toBe('success')
    expect(await publicClient.getBalance({ address: recipientA })).toBe(before + parseEther('0.0002'))

    const designator = decodeDesignator(await publicClient.getCode({ address: account.address }))
    expect(designator.delegated).toBe(true)
  }, 60_000)

  test('an authorization with a stale nonce is skipped (no delegation)', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({ account, chain: anvil, transport: http(instance.rpcUrl) })
    await fund(account.address, parseEther('0.01'))

    const nonce = BigInt(await publicClient.getTransactionCount({ address: account.address }))
    const fees = await quoteFees(publicClient)
    const staleAuth = await wallet.signAuthorization({
      account,
      contractAddress: implementation,
      chainId: anvil.id,
      nonce: nonce + 2n, // wrong: must be nonce + 1
    })

    const raw = await wallet.signTransaction({
      account,
      chainId: anvil.id,
      to: account.address,
      data: '0x',
      nonce,
      gas: 100_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      authorizationList: [staleAuth],
    })

    const receipt = await publicClient.waitForTransactionReceipt({ hash: await broadcast(raw) })
    expect(receipt.status).toBe('success')
    expect(await publicClient.getCode({ address: account.address })).toBeUndefined()

    const nonceAfter = await publicClient.getTransactionCount({ address: account.address })
    expect(nonceAfter).toBe(Number(nonce) + 1)
  }, 60_000)

  test('third parties cannot call execute() on a delegated account', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({ account, chain: anvil, transport: http(instance.rpcUrl) })
    await fund(account.address, parseEther('0.01'))

    const built = await buildDelegatedBatchTx({
      publicClient,
      wallet,
      account,
      implementation,
      chainId: anvil.id,
      calls: [{ to: recipientA, value: 0n, data: '0x' }],
    })
    await publicClient.waitForTransactionReceipt({ hash: await broadcast(built.raw) })

    const attacker = mnemonicToAccount(mnemonic, { addressIndex: 7 })
    await expect(
      publicClient.simulateContract({
        address: account.address,
        abi: batchExecutorAbi,
        functionName: 'execute',
        args: [[]],
        account: attacker,
      }),
    ).rejects.toThrow(/NotSelf/)
  }, 60_000)

  test('a delegated account can still receive ETH', async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({ account, chain: anvil, transport: http(instance.rpcUrl) })
    await fund(account.address, parseEther('0.01'))

    const built = await buildDelegatedBatchTx({
      publicClient,
      wallet,
      account,
      implementation,
      chainId: anvil.id,
      calls: [{ to: recipientA, value: 0n, data: '0x' }],
    })
    await publicClient.waitForTransactionReceipt({ hash: await broadcast(built.raw) })

    const before = await publicClient.getBalance({ address: account.address })
    await fund(account.address, parseEther('0.001'))
    expect(await publicClient.getBalance({ address: account.address })).toBe(before + parseEther('0.001'))
  }, 60_000)
})
