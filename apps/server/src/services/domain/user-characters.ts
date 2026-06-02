import type { Database } from '../../libs/db'

import { useLogger } from '@guiiai/logg'
import { and, eq, isNull } from 'drizzle-orm'

import * as schema from '../../schemas/user-characters'

const logger = useLogger('user-characters')

export function createUserCharactersService(db: Database) {
  return {
    /**
     * Retrieve all character cards for a given user (including soft-deleted tombstones).
     */
    async findAllForUser(ownerId: string) {
      return await db.select()
        .from(schema.userCharacters)
        .where(eq(schema.userCharacters.ownerId, ownerId))
    },

    /**
     * Finds a single character card by its ownerId and clientId.
     */
    async findByClientId(ownerId: string, clientId: string) {
      const [result] = await db.select()
        .from(schema.userCharacters)
        .where(
          and(
            eq(schema.userCharacters.ownerId, ownerId),
            eq(schema.userCharacters.clientId, clientId),
          ),
        )
      return result
    },

    /**
     * Upsert a character card using Last-Write-Wins (LWW) resolution.
     */
    async upsert(ownerId: string, clientId: string, rawCard: any, updatedAtStr: string) {
      const incomingTime = new Date(updatedAtStr).getTime()

      return await db.transaction(async (tx) => {
        const [existing] = await tx.select()
          .from(schema.userCharacters)
          .where(
            and(
              eq(schema.userCharacters.ownerId, ownerId),
              eq(schema.userCharacters.clientId, clientId),
            ),
          )

        if (!existing) {
          // Record does not exist, insert it fresh
          const [inserted] = await tx.insert(schema.userCharacters)
            .values({
              ownerId,
              clientId,
              rawCard,
              updatedAt: new Date(incomingTime),
              createdAt: new Date(incomingTime),
            })
            .returning()

          logger.withFields({ ownerId, clientId }).log('Inserted new user character card')
          return inserted
        }

        // Record exists, compare timestamps
        const existingTime = existing.updatedAt.getTime()
        const existingDeletedTime = existing.deletedAt ? existing.deletedAt.getTime() : 0
        const maxExistingTime = Math.max(existingTime, existingDeletedTime)

        if (incomingTime > maxExistingTime) {
          // Incoming update is newer, overwrite existing record and clear soft delete stamp
          const [updated] = await tx.update(schema.userCharacters)
            .set({
              rawCard,
              updatedAt: new Date(incomingTime),
              deletedAt: null, // Clear soft-delete if resurrected
            })
            .where(
              and(
                eq(schema.userCharacters.ownerId, ownerId),
                eq(schema.userCharacters.clientId, clientId),
              ),
            )
            .returning()

          logger.withFields({ ownerId, clientId }).log('Updated user character card via LWW')
          return updated
        }

        // Server record is newer, return the existing record without overwriting
        logger.withFields({ ownerId, clientId }).log('Skipped card upsert: server record is newer or same age')
        return existing
      })
    },

    /**
     * Soft delete a character card using LWW resolution.
     */
    async softDelete(ownerId: string, clientId: string, deletedAtStr?: string) {
      const incomingTime = deletedAtStr ? new Date(deletedAtStr).getTime() : Date.now()

      return await db.transaction(async (tx) => {
        const [existing] = await tx.select()
          .from(schema.userCharacters)
          .where(
            and(
              eq(schema.userCharacters.ownerId, ownerId),
              eq(schema.userCharacters.clientId, clientId),
            ),
          )

        if (!existing) {
          // If it doesn't exist, create a soft-deleted tombstone immediately to record the deletion
          const [tombstone] = await tx.insert(schema.userCharacters)
            .values({
              ownerId,
              clientId,
              rawCard: {}, // Empty placeholder
              updatedAt: new Date(incomingTime),
              deletedAt: new Date(incomingTime),
            })
            .returning()

          logger.withFields({ ownerId, clientId }).log('Created soft-deleted tombstone for non-existent card')
          return tombstone
        }

        // Compare timestamps
        const existingTime = existing.updatedAt.getTime()
        if (incomingTime > existingTime) {
          // Set soft delete tombstone
          const [updated] = await tx.update(schema.userCharacters)
            .set({
              deletedAt: new Date(incomingTime),
              updatedAt: new Date(incomingTime),
            })
            .where(
              and(
                eq(schema.userCharacters.ownerId, ownerId),
                eq(schema.userCharacters.clientId, clientId),
              ),
            )
            .returning()

          logger.withFields({ ownerId, clientId }).log('Soft-deleted user character card')
          return updated
        }

        logger.withFields({ ownerId, clientId }).log('Skipped soft-delete: existing server record is newer')
        return existing
      })
    },

    /**
     * Get the active clientId for the user.
     */
    async getActiveClientId(ownerId: string) {
      const [result] = await db.select()
        .from(schema.userActiveCharacter)
        .where(eq(schema.userActiveCharacter.ownerId, ownerId))
      return result ? result.activeClientId : null
    },

    /**
     * Set or update the active clientId for the user.
     */
    async setActiveClientId(ownerId: string, activeClientId: string) {
      return await db.transaction(async (tx) => {
        const [existing] = await tx.select()
          .from(schema.userActiveCharacter)
          .where(eq(schema.userActiveCharacter.ownerId, ownerId))

        if (!existing) {
          const [inserted] = await tx.insert(schema.userActiveCharacter)
            .values({
              ownerId,
              activeClientId,
              updatedAt: new Date(),
            })
            .returning()
          return inserted
        }

        const [updated] = await tx.update(schema.userActiveCharacter)
          .set({
            activeClientId,
            updatedAt: new Date(),
          })
          .where(eq(schema.userActiveCharacter.ownerId, ownerId))
          .returning()
        return updated
      })
    },

    /**
     * Hard delete all characters and active status for a user.
     * Used by the account deletion cascade.
     */
    async deleteAllForUser(ownerId: string) {
      const deletedChars = await db.delete(schema.userCharacters)
        .where(eq(schema.userCharacters.ownerId, ownerId))
        .returning()

      const deletedActive = await db.delete(schema.userActiveCharacter)
        .where(eq(schema.userActiveCharacter.ownerId, ownerId))
        .returning()

      logger.withFields({
        ownerId,
        cardsDeleted: deletedChars.length,
        activeDeleted: deletedActive.length,
      }).log('Hard deleted all user character sync rows for account cleanup')
    },
  }
}

export type UserCharactersService = ReturnType<typeof createUserCharactersService>
