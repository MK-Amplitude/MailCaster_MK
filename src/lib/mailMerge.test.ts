import { describe, it, expect } from 'vitest'
import { renderTemplate, extractVariables } from './mailMerge'

describe('renderTemplate', () => {
  it('replaces {{key}} with value', () => {
    expect(renderTemplate('안녕 {{name}}', { name: '준' })).toBe('안녕 준')
  })

  it('handles whitespace inside braces', () => {
    expect(renderTemplate('{{  name  }}', { name: '준' })).toBe('준')
  })

  it('replaces missing keys with empty string', () => {
    expect(renderTemplate('안녕 {{name}}', {})).toBe('안녕 ')
  })

  it('replaces null/undefined values with empty string', () => {
    expect(renderTemplate('{{a}}/{{b}}', { a: null, b: undefined })).toBe('/')
  })

  it('handles multiple variables', () => {
    const out = renderTemplate('{{greeting}} {{name}}님!', {
      greeting: '안녕하세요',
      name: '홍길동',
    })
    expect(out).toBe('안녕하세요 홍길동님!')
  })

  it('coerces non-string values to string', () => {
    // Record type forces string|null|undef but we test runtime behavior
    expect(renderTemplate('{{n}}', { n: '42' })).toBe('42')
  })

  it('preserves text without variables', () => {
    expect(renderTemplate('plain text', {})).toBe('plain text')
  })

  it('supports dotted keys (e.g. user.name)', () => {
    // dotted keys treated as flat string lookup
    expect(renderTemplate('{{user.name}}', { 'user.name': '준' })).toBe('준')
  })

  it('does not match braces with non-word chars between', () => {
    // {{ }} with space-only should still capture empty string and not match
    expect(renderTemplate('{{ }}', {})).toBe('{{ }}')
  })
})

describe('extractVariables', () => {
  it('returns unique variable names', () => {
    expect(extractVariables('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
  })

  it('returns empty array when no variables', () => {
    expect(extractVariables('plain text')).toEqual([])
  })

  it('handles whitespace inside braces', () => {
    expect(extractVariables('{{  name  }}')).toEqual(['name'])
  })

  it('extracts dotted keys', () => {
    expect(extractVariables('{{user.name}} {{user.email}}')).toEqual([
      'user.name',
      'user.email',
    ])
  })

  it('ignores malformed braces', () => {
    expect(extractVariables('{not a var} {{ valid }} {{}}')).toEqual(['valid'])
  })
})
