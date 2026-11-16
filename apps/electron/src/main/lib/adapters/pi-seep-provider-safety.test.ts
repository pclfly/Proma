import { describe, expect, test } from 'bun:test'
import { shouldInjectSafetySettings } from './pi-seep-provider-safety'

describe('seep provider safety endpoint detection', () => {
  test('Given a Gemini native body with contents Then it injects', () => {
    expect(shouldInjectSafetySettings({ contents: [] }, undefined)).toBe(true)
  })

  test('Given an OpenAI compatible body with messages Then it never injects, even if the model claims gemini', () => {
    expect(shouldInjectSafetySettings(
      { messages: [{ role: 'user', content: 'x' }] },
      { api: 'google-generative-ai', provider: 'gemini' },
    )).toBe(false)
  })

  test('Given an empty body and a Google api id Then it injects by identity', () => {
    expect(shouldInjectSafetySettings({}, { api: 'google-generative-ai' })).toBe(true)
    expect(shouldInjectSafetySettings({}, { api: 'google-vertex' })).toBe(true)
  })

  test('Given an empty body and a Google provider name Then it injects', () => {
    for (const provider of ['google', 'gemini', 'vertex', 'google-vertex', 'google-ai-studio']) {
      expect(shouldInjectSafetySettings({}, { provider })).toBe(true)
    }
  })

  test('Given an empty body and a non-Google provider Then it does not inject', () => {
    expect(shouldInjectSafetySettings({}, { api: 'openai-completions', provider: 'deepseek' })).toBe(false)
    expect(shouldInjectSafetySettings({}, { provider: 'anthropic' })).toBe(false)
  })

  test('Given no model information and an empty body Then it stays conservative', () => {
    expect(shouldInjectSafetySettings({}, undefined)).toBe(false)
  })

  test('Given a null or non-object payload Then it does not throw or inject', () => {
    expect(shouldInjectSafetySettings(null, { provider: 'gemini' })).toBe(false)
    expect(shouldInjectSafetySettings(undefined, { provider: 'gemini' })).toBe(false)
    expect(shouldInjectSafetySettings('text', { provider: 'gemini' })).toBe(false)
  })

  test('Given both messages and contents Then messages wins (OpenAI shape is treated as non-Google)', () => {
    expect(shouldInjectSafetySettings({ messages: [], contents: [] }, undefined)).toBe(false)
  })
})
