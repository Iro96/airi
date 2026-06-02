export interface SyncOp {
  kind: 'upsert' | 'delete'
  clientId: string
  updatedAt: string
}

export interface SyncState {
  status: 'offline' | 'unauthenticated' | 'syncing' | 'synced' | 'error'
  pendingOps: Record<string, SyncOp>
  lastSyncedAt: number | null
  lastError: string | null
}

export class AiriCardsSyncEngine {
  private apiClient: any

  constructor(apiClient: any) {
    this.apiClient = apiClient
  }

  /**
   * Reconciliation algorithm (First-Sync).
   * Combines local cards Map with server cards array, resolving conflicts using LWW.
   *
   * @param localCards Map of local clientIds to card payloads (payloads should contain updatedAt)
   * @param serverCards Array of cards from server containing { clientId, rawCard, updatedAt, deletedAt }
   * @returns {
   *   updatedLocalMap: Map of resolved cards to save locally,
   *   opsToUpload: Array of operations (upserts/deletes) that client needs to upload to server
   * }
   */
  reconcile(
    localCards: Map<string, any>,
    serverCards: Array<{ clientId: string, rawCard: any, updatedAt: string, deletedAt: string | null }>,
  ) {
    const updatedLocalMap = new Map<string, any>(localCards)
    const opsToUpload: SyncOp[] = []

    // Index server cards by clientId for fast lookups
    const serverCardsMap = new Map<string, typeof serverCards[0]>()
    for (const sc of serverCards) {
      serverCardsMap.set(sc.clientId, sc)
    }

    // Build the complete set of clientIds
    const allClientIds = new Set<string>([
      ...localCards.keys(),
      ...serverCardsMap.keys(),
    ])

    for (const clientId of allClientIds) {
      const localCard = localCards.get(clientId)
      const serverCard = serverCardsMap.get(clientId)

      if (localCard && !serverCard) {
        // V1/Local Only: Server does not have it -> upload it
        const updatedAt = localCard.updatedAt || new Date().toISOString()
        opsToUpload.push({
          kind: 'upsert',
          clientId,
          updatedAt,
        })
      }
      else if (!localCard && serverCard) {
        // Server Only: Local does not have it -> check if deleted (tombstone)
        if (serverCard.deletedAt) {
          // Soft-deleted on server, do not download, ignore tombstone
          continue
        }
        // Valid card on server -> save to local
        const cardWithUpdatedAt = {
          ...serverCard.rawCard,
          updatedAt: serverCard.updatedAt,
        }
        updatedLocalMap.set(clientId, cardWithUpdatedAt)
      }
      else if (localCard && serverCard) {
        // Both exist: perform Last-Write-Wins (LWW) comparison
        const localTime = new Date(localCard.updatedAt || 0).getTime()
        const serverTime = new Date(serverCard.updatedAt).getTime()
        const serverDeletedTime = serverCard.deletedAt ? new Date(serverCard.deletedAt).getTime() : 0
        const maxServerTime = Math.max(serverTime, serverDeletedTime)

        if (localTime > maxServerTime) {
          // Client has a newer version -> upload it
          opsToUpload.push({
            kind: 'upsert',
            clientId,
            updatedAt: localCard.updatedAt,
          })
        }
        else if (maxServerTime > localTime) {
          // Server has a newer version
          if (serverCard.deletedAt) {
            // Server version is newer and is deleted -> remove local copy
            updatedLocalMap.delete(clientId)
          }
          else {
            // Server version is newer and is valid -> overwrite local card
            const cardWithUpdatedAt = {
              ...serverCard.rawCard,
              updatedAt: serverCard.updatedAt,
            }
            updatedLocalMap.set(clientId, cardWithUpdatedAt)
          }
        }
        // If timestamps are equal, they are already in sync. No action needed.
      }
    }

    return {
      updatedLocalMap,
      opsToUpload,
    }
  }

  /**
   * Pull all cards and active card status from the server, reconciles them, and updates local state.
   */
  async pullAndReconcile(
    localCards: Map<string, any>,
    updateLocalState: (cards: Map<string, any>, activeCardId?: string) => void,
  ) {
    try {
      const [cardsRes, activeRes] = await Promise.all([
        this.apiClient.api.v1['user-characters'].$get(),
        this.apiClient.api.v1['user-characters'].active.$get(),
      ])

      if (!cardsRes.ok || !activeRes.ok) {
        throw new Error(`Sync pull failed with status: ${cardsRes.status} / ${activeRes.status}`)
      }

      const serverCards = await cardsRes.json()
      const { activeClientId } = await activeRes.json()

      const { updatedLocalMap, opsToUpload } = this.reconcile(localCards, serverCards)

      // Apply updates to local state
      updateLocalState(updatedLocalMap, activeClientId || undefined)

      return {
        success: true,
        opsToUpload,
      }
    }
    catch (error: any) {
      logger.withError(error).error('Failed to pull and reconcile from server')
      throw error
    }
  }

  /**
   * Flush a specific list of pending operations to the server.
   *
   * @param ops Record of clientId to SyncOp
   * @param getCardPayload Callback to get the raw AiriCard for a clientId from client store
   * @returns List of clientIds successfully synced
   */
  async flushOps(
    ops: Record<string, SyncOp>,
    getCardPayload: (clientId: string) => any,
  ): Promise<string[]> {
    const successClientIds: string[] = []

    for (const [clientId, op] of Object.entries(ops)) {
      try {
        if (op.kind === 'upsert') {
          const rawCard = getCardPayload(clientId)
          if (!rawCard) {
            // Card is deleted locally, degrade gracefully to delete
            const delRes = await this.apiClient.api.v1['user-characters'][':clientId'].$delete({
              param: { clientId },
              json: { deletedAt: op.updatedAt },
            })
            if (delRes.ok)
              successClientIds.push(clientId)
            continue
          }

          const res = await this.apiClient.api.v1['user-characters'][':clientId'].$put({
            param: { clientId },
            json: {
              rawCard,
              updatedAt: op.updatedAt,
            },
          })

          if (res.ok) {
            successClientIds.push(clientId)
          }
          else {
            throw new Error(`Failed to upload card ${clientId}: ${res.statusText}`)
          }
        }
        else if (op.kind === 'delete') {
          const res = await this.apiClient.api.v1['user-characters'][':clientId'].$delete({
            param: { clientId },
            json: { deletedAt: op.updatedAt },
          })

          if (res.ok) {
            successClientIds.push(clientId)
          }
          else {
            throw new Error(`Failed to delete card ${clientId}: ${res.statusText}`)
          }
        }
      }
      catch (err) {
        // Stop flushing on error to preserve order and avoid queue desyncs
        console.error(`Error syncing card ${clientId}:`, err)
        break
      }
    }

    return successClientIds
  }

  /**
   * Push the active character selection to the server.
   */
  async pushActiveCardId(activeClientId: string) {
    const res = await this.apiClient.api.v1['user-characters'].active.$put({
      json: { activeClientId },
    })
    if (!res.ok) {
      throw new Error(`Failed to sync active character: ${res.statusText}`)
    }
  }
}

// Simple fallback logger for client contexts
const logger = {
  error: (msg: string) => console.error(msg),
  withError: (err: any) => ({
    error: (msg: string) => console.error(`${msg}:`, err),
  }),
}
