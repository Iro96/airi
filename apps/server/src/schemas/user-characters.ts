import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { nanoid } from '../utils/id'

// NOTICE: bare ownerId is intentional — no FK to user.id. better-auth hard-deletes
// the user row; a cascade would wipe these soft-delete archive rows.
// See `apps/server/docs/ai-context/account-deletion.md`.
export const userCharacters = pgTable(
  'user_characters',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    ownerId: text('owner_id').notNull(),

    // client-side nanoid, stays stable across devices. Used as PUT idempotency key.
    clientId: text('client_id').notNull(),

    // Lossless storage of CCv3 payload + Airi extension.
    rawCard: jsonb('raw_card').notNull().$type<any>(),

    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  table => [
    uniqueIndex('user_characters_owner_client_uniq').on(table.ownerId, table.clientId),
    index('user_characters_owner_idx').on(table.ownerId),
  ],
)

export type UserCharacter = InferSelectModel<typeof userCharacters>
export type NewUserCharacter = InferInsertModel<typeof userCharacters>

export const userActiveCharacter = pgTable(
  'user_active_character',
  {
    ownerId: text('owner_id').primaryKey(),
    activeClientId: text('active_client_id').notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
)

export type UserActiveCharacter = InferSelectModel<typeof userActiveCharacter>
export type NewUserActiveCharacter = InferInsertModel<typeof userActiveCharacter>
