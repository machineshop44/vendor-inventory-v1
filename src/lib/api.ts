import type { Item } from './types.ts'

export class ApiError extends Error {
  code?: string
  item?: Item

  constructor(message: string, code?: string, item?: Item) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.item = item
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch {
    throw new ApiError('The inventory app is not running. Start it and refresh this page.')
  }

  const text = await response.text()
  let body: (T & { error?: string; code?: string; item?: Item }) | { error?: string; code?: string; item?: Item } = {}
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string; code?: string; item?: Item }
    } catch {
      body = { error: 'Something went wrong. Try that again.' }
    }
  }

  if (!response.ok) {
    throw new ApiError(body.error || 'Something went wrong. Try that again.', body.code, body.item)
  }

  return body as T
}
