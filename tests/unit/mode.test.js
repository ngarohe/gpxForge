/**
 * Unit tests for src/ui/mode.js — mode persistence + body.dataset.mode.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ST } from '../../src/state.js'
import { initMode, setMode, getMode } from '../../src/ui/mode.js'

const KEY = 'gpxforge.mode'

function resetDom() {
  document.body.innerHTML = ''
  document.body.removeAttribute('data-mode')
}

function setUrlMode(mode) {
  // jsdom lets us replace location; easier to stub URLSearchParams via location.search
  const url = new URL(window.location.href)
  if (mode === null) url.searchParams.delete('mode')
  else url.searchParams.set('mode', mode)
  window.history.replaceState({}, '', url.toString())
}

describe('ui/mode.js', () => {
  beforeEach(() => {
    localStorage.clear()
    setUrlMode(null)
    ST.mode = 'expert'
    resetDom()
  })

  afterEach(() => {
    setUrlMode(null)
    localStorage.clear()
  })

  describe('initMode', () => {
    it('defaults to expert when nothing is stored and no URL override', () => {
      expect(initMode()).toBe('expert')
      expect(ST.mode).toBe('expert')
      expect(document.body.dataset.mode).toBe('expert')
    })

    it('reads stored mode from localStorage', () => {
      localStorage.setItem(KEY, 'simple')
      expect(initMode()).toBe('simple')
      expect(ST.mode).toBe('simple')
      expect(document.body.dataset.mode).toBe('simple')
    })

    it('URL ?mode= overrides stored value', () => {
      localStorage.setItem(KEY, 'simple')
      setUrlMode('expert')
      expect(initMode()).toBe('expert')
      expect(ST.mode).toBe('expert')
    })

    it('ignores invalid stored values', () => {
      localStorage.setItem(KEY, 'banana')
      expect(initMode()).toBe('expert')
    })

    it('ignores invalid URL values', () => {
      setUrlMode('banana')
      expect(initMode()).toBe('expert')
    })
  })

  describe('setMode', () => {
    it('updates ST.mode, body.dataset.mode, and localStorage', () => {
      initMode()
      setMode('simple')
      expect(ST.mode).toBe('simple')
      expect(document.body.dataset.mode).toBe('simple')
      expect(localStorage.getItem(KEY)).toBe('simple')
    })

    it('rejects invalid modes without mutating state', () => {
      initMode()
      setMode('simple')
      setMode('banana')
      expect(ST.mode).toBe('simple')
      expect(localStorage.getItem(KEY)).toBe('simple')
    })

    it('is idempotent', () => {
      initMode()
      setMode('expert')
      setMode('expert')
      expect(ST.mode).toBe('expert')
    })
  })

  describe('getMode', () => {
    it('returns current ST.mode', () => {
      initMode()
      expect(getMode()).toBe('expert')
      setMode('simple')
      expect(getMode()).toBe('simple')
    })
  })

  describe('persistence across init cycles', () => {
    it('setMode then initMode restores the chosen mode', () => {
      initMode()
      setMode('simple')
      // Simulate a page reload: wipe ST.mode back to default, re-init.
      ST.mode = 'expert'
      document.body.removeAttribute('data-mode')
      expect(initMode()).toBe('simple')
      expect(document.body.dataset.mode).toBe('simple')
    })
  })
})
