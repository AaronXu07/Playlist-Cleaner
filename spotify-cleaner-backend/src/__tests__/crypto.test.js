// Feature: core-polling-engine, Property 5: Token storage is always encrypted; token usage is always decrypted

import { describe, it, expect, beforeAll } from 'vitest'
import * as fc from 'fast-check'

// Set the encryption key BEFORE importing crypto.js so the module-level KEY
// buffer is initialised with the correct value.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(32) // 32 ASCII bytes = valid AES-256-GCM key
})

// Dynamic import inside each test so the env var is already set.
// We use a top-level variable and populate it once in the first describe block.
let encrypt, decrypt

describe('crypto — Property 5: Token encrypt/decrypt round-trip', () => {
  beforeAll(async () => {
    // Ensure the key env var is set before the module loads its KEY buffer.
    process.env.ENCRYPTION_KEY = 'a'.repeat(32)
    const mod = await import('../lib/crypto.js')
    encrypt = mod.encrypt
    decrypt = mod.decrypt
  })

  it('round-trip: decrypt(encrypt(t)) === t for arbitrary plaintext tokens', () => {
    // **Validates: Requirements 2.7, 2.8**
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 256 }),
        (t) => {
          const ciphertext = encrypt(t)
          const recovered = decrypt(ciphertext)
          return recovered === t
        }
      ),
      { numRuns: 100 }
    )
  })

  it('ciphertext is never equal to the plaintext', () => {
    // **Validates: Requirements 2.7, 2.8**
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 256 }),
        (t) => {
          const ciphertext = encrypt(t)
          return ciphertext !== t
        }
      ),
      { numRuns: 100 }
    )
  })
})
