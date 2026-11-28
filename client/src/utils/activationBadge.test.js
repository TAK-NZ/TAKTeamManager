import { describe, it, expect } from 'vitest'
import { describeActivationBadge } from './activationBadge'
describe('describeActivationBadge', () => {
  it('labels an invited and a not activated account in text', () => {
    expect(describeActivationBadge('invited').label).toBe('Invited')
    expect(describeActivationBadge('expired').label).toBe('Not activated')
  })
  it('has no badge for an activated account or an unknown status', () => {
    for (const status of ['active', null, undefined, 'other']) {
      expect(describeActivationBadge(status)).toBeNull()
    }
  })
})
