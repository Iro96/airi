import type { UserCharactersService } from '../../services/domain/user-characters'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { safeParse } from 'valibot'

import { authGuard } from '../../middlewares/auth'
import { createBadRequestError } from '../../utils/error'
import { DeleteUserCharacterSchema, PutActiveCharacterSchema, PutUserCharacterSchema } from './schema'

export function createUserCharactersRoutes(userCharactersService: UserCharactersService) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)

    .get('/', async (c) => {
      const user = c.get('user')!
      const characters = await userCharactersService.findAllForUser(user.id)
      return c.json(characters)
    })

    .put('/:clientId', async (c) => {
      const user = c.get('user')!
      const clientId = c.req.param('clientId')

      const body = await c.req.json()
      const result = safeParse(PutUserCharacterSchema, body)
      if (!result.success) {
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)
      }

      const char = await userCharactersService.upsert(
        user.id,
        clientId,
        result.output.rawCard,
        result.output.updatedAt,
      )
      return c.json(char)
    })

    .delete('/:clientId', async (c) => {
      const user = c.get('user')!
      const clientId = c.req.param('clientId')

      // body can be optional for delete
      const body = await c.req.json().catch(() => ({}))
      const result = safeParse(DeleteUserCharacterSchema, body)
      if (!result.success) {
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)
      }

      const deleted = await userCharactersService.softDelete(
        user.id,
        clientId,
        result.output.deletedAt,
      )
      return c.json(deleted)
    })

    .get('/active', async (c) => {
      const user = c.get('user')!
      const activeClientId = await userCharactersService.getActiveClientId(user.id)
      return c.json({ activeClientId })
    })

    .put('/active', async (c) => {
      const user = c.get('user')!
      const body = await c.req.json()
      const result = safeParse(PutActiveCharacterSchema, body)
      if (!result.success) {
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', result.issues)
      }

      const active = await userCharactersService.setActiveClientId(
        user.id,
        result.output.activeClientId,
      )
      return c.json({ activeClientId: active.activeClientId })
    })
}
