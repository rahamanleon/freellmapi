// @vitest-environment jsdom
//
// #1399: the desktop app's dashboard opened in a normal browser tab has no
// preload bridge. When the server reports `desktop: true` (a desktop install,
// a request from this computer) the gate fetches a session from
// /api/auth/desktop-session and never shows the Sign In form. Without the flag
// (web and Docker installs) the form stays.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { AuthGate } from './auth-gate'

const MINTED = 'minted-desktop-session'

let root: Root
let container: HTMLDivElement
let desktopFlag: boolean
let sessionCalls: number

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <AuthGate><div data-testid="app">dashboard</div></AuthGate>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  desktopFlag = true
  sessionCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/auth/desktop-session')) {
      sessionCalls++
      return desktopFlag ? json({ token: MINTED }) : json({ error: { message: 'forbidden' } }, 403)
    }
    if (url.endsWith('/api/auth/status')) {
      const ok = new Headers(init?.headers).get('Authorization') === `Bearer ${MINTED}`
      return json({ needsSetup: false, authenticated: ok, email: ok ? 'desktop@localhost' : null, desktop: desktopFlag })
    }
    return json({ error: { message: `unexpected ${url}` } }, 404)
  }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('AuthGate in a browser tab on a desktop install (#1399)', () => {
  it('signs in through the server and never shows the Sign In form', async () => {
    mount()
    await flush()
    expect(sessionCalls).toBe(1)
    expect(container.querySelector('[data-testid="app"]')).not.toBeNull()
    expect(container.querySelector('input[type="password"]')).toBeNull()
  })

  it('keeps the Sign In form when the server does not report a desktop install', async () => {
    desktopFlag = false
    mount()
    await flush()
    expect(sessionCalls).toBe(0)
    expect(container.querySelector('[data-testid="app"]')).toBeNull()
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
  })
})
