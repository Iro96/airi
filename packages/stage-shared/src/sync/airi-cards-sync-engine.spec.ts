import { describe, expect, it, vi } from 'vitest'

import { AiriCardsSyncEngine } from './airi-cards-sync-engine'

describe('AiriCardsSyncEngine reconcile algorithm', () => {
  const engine = new AiriCardsSyncEngine(null)

  it('handles all-local-only cards by flagging them for upload', () => {
    const localCards = new Map<string, any>([
      ['card-1', { name: 'Card 1', updatedAt: '2026-06-02T10:00:00.000Z' }],
      ['card-2', { name: 'Card 2', updatedAt: '2026-06-02T11:00:00.000Z' }],
    ])

    const { updatedLocalMap, opsToUpload } = engine.reconcile(localCards, [])

    expect(updatedLocalMap.size).toBe(2)
    expect(opsToUpload).toEqual([
      { kind: 'upsert', clientId: 'card-1', updatedAt: '2026-06-02T10:00:00.000Z' },
      { kind: 'upsert', clientId: 'card-2', updatedAt: '2026-06-02T11:00:00.000Z' },
    ])
  })

  it('handles all-server-only cards by inserting valid ones and ignoring tombstones', () => {
    const serverCards = [
      {
        clientId: 'card-a',
        rawCard: { name: 'Card A' },
        updatedAt: '2026-06-02T10:00:00.000Z',
        deletedAt: null,
      },
      {
        clientId: 'card-b',
        rawCard: { name: 'Card B' },
        updatedAt: '2026-06-02T11:00:00.000Z',
        deletedAt: '2026-06-02T11:00:00.000Z', // Soft-deleted tombstone
      },
    ]

    const { updatedLocalMap, opsToUpload } = engine.reconcile(new Map(), serverCards)

    expect(updatedLocalMap.size).toBe(1)
    expect(updatedLocalMap.get('card-a')).toEqual({ name: 'Card A', updatedAt: '2026-06-02T10:00:00.000Z' })
    expect(updatedLocalMap.has('card-b')).toBe(false)
    expect(opsToUpload).toEqual([])
  })

  it('handles conflicts using Last-Write-Wins (LWW) resolution', () => {
    const localCards = new Map<string, any>([
      // Client newer -> should upload
      ['card-c1', { name: 'Card 1 (local newer)', updatedAt: '2026-06-02T12:00:00.000Z' }],
      // Server newer (valid) -> should download server card
      ['card-c2', { name: 'Card 2 (local older)', updatedAt: '2026-06-02T10:00:00.000Z' }],
      // Server newer (deleted) -> should delete local card
      ['card-c3', { name: 'Card 3 (local older)', updatedAt: '2026-06-02T10:00:00.000Z' }],
    ])

    const serverCards = [
      {
        clientId: 'card-c1',
        rawCard: { name: 'Card 1 (server older)' },
        updatedAt: '2026-06-02T10:00:00.000Z',
        deletedAt: null,
      },
      {
        clientId: 'card-c2',
        rawCard: { name: 'Card 2 (server newer)' },
        updatedAt: '2026-06-02T12:00:00.000Z',
        deletedAt: null,
      },
      {
        clientId: 'card-c3',
        rawCard: { name: 'Card 3 (server newer deleted)' },
        updatedAt: '2026-06-02T12:00:00.000Z',
        deletedAt: '2026-06-02T12:00:00.000Z',
      },
    ]

    const { updatedLocalMap, opsToUpload } = engine.reconcile(localCards, serverCards)

    // card-c1 remains local version, flags for upload
    expect(updatedLocalMap.get('card-c1')).toEqual({ name: 'Card 1 (local newer)', updatedAt: '2026-06-02T12:00:00.000Z' })
    expect(opsToUpload).toEqual([
      { kind: 'upsert', clientId: 'card-c1', updatedAt: '2026-06-02T12:00:00.000Z' },
    ])

    // card-c2 is updated with server newer version
    expect(updatedLocalMap.get('card-c2')).toEqual({ name: 'Card 2 (server newer)', updatedAt: '2026-06-02T12:00:00.000Z' })

    // card-c3 is deleted locally due to newer server tombstone
    expect(updatedLocalMap.has('card-c3')).toBe(false)
  })
})

describe('AiriCardsSyncEngine flushOps', () => {
  it('correctly executes PUT and DELETE HTTP requests via apiClient', async () => {
    const putMock = vi.fn().mockResolvedValue({ ok: true })
    const deleteMock = vi.fn().mockResolvedValue({ ok: true })

    const apiClientMock = {
      api: {
        v1: {
          'user-characters': {
            ':clientId': {
              $put: putMock,
              $delete: deleteMock,
            },
          },
        },
      },
    }

    const engine = new AiriCardsSyncEngine(apiClientMock)
    const ops: Record<string, any> = {
      'card-u1': { kind: 'upsert', clientId: 'card-u1', updatedAt: '2026-06-02T10:00:00.000Z' },
      'card-d1': { kind: 'delete', clientId: 'card-d1', updatedAt: '2026-06-02T11:00:00.000Z' },
    }

    const getCardPayload = (id: string) => {
      if (id === 'card-u1') return { name: 'Card U1' }
      return null
    }

    const syncedIds = await engine.flushOps(ops, getCardPayload)

    expect(syncedIds).toEqual(['card-u1', 'card-d1'])
    expect(putMock).toHaveBeenCalledWith({
      param: { clientId: 'card-u1' },
      json: {
        rawCard: { name: 'Card U1' },
        updatedAt: '2026-06-02T10:00:00.000Z',
      },
    })
    expect(deleteMock).toHaveBeenCalledWith({
      param: { clientId: 'card-d1' },
      json: {
        deletedAt: '2026-06-02T11:00:00.000Z',
      },
    })
  })
})
