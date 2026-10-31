import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

export type AnvilInstance = {
  rpcUrl: string
  port: number
  proc: ChildProcessWithoutNullStreams
  stop: () => Promise<void>
}

export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to allocate a port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function waitForRpc(rpcUrl: string, proc: ChildProcessWithoutNullStreams, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let stderr = ''
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`anvil exited early (code ${proc.exitCode}): ${stderr}`)
    }
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (response.ok) {
        const body = (await response.json()) as { result?: string }
        if (body.result) return
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  throw new Error(`anvil did not become ready at ${rpcUrl}: ${stderr}`)
}

/** Spawn a throwaway anvil node with the Prague hardfork (EIP-7702 enabled). */
export async function startAnvil(options?: { port?: number; silent?: boolean }): Promise<AnvilInstance> {
  const port = options?.port ?? (await getFreePort())
  const proc = spawn(
    'anvil',
    ['--port', String(port), '--hardfork', 'prague', '--chain-id', '31337', '--base-fee', '1000000000', '--silent'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const rpcUrl = `http://127.0.0.1:${port}`
  await waitForRpc(rpcUrl, proc)

  return {
    rpcUrl,
    port,
    proc,
    stop: async () => {
      if (proc.exitCode !== null) return
      proc.kill('SIGTERM')
      await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
      if (proc.exitCode === null) proc.kill('SIGKILL')
    },
  }
}
