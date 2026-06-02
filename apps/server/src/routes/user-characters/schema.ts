import { any, object, optional, string } from 'valibot'

export const PutUserCharacterSchema = object({
  rawCard: any(),
  updatedAt: string(),
})

export const DeleteUserCharacterSchema = object({
  deletedAt: optional(string()),
})

export const PutActiveCharacterSchema = object({
  activeClientId: string(),
})
