import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  $mmBgItems,
  $mmMonitorAlerts,
  $mmMonitors,
  $mmWatchers,
  resetDeepUi
} from '@/store/multimodal-deep'

import { DeepPanel } from './deep-panel'

describe('desktop watcher registry presentation', () => {
  beforeEach(() => {
    resetDeepUi()
    $mmBgItems.set([])
    $mmMonitors.set([])
    $mmMonitorAlerts.set({})
  })

  afterEach(() => {
    cleanup()
    resetDeepUi()
  })

  it('hides deleted rows and presents terminal and transitional states accurately', () => {
    $mmWatchers.set([
      { watcher_id: 'done', label: '完成任务', status: 'done' },
      { watcher_id: 'stopping', label: '停止任务', status: 'stopping' },
      { watcher_id: 'interrupted', label: '中断任务', status: 'interrupted' },
      { watcher_id: 'deleted', label: '已删任务', status: 'deleted' }
    ])

    render(<DeepPanel />)

    expect(screen.queryByText('已删任务')).toBeNull()
    expect(screen.getByText('· 已完成')).toBeTruthy()
    expect(screen.getByText('· 正在停止')).toBeTruthy()
    expect(screen.getByText('· 已中断')).toBeTruthy()
    expect(screen.getByRole('switch', { name: '完成任务：已完成' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('switch', { name: '停止任务：正在停止' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('switch', { name: '中断任务：已中断' }).hasAttribute('disabled')).toBe(false)
  })

  it('renders nothing when deleted watchers are the only deep-panel state', () => {
    $mmWatchers.set([{ watcher_id: 'deleted', label: '已删任务', status: 'deleted' }])

    const { container } = render(<DeepPanel />)

    expect(container.innerHTML).toBe('')
  })
})
