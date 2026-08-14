import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WritableAtom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { actions, stores } = vi.hoisted(() => {
  const { atom } = require('nanostores') as {
    atom: <Value>(initial: Value) => WritableAtom<Value>
  }

  return {
    actions: {
      startMic: vi.fn(async () => undefined),
      stopMic: vi.fn(async () => undefined)
    },
    stores: {
      asrBuffer: atom<string[]>([]),
      asrPartial: atom(''),
      micState: atom<'idle' | 'connecting' | 'recording'>('idle'),
      ttsEnabled: atom(false),
      voiceDialogEnabled: atom(false)
    }
  }
})

vi.mock('@/store/multimodal-deep', () => ({ pushMmToast: vi.fn() }))
vi.mock('@/store/multimodal-voice', () => ({
  $mmAsrBuffer: stores.asrBuffer,
  $mmAsrPartial: stores.asrPartial,
  $mmMicState: stores.micState,
  $mmTtsEnabled: stores.ttsEnabled,
  $mmVoiceDialogEnabled: stores.voiceDialogEnabled,
  startMic: actions.startMic,
  stopMic: actions.stopMic,
  toggleMultimodalTts: vi.fn(),
  toggleMultimodalVoiceDialog: vi.fn()
}))

import { MultimodalAsrBar, MultimodalComposerControls } from './composer-controls'

describe('MultimodalAsrBar', () => {
  beforeEach(() => {
    stores.asrBuffer.set([])
    stores.asrPartial.set('')
    stores.micState.set('idle')
    stores.voiceDialogEnabled.set(false)
    actions.startMic.mockClear()
    actions.stopMic.mockClear()
  })

  afterEach(cleanup)

  it('renders the stitched buffer as a dim prefix before the live partial', () => {
    stores.asrBuffer.set(['第一段', '第二段'])
    stores.asrPartial.set('还在说')
    stores.micState.set('recording')

    render(<MultimodalAsrBar />)

    expect(screen.getByText('第一段 第二段').classList.contains('opacity-60')).toBe(true)
    expect(screen.getByText('还在说')).toBeTruthy()
  })

  it('stays visible for a buffered segment after the current partial clears', () => {
    stores.asrBuffer.set(['已缓冲的语音'])

    render(<MultimodalAsrBar />)

    expect(screen.getByText('已缓冲的语音')).toBeTruthy()
  })

  it('lets an armed connecting mic be cancelled before any speech', () => {
    stores.micState.set('connecting')

    render(<MultimodalComposerControls />)
    const mic = screen.getByTitle('麦克风已就绪，等待语音…点击取消')

    expect((mic as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(mic)

    expect(actions.stopMic).toHaveBeenCalledTimes(1)
    expect(actions.startMic).not.toHaveBeenCalled()
  })
})
