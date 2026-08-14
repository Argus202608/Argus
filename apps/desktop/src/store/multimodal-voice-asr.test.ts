import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface GatewayLike {
  request: ReturnType<typeof vi.fn>
}

const deps = vi.hoisted(() => ({
  addVoiceUserMessage: vi.fn(),
  gateway: null as GatewayLike | null,
  sessionId: 'runtime-voice'
}))

vi.mock('./gateway', () => ({
  $gateway: { get: () => deps.gateway }
}))

vi.mock('./multimodal', () => ({
  $mmSessionId: { get: () => deps.sessionId },
  addVoiceUserMessage: deps.addVoiceUserMessage
}))

import {
  $mmAsrBuffer,
  $mmAsrPartial,
  $mmMicState,
  $mmVoiceDialogEnabled,
  configureDraftMicSessionEnsurer,
  hasMicCaptureIntent,
  onAsrBuffer,
  onAsrFinal,
  onAsrPartial,
  rearmMicAfterReconnect,
  rearmMicForSessionRebind,
  startMic,
  stopMic,
  toggleMultimodalVoiceDialog
} from './multimodal-voice'

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []

  connect = vi.fn()
  disconnect = vi.fn()
  port = {
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent) => void) | null
  }

  constructor() {
    FakeAudioWorkletNode.instances.push(this)
  }

  emit(bytes: number[]): void {
    this.port.onmessage?.({ data: new Uint8Array(bytes).buffer } as MessageEvent)
  }
}

class FakeAudioContext {
  audioWorklet = { addModule: vi.fn(async () => undefined) }
  close = vi.fn(async () => undefined)
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn()
  }))
  destination = {}
  sampleRate = 48_000
  state = 'running'
}

let originalMediaDevices: PropertyDescriptor | undefined
let tracks: FakeTrack[]

function gatewayCalls(method: string): Array<[string, Record<string, unknown>]> {
  return (deps.gateway?.request.mock.calls || []).filter(
    call => call[0] === method
  ) as Array<[string, Record<string, unknown>]>
}

describe('multimodal voice ASR preview state', () => {
  beforeEach(() => {
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    tracks = []
    FakeAudioWorkletNode.instances = []
    deps.sessionId = 'runtime-voice'
    deps.gateway = {
      request: vi.fn(async (method: string) => method === 'multimodal.asr_start' ? { enabled: true } : { ok: true })
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          const track = { stop: vi.fn() }

          tracks.push(track)

          return {
            getTracks: () => [track]
          } as unknown as MediaStream
        })
      }
    })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
    deps.addVoiceUserMessage.mockClear()
    $mmAsrBuffer.set([])
    $mmAsrPartial.set('')
    $mmVoiceDialogEnabled.set(false)
    configureDraftMicSessionEnsurer(null)
  })

  afterEach(async () => {
    await stopMic()
    configureDraftMicSessionEnsurer(null)
    deps.gateway = null
    vi.unstubAllGlobals()

    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
    } else {
      Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })

  it('keeps stitched EOU segments separate from the live partial', () => {
    onAsrBuffer(['第一段', '', '第二段'])
    onAsrPartial('正在识别')

    expect($mmAsrBuffer.get()).toEqual(['第一段', '第二段'])
    expect($mmAsrPartial.get()).toBe('正在识别')
  })

  it('injects the final voice turn and clears both preview layers', () => {
    onAsrBuffer(['已经说完的前半句'])
    onAsrPartial('后半句')

    onAsrFinal('  这是完整问题  ')

    expect(deps.addVoiceUserMessage).toHaveBeenCalledWith('这是完整问题')
    expect($mmAsrBuffer.get()).toEqual([])
    expect($mmAsrPartial.get()).toBe('')
  })

  it('clears stale preview state even when stop races with an already-idle recorder', async () => {
    onAsrBuffer(['残留段落'])
    onAsrPartial('残留 partial')

    await stopMic()

    expect($mmAsrBuffer.get()).toEqual([])
    expect($mmAsrPartial.get()).toBe('')
  })

  it('pins PCM and stop ownership to the session that opened the mic', async () => {
    await startMic()

    const node = FakeAudioWorkletNode.instances[0]

    node.emit([1, 2, 3])
    expect(gatewayCalls('multimodal.asr_audio')).toHaveLength(1)
    expect(gatewayCalls('multimodal.asr_audio')[0][1]).toEqual(
      expect.objectContaining({ session_id: 'runtime-voice' })
    )

    // Even if the shared session atom changes before its binding cleanup runs,
    // the old worklet must drop PCM instead of dynamically sending it to B.
    deps.sessionId = 'runtime-B'
    node.emit([4, 5, 6])
    expect(gatewayCalls('multimodal.asr_audio')).toHaveLength(1)

    await stopMic()

    expect(gatewayCalls('multimodal.asr_stop')).toContainEqual([
      'multimodal.asr_stop',
      { session_id: 'runtime-voice' }
    ])
    expect(gatewayCalls('multimodal.asr_stop')).not.toContainEqual([
      'multimodal.asr_stop',
      { session_id: 'runtime-B' }
    ])
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
  })

  it('arms local draft media without creating until first PCM, then starts once with bounded pre-roll', async () => {
    deps.sessionId = ''
    let resolveSession!: (sid: string | null) => void

    const sessionReady = new Promise<string | null>(resolve => {
      resolveSession = resolve
    })

    const ensureSession = vi.fn(() => sessionReady)

    configureDraftMicSessionEnsurer(ensureSession)
    await startMic()

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
    expect(FakeAudioWorkletNode.instances).toHaveLength(1)
    expect(ensureSession).not.toHaveBeenCalled()
    expect(gatewayCalls('multimodal.asr_start')).toHaveLength(0)

    const node = FakeAudioWorkletNode.instances[0]

    node.emit([1, 2, 3])
    node.emit([4, 5, 6])
    expect(ensureSession).toHaveBeenCalledTimes(1)

    deps.sessionId = 'runtime-draft'
    resolveSession('runtime-draft')
    await vi.waitFor(() => expect($mmMicState.get()).toBe('recording'))

    expect(gatewayCalls('multimodal.asr_start')).toHaveLength(1)
    expect(deps.gateway!.request).toHaveBeenCalledWith(
      'multimodal.asr_start',
      { session_id: 'runtime-draft' },
      210_000
    )
    expect(gatewayCalls('multimodal.asr_audio')).toHaveLength(2)
    expect(gatewayCalls('multimodal.asr_audio').every(call => call[1].session_id === 'runtime-draft')).toBe(true)

    node.emit([7, 8, 9])
    expect(gatewayCalls('multimodal.asr_audio')).toHaveLength(3)
  })

  it('releases an armed draft and ignores a late create after explicit stop', async () => {
    deps.sessionId = ''
    let resolveSession!: (sid: string | null) => void

    const sessionReady = new Promise<string | null>(resolve => {
      resolveSession = resolve
    })

    const ensureSession = vi.fn(() => sessionReady)

    configureDraftMicSessionEnsurer(ensureSession)
    await startMic()
    FakeAudioWorkletNode.instances[0].emit([1, 2, 3])
    expect(ensureSession).toHaveBeenCalledTimes(1)

    await stopMic()
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect($mmMicState.get()).toBe('idle')

    deps.sessionId = 'runtime-late'
    resolveSession('runtime-late')
    await Promise.resolve()
    await Promise.resolve()

    expect(gatewayCalls('multimodal.asr_start')).toHaveLength(0)
    expect(gatewayCalls('multimodal.asr_audio')).toHaveLength(0)
  })

  it('applies a fresh-draft voice-dialog intent once after ASR binds', async () => {
    deps.sessionId = ''

    const ensureSession = vi.fn(async () => {
      deps.sessionId = 'runtime-dialog'

      return 'runtime-dialog'
    })

    configureDraftMicSessionEnsurer(ensureSession)
    toggleMultimodalVoiceDialog()
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1))
    expect(ensureSession).not.toHaveBeenCalled()

    FakeAudioWorkletNode.instances[0].emit([1, 2, 3])
    await vi.waitFor(() => expect($mmMicState.get()).toBe('recording'))

    expect(deps.gateway!.request.mock.calls.filter(call =>
      call[0] === 'multimodal.voice_dialog_toggle' && call[1]?.enabled === true
    )).toEqual([[
      'multimodal.voice_dialog_toggle',
      { session_id: 'runtime-dialog', enabled: true }
    ]])
  })

  it('cancels an in-flight A start without acquiring media or stopping B', async () => {
    let resolveStart!: (value: { enabled: boolean }) => void

    const startResponse = new Promise<{ enabled: boolean }>(resolve => {
      resolveStart = resolve
    })

    deps.gateway!.request.mockImplementation(
      async (method: string) => method === 'multimodal.asr_start' ? startResponse : { ok: true }
    )

    const starting = startMic()

    expect($mmMicState.get()).toBe('connecting')
    deps.sessionId = 'runtime-B'
    await stopMic()
    resolveStart({ enabled: true })
    await starting

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(gatewayCalls('multimodal.asr_stop')).not.toHaveLength(0)
    expect(gatewayCalls('multimodal.asr_stop').every(call => call[1].session_id === 'runtime-voice')).toBe(true)
    expect($mmMicState.get()).toBe('idle')
  })

  it('stops the old runtime and rearms PCM on a same-conversation replacement runtime', async () => {
    await startMic()
    deps.sessionId = 'runtime-voice-2'
    $mmVoiceDialogEnabled.set(true)

    await rearmMicForSessionRebind()

    const lifecycle = deps.gateway!.request.mock.calls
      .filter(call => call[0] === 'multimodal.asr_start' || call[0] === 'multimodal.asr_stop')
      .map(call => [call[0], call[1]?.session_id])

    expect(lifecycle).toEqual([
      ['multimodal.asr_start', 'runtime-voice'],
      ['multimodal.asr_stop', 'runtime-voice'],
      ['multimodal.asr_start', 'runtime-voice-2']
    ])
    expect(tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(deps.gateway!.request).toHaveBeenCalledWith(
      'multimodal.voice_dialog_toggle',
      { session_id: 'runtime-voice-2', enabled: true }
    )

    FakeAudioWorkletNode.instances[1].emit([7, 8, 9])
    expect(gatewayCalls('multimodal.asr_audio').at(-1)?.[1]).toEqual(
      expect.objectContaining({ session_id: 'runtime-voice-2' })
    )
  })

  it('keeps reconnect intent when stale A rejects, then rearms only on same-conversation A2', async () => {
    await startMic()
    const oldNode = FakeAudioWorkletNode.instances[0]
    const audioBeforeReconnect = gatewayCalls('multimodal.asr_audio').length
    let rejectStaleA = true

    deps.gateway!.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'multimodal.asr_start') {
        if (params?.session_id === 'runtime-voice' && rejectStaleA) {
          rejectStaleA = false
          throw new Error('session not found: runtime-voice')
        }

        return { enabled: true }
      }

      return { ok: true }
    })

    // Gateway open races use-route-resume and tries the still-published A. A is
    // already gone, so this attempt fails before the replacement id exists.
    await rearmMicAfterReconnect()

    expect($mmMicState.get()).toBe('idle')
    expect(hasMicCaptureIntent()).toBe(true)
    oldNode.emit([4, 5, 6])
    expect(gatewayCalls('multimodal.asr_audio')).toHaveLength(audioBeforeReconnect)

    // The route now enters its empty recovery gap, then the same durable
    // conversation publishes A2. Its one-shot binding consumes the latent mic
    // intent and opens ASR on A2, never on an unrelated B.
    deps.sessionId = ''
    expect(hasMicCaptureIntent()).toBe(true)
    deps.sessionId = 'runtime-voice-2'
    await rearmMicForSessionRebind()

    const starts = gatewayCalls('multimodal.asr_start').map(call => call[1].session_id)

    expect(starts).toEqual(['runtime-voice', 'runtime-voice', 'runtime-voice-2'])
    expect(starts).not.toContain('runtime-B')
    expect(hasMicCaptureIntent()).toBe(true)
    expect($mmMicState.get()).toBe('recording')

    FakeAudioWorkletNode.instances.at(-1)!.emit([7, 8, 9])
    expect(gatewayCalls('multimodal.asr_audio').at(-1)?.[1]).toEqual(
      expect.objectContaining({ session_id: 'runtime-voice-2' })
    )
  })

  it('does not rearm the replacement runtime after an explicit stop in the reconnect gap', async () => {
    await startMic()
    let rejectStaleA = true

    deps.gateway!.request.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'multimodal.asr_start') {
        if (params?.session_id === 'runtime-voice' && rejectStaleA) {
          rejectStaleA = false
          throw new Error('session not found: runtime-voice')
        }

        return { enabled: true }
      }

      return { ok: true }
    })

    await rearmMicAfterReconnect()
    deps.sessionId = ''
    await stopMic()

    expect(hasMicCaptureIntent()).toBe(false)

    deps.sessionId = 'runtime-voice-2'
    await rearmMicForSessionRebind()

    expect(gatewayCalls('multimodal.asr_start').map(call => call[1].session_id)).toEqual([
      'runtime-voice',
      'runtime-voice'
    ])
    expect($mmMicState.get()).toBe('idle')
  })
})
