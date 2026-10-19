import { describe, expect, it } from 'vitest'
import { decisionExampleCurl, parseOptions, topProbabilities } from './decision'

describe('decision helpers', () => {
  it('parses comma-separated options', () => {
    expect(parseOptions(' a, b ,c,, b ')).toEqual(['a', 'b', 'c'])
    expect(parseOptions('')).toEqual([])
  })

  it('sorts probabilities highest first and drops junk', () => {
    expect(topProbabilities({ a: 0.1, b: 0.7, c: Number.NaN, d: 0.2 })).toEqual([['b', 0.7], ['d', 0.2], ['a', 0.1]])
    expect(topProbabilities(undefined)).toEqual([])
  })

  it('builds a runnable curl example against this origin', () => {
    const curl = decisionExampleCurl('http://localhost:3001')
    expect(curl).toContain('curl http://localhost:3001/v1/decisions')
    expect(curl).toContain('"type": "choice"')
  })
})
