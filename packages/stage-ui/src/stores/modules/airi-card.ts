import type { Card, ccv3 } from '@proj-airi/ccc'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { AiriCardsSyncEngine, type SyncOp, type SyncState } from '@proj-airi/stage-shared'
import { watchDebounced, useLocalStorage, useWindowFocus } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import SystemPromptV2 from '../../constants/prompts/system-v2'

import { DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT } from '../../constants/prompts/character-defaults'
import { capturePosthogEvent } from '../analytics/posthog'
import { useSettingsStageModel } from '../settings/stage-model'
import { useArtistryStore } from './artistry'
import { useConsciousnessStore } from './consciousness'
import { useSpeechStore } from './speech'
import { client } from '../../composables/api'
import { useAuthStore } from '../auth'

export interface AiriExtension {
  modules: {
    consciousness: {
      provider: string // Example: "openai"
      model: string // Example: "gpt-4o"
    }

    speech: {
      provider: string // Example: "elevenlabs"
      model: string // Example: "eleven_multilingual_v2"
      voice_id: string // Example: "alloy"

      pitch?: number
      rate?: number
      ssml?: boolean
      language?: string
    }

    vrm?: {
      source?: 'file' | 'url'
      file?: string // Example: "vrm/model.vrm"
      url?: string // Example: "https://example.com/vrm/model.vrm"
    }

    live2d?: {
      source?: 'file' | 'url'
      file?: string // Example: "live2d/model.json"
      url?: string // Example: "https://example.com/live2d/model.json"
    }

    // ID from display-models store (e.g. 'preset-live2d-1', 'display-model-<nanoid>')
    displayModelId?: string
    activeBackgroundId?: string

    artistry?: {
      enabled?: boolean
      provider?: string
      model?: string
      promptPrefix?: string
      workflowId?: string
      widgetInstruction?: string
      spawnMode?: 'bg' | 'widget' | 'inline' | 'bg_widget'
      options?: Record<string, any>
      autonomousEnabled?: boolean
      autonomousThreshold?: number
      autonomousTarget?: 'user' | 'assistant'
    }
  }

  agents: {
    [key: string]: { // example: minecraft
      prompt: string
      enabled?: boolean
    }
  }
}

export interface AiriCard extends Card {
  updatedAt?: string
  extensions: {
    airi: AiriExtension
  } & Card['extensions']
}

export const useAiriCardStore = defineStore('airi-card', () => {
  const { t } = useI18n()

  const cards = useLocalStorageManualReset<Map<string, AiriCard>>('airi-cards', new Map())
  const activeCardId = useLocalStorageManualReset<string>('airi-card-active-id', 'default')

  const activeCard = computed(() => cards.value.get(activeCardId.value))

  const consciousnessStore = useConsciousnessStore()
  const speechStore = useSpeechStore()
  const artistryStore = useArtistryStore()
  const stageModelStore = useSettingsStageModel()

  const {
    activeProvider: activeConsciousnessProvider,
    activeModel: activeConsciousnessModel,
  } = storeToRefs(consciousnessStore)

  const {
    activeSpeechProvider,
    activeSpeechVoiceId,
    activeSpeechModel,
  } = storeToRefs(speechStore)

  // Cloud Sync setup
  const authStore = useAuthStore()
  const syncEngine = new AiriCardsSyncEngine(client)
  const syncState = useLocalStorage<SyncState>('airi-cards-sync-state', {
    status: 'unauthenticated',
    pendingOps: {},
    lastSyncedAt: null,
    lastError: null,
  })

  let isSyncing = false
  async function flushQueue() {
    if (isSyncing)
      return
    if (!authStore.isAuthenticated) {
      syncState.value.status = 'unauthenticated'
      return
    }

    const opsToSync = { ...syncState.value.pendingOps }
    if (Object.keys(opsToSync).length === 0) {
      syncState.value.status = 'synced'
      return
    }

    isSyncing = true
    syncState.value.status = 'syncing'

    try {
      const successIds = await syncEngine.flushOps(opsToSync, id => cards.value.get(id))
      
      // Clear successfully synced operations
      for (const id of successIds) {
        delete syncState.value.pendingOps[id]
      }

      syncState.value.lastSyncedAt = Date.now()
      syncState.value.lastError = null

      if (Object.keys(syncState.value.pendingOps).length === 0) {
        syncState.value.status = 'synced'
      }
      else {
        syncState.value.status = 'error'
      }
    }
    catch (err: any) {
      syncState.value.status = 'error'
      syncState.value.lastError = err.message || String(err)
    }
    finally {
      isSyncing = false
    }
  }

  function enqueueUpsert(clientId: string, updatedAt: string) {
    syncState.value.pendingOps[clientId] = {
      kind: 'upsert',
      clientId,
      updatedAt,
    }
    void flushQueue() // Trigger immediate sync attempt
  }

  function enqueueDelete(clientId: string, deletedAt: string) {
    syncState.value.pendingOps[clientId] = {
      kind: 'delete',
      clientId,
      updatedAt: deletedAt,
    }
    void flushQueue()
  }

  async function pullAndReconcile() {
    if (!authStore.isAuthenticated)
      return

    syncState.value.status = 'syncing'
    try {
      const res = await syncEngine.pullAndReconcile(
        cards.value,
        (updatedMap, serverActiveId) => {
          cards.value = updatedMap
          if (serverActiveId && cards.value.has(serverActiveId) && activeCardId.value !== serverActiveId) {
            activeCardId.value = serverActiveId
          }
        },
      )

      if (res.opsToUpload?.length) {
        for (const op of res.opsToUpload) {
          syncState.value.pendingOps[op.clientId] = op
        }
        await flushQueue()
      }

      syncState.value.status = 'synced'
      syncState.value.lastSyncedAt = Date.now()
      syncState.value.lastError = null
    }
    catch (err: any) {
      syncState.value.status = 'error'
      syncState.value.lastError = err.message || String(err)
    }
  }

  // Watchers to trigger sync
  watchDebounced(() => syncState.value.pendingOps, () => {
    void flushQueue()
  }, { debounce: 2000, deep: true })

  // Active card sync
  watch(activeCardId, async (newVal) => {
    if (authStore.isAuthenticated && newVal) {
      try {
        await syncEngine.pushActiveCardId(newVal)
      }
      catch (e) {
        console.error('Failed to sync active character ID:', e)
      }
    }
  })

  // Auth watch
  watch(() => authStore.isAuthenticated, (isAuthed) => {
    if (isAuthed) {
      void pullAndReconcile()
    }
    else {
      syncState.value.status = 'unauthenticated'
      syncState.value.pendingOps = {}
    }
  }, { immediate: true })

  // Window Focus watch
  const windowFocused = useWindowFocus()
  watch(windowFocused, (focused) => {
    if (focused && authStore.isAuthenticated) {
      void pullAndReconcile()
    }
  })

  const addCard = (card: AiriCard | Card | ccv3.CharacterCardV3) => {
    const newCardId = nanoid()
    const updatedAt = new Date().toISOString()
    const cardPayload = {
      ...newAiriCard(card),
      updatedAt,
    }
    cards.value.set(newCardId, cardPayload)
    enqueueUpsert(newCardId, updatedAt)
    return newCardId
  }

  const removeCard = (id: string) => {
    cards.value.delete(id)
    capturePosthogEvent('character_deleted', { character_id: id })
    enqueueDelete(id, new Date().toISOString())
  }

  const updateCard = (id: string, updates: AiriCard | Card | ccv3.CharacterCardV3) => {
    const existingCard = cards.value.get(id)
    if (!existingCard)
      return false

    const updatedAt = new Date().toISOString()
    const updatedCard = {
      ...existingCard,
      ...updates,
      updatedAt,
    }

    cards.value.set(id, newAiriCard(updatedCard))
    enqueueUpsert(id, updatedAt)
    return true
  }

  const getCard = (id: string) => {
    return cards.value.get(id)
  }


  function updateActiveCardDisplayModel(displayModelId: string | undefined) {
    const cardId = activeCardId.value
    const card = cards.value.get(cardId)
    if (!card)
      return false

    const extension = resolveAiriExtension(card)
    const modules: AiriExtension['modules'] = {
      ...extension.modules,
      displayModelId,
    }

    cards.value.set(cardId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...extension,
          modules,
        },
      },
    })

    return true
  }

  function resolveAiriExtension(card: Card | ccv3.CharacterCardV3): AiriExtension {
    // Get existing extension if available
    const existingExtension = ('data' in card
      ? card.data?.extensions?.airi
      : card.extensions?.airi) as AiriExtension

    // Create default modules config
    const defaultModules = {
      consciousness: {
        provider: activeConsciousnessProvider.value,
        model: activeConsciousnessModel.value,
      },
      speech: {
        provider: activeSpeechProvider.value,
        model: activeSpeechModel.value,
        voice_id: activeSpeechVoiceId.value,
      },
      displayModelId: stageModelStore.stageModelSelected,
      artistry: {
        enabled: false,
        provider: artistryStore.globalProvider,
        model: artistryStore.globalModel,
        promptPrefix: artistryStore.globalPromptPrefix,
        widgetInstruction: DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT,
        spawnMode: 'bg_widget' as const,
        options: artistryStore.globalProviderOptions,
        autonomousEnabled: false,
        autonomousThreshold: 70,
        autonomousTarget: 'assistant' as const,
      },
    } as const

    // Return default if no extension exists
    if (!existingExtension) {
      return {
        modules: defaultModules,
        agents: {},
      }
    }

    // Merge existing extension with defaults
    return {
      modules: {
        consciousness: {
          provider: existingExtension.modules?.consciousness?.provider ?? defaultModules.consciousness.provider,
          model: existingExtension.modules?.consciousness?.model ?? defaultModules.consciousness.model,
        },
        speech: {
          provider: existingExtension.modules?.speech?.provider ?? defaultModules.speech.provider,
          model: existingExtension.modules?.speech?.model ?? defaultModules.speech.model,
          voice_id: existingExtension.modules?.speech?.voice_id ?? defaultModules.speech.voice_id,
          pitch: existingExtension.modules?.speech?.pitch,
          rate: existingExtension.modules?.speech?.rate,
          ssml: existingExtension.modules?.speech?.ssml,
          language: existingExtension.modules?.speech?.language,
        },
        vrm: existingExtension.modules?.vrm,
        live2d: existingExtension.modules?.live2d,
        displayModelId: existingExtension.modules?.displayModelId ?? defaultModules.displayModelId,
        activeBackgroundId: existingExtension.modules?.activeBackgroundId,
        artistry: {
          enabled: existingExtension.modules?.artistry?.enabled ?? (existingExtension as any).artistry?.enabled ?? defaultModules.artistry.enabled,
          provider: existingExtension.modules?.artistry?.provider ?? (existingExtension as any).artistry?.provider ?? defaultModules.artistry.provider,
          model: existingExtension.modules?.artistry?.model ?? (existingExtension as any).artistry?.model ?? defaultModules.artistry.model,
          promptPrefix: existingExtension.modules?.artistry?.promptPrefix ?? (existingExtension as any).artistry?.promptPrefix ?? (existingExtension as any).artistry?.prompt_prefix ?? defaultModules.artistry.promptPrefix,
          workflowId: existingExtension.modules?.artistry?.workflowId ?? (existingExtension as any).artistry?.workflowId ?? (existingExtension as any).artistry?.remixId,
          widgetInstruction: existingExtension.modules?.artistry?.widgetInstruction ?? (existingExtension as any).artistry?.widgetInstruction ?? defaultModules.artistry.widgetInstruction,
          spawnMode: existingExtension.modules?.artistry?.spawnMode ?? (existingExtension as any).artistry?.spawnMode ?? defaultModules.artistry.spawnMode,
          options: existingExtension.modules?.artistry?.options ?? (existingExtension as any).artistry?.options ?? defaultModules.artistry.options,
          autonomousEnabled: existingExtension.modules?.artistry?.autonomousEnabled ?? (existingExtension as any).artistry?.autonomousEnabled ?? defaultModules.artistry.autonomousEnabled,
          autonomousThreshold: existingExtension.modules?.artistry?.autonomousThreshold ?? (existingExtension as any).artistry?.autonomousThreshold ?? defaultModules.artistry.autonomousThreshold,
          autonomousTarget: existingExtension.modules?.artistry?.autonomousTarget ?? (existingExtension as any).artistry?.autonomousTarget ?? defaultModules.artistry.autonomousTarget,
        },
      },
      agents: existingExtension.agents ?? {},
    }
  }

  function newAiriCard(card: Card | ccv3.CharacterCardV3): AiriCard {
    // Handle ccv3 format if needed
    if ('data' in card) {
      const ccv3Card = card as ccv3.CharacterCardV3
      return {
        name: ccv3Card.data.name,
        version: ccv3Card.data.character_version ?? '1.0.0',
        description: ccv3Card.data.description ?? '',
        creator: ccv3Card.data.creator ?? '',
        notes: ccv3Card.data.creator_notes ?? '',
        notesMultilingual: ccv3Card.data.creator_notes_multilingual,
        personality: ccv3Card.data.personality ?? '',
        scenario: ccv3Card.data.scenario ?? '',
        greetings: [
          ccv3Card.data.first_mes,
          ...(ccv3Card.data.alternate_greetings ?? []),
        ],
        greetingsGroupOnly: ccv3Card.data.group_only_greetings ?? [],
        systemPrompt: ccv3Card.data.system_prompt ?? '',
        postHistoryInstructions: ccv3Card.data.post_history_instructions ?? '',
        messageExample: ccv3Card.data.mes_example
          ? ccv3Card.data.mes_example
              .split('<START>\n')
              .filter(Boolean)
              .map(example => example.split('\n')
                .map((line) => {
                  if (line.startsWith('{{char}}:') || line.startsWith('{{user}}:'))
                    return line as `{{char}}: ${string}` | `{{user}}: ${string}`
                  throw new Error(`Invalid message example format: ${line}`)
                }))
          : [],
        tags: ccv3Card.data.tags ?? [],
        extensions: {
          airi: resolveAiriExtension(ccv3Card),
          ...ccv3Card.data.extensions,
        },
      }
    }

    return {
      ...card,
      extensions: {
        airi: resolveAiriExtension(card),
        ...card.extensions,
      },
    }
  }

  function initialize() {
    if (cards.value.has('default'))
      return
    cards.value.set('default', newAiriCard({
      name: 'ReLU',
      version: '1.0.0',
      description: SystemPromptV2(
        t('base.prompt.prefix'),
        t('base.prompt.suffix'),
      ).content,
    }))
    if (!activeCardId.value)
      activeCardId.value = 'default'
  }

  watchDebounced(activeCard, (newCard: AiriCard | undefined) => {
    artistryStore.resetToGlobal()

    if (!newCard)
      return

    // TODO: Minecraft Agent, etc
    const extension = resolveAiriExtension(newCard)
    if (!extension)
      return

    activeConsciousnessProvider.value = extension?.modules?.consciousness?.provider
    activeConsciousnessModel.value = extension?.modules?.consciousness?.model

    activeSpeechProvider.value = extension?.modules?.speech?.provider
    activeSpeechModel.value = extension?.modules?.speech?.model
    activeSpeechVoiceId.value = extension?.modules?.speech?.voice_id

    // Apply body model if the card has a display model configured.
    // NOTICE: must set via store property directly (not storeToRefs .value) so Pinia's
    // proxy correctly calls the writable computed setter → stageModelSelectedState → updateStageModel().
    if (extension.modules?.displayModelId) {
      stageModelStore.stageModelSelected = extension.modules.displayModelId
    }

    if (extension.modules?.artistry) {
      if (extension.modules.artistry.provider)
        artistryStore.activeProvider = extension.modules.artistry.provider
      if (extension.modules.artistry.model)
        artistryStore.activeModel = extension.modules.artistry.model
      if (extension.modules.artistry.promptPrefix)
        artistryStore.defaultPromptPrefix = extension.modules.artistry.promptPrefix
      if (extension.modules.artistry.options)
        artistryStore.providerOptions = extension.modules.artistry.options
    }
  }, { debounce: 300, maxWait: 1000 })

  function resetState() {
    activeCardId.reset()
    cards.reset()
    syncState.value = {
      status: 'unauthenticated',
      pendingOps: {},
      lastSyncedAt: null,
      lastError: null,
    }
  }

  return {
    cards,
    activeCard,
    activeCardId,
    addCard,
    removeCard,
    updateCard,
    updateActiveCardDisplayModel,
    getCard,
    resetState,
    initialize,
    syncState,
    pullAndReconcile,

    currentModels: computed(() => {
      return {
        consciousness: {
          provider: activeConsciousnessProvider.value,
          model: activeConsciousnessModel.value,
        },
        speech: {
          provider: activeSpeechProvider.value,
          model: activeSpeechModel.value,
          voice_id: activeSpeechVoiceId.value,
        },
        displayModelId: stageModelStore.stageModelSelected,
        activeBackgroundId: activeCard.value?.extensions?.airi?.modules?.activeBackgroundId,
      } satisfies AiriExtension['modules']
    }),

    systemPrompt: computed(() => {
      const card = activeCard.value
      if (!card)
        return ''

      const components = [
        card.systemPrompt,
        card.description,
        card.personality,
        card.extensions?.airi?.modules?.artistry?.widgetInstruction,
      ].filter(Boolean)

      return components.join('\n\n')
    }),
  }
})
