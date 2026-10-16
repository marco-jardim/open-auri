// Encryption format of the Marco Civil access log (plan T3.3 item 7). Single source of truth for
// the jobs Worker (access-log-consumer.ts) and the operator tool (tools/access-log-query.mjs).
// The web Worker's producer (web/src/lib/server/security/access-log.ts) seals queue messages with
// the same constants; web/tests/integration/security/access-log.test.ts opens them with this file.
// Plain JavaScript with a sibling .d.ts so Node (the tool) and both Workers can import it.
// Runtime-agnostic: WebCrypto (crypto.subtle), TextEncoder, btoa/atob only.
//
// Keys: ACCESS_LOG_KEY is a keyring, `kid:secret[,kid:secret...]`; the first entry encrypts, every
// entry decrypts (rotation = prepend a new entry, keep the old ones until their data expires). A
// bare secret without `kid:` is the single key `k1`. Each secret is input keying material for
// HKDF-SHA256 (salt HKDF_SALT, info `<purpose>:<kid>`) deriving separate AES-256-GCM keys for queue
// messages and stored objects, so a secret is never used directly as a cipher key.
//
// Queue message: JSON `{ v: 1, kid, iv, ct }` (base64url), AAD = MESSAGE_AAD.
// Stored object: OBJECT_MAGIC (4 bytes) ‖ kid length (1 byte) ‖ kid ‖ IV (12 bytes) ‖ ciphertext
// with tag; AAD = header (magic ‖ length ‖ kid) ‖ UTF-8 object key, so an object cannot be moved
// to another key (another hour or day) without failing authentication.

export const HKDF_SALT = 'open-auri/access-log';
export const MESSAGE_AAD = 'open-auri/access-log/message/v1';
export const OBJECT_MAGIC = 'OAL1';
export const IV_BYTES = 12;
export const MIN_SECRET_LENGTH = 32;
const KID = /^[a-z0-9]{1,16}$/;
const KEYRING_ENTRY = /^([a-z0-9]{1,16}):(.+)$/;

export class AccessLogCryptoError extends Error {
  /** @param {string} code */
  constructor(code) {
    // Codes only: never key material, plaintext or ciphertext.
    super(`Access-log crypto error: ${code}`);
    this.name = 'AccessLogCryptoError';
    this.code = code;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** @param {string} value */
function utf8(value) {
  return new Uint8Array(encoder.encode(value));
}

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @param {string} value */
export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new AccessLogCryptoError('encoding');
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** @param {...Uint8Array} parts */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @param {string} secret
 * @returns {{ current: string, secrets: Map<string, string> }}
 */
export function parseKeyring(secret) {
  if (typeof secret !== 'string') throw new AccessLogCryptoError('keyring');
  const entries = secret
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new AccessLogCryptoError('keyring');
  /** @type {Map<string, string>} */
  const secrets = new Map();
  const first = entries[0] ?? '';
  if (entries.length === 1 && !KEYRING_ENTRY.test(first)) {
    if (first.length < MIN_SECRET_LENGTH) throw new AccessLogCryptoError('keyring');
    secrets.set('k1', first);
    return { current: 'k1', secrets };
  }
  for (const entry of entries) {
    const match = KEYRING_ENTRY.exec(entry);
    const kid = match?.[1];
    const value = match?.[2];
    if (!kid || !value || value.length < MIN_SECRET_LENGTH || secrets.has(kid)) {
      throw new AccessLogCryptoError('keyring');
    }
    secrets.set(kid, value);
  }
  const current = KEYRING_ENTRY.exec(first)?.[1] ?? '';
  return { current, secrets };
}

/**
 * @param {string} secret
 * @param {'message' | 'object'} purpose
 * @param {string} kid
 */
async function deriveKey(secret, purpose, kid) {
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(HKDF_SALT), info: utf8(`${purpose}:${kid}`) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Reads the key id from a stored object's header, or `null` when the header is malformed.
 * @param {Uint8Array} data
 */
export function objectKid(data) {
  const magic = utf8(OBJECT_MAGIC);
  if (data.length < magic.length + 1) return null;
  for (let index = 0; index < magic.length; index += 1) {
    if (data[index] !== magic[index]) return null;
  }
  const length = data[magic.length] ?? 0;
  const start = magic.length + 1;
  if (length < 1 || data.length < start + length + IV_BYTES + 16) return null;
  let kid;
  try {
    kid = decoder.decode(data.subarray(start, start + length));
  } catch {
    return null;
  }
  return KID.test(kid) ? kid : null;
}

/** @param {string} secret */
export function createAccessLogCrypto(secret) {
  const keyring = parseKeyring(secret);
  /** @type {Map<string, Promise<CryptoKey>>} */
  const keys = new Map();

  /**
   * @param {'message' | 'object'} purpose
   * @param {string} kid
   */
  const keyFor = (purpose, kid) => {
    const value = keyring.secrets.get(kid);
    if (!value) return Promise.reject(new AccessLogCryptoError('unknown-key'));
    const id = `${purpose}:${kid}`;
    let key = keys.get(id);
    if (!key) {
      key = deriveKey(value, purpose, kid);
      keys.set(id, key);
    }
    return key;
  };

  return {
    currentKid: keyring.current,

    /** @param {unknown} record */
    async sealMessage(record) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const key = await keyFor('message', keyring.current);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8(MESSAGE_AAD) },
        key,
        utf8(JSON.stringify(record)),
      );
      return {
        v: 1,
        kid: keyring.current,
        iv: toBase64Url(iv),
        ct: toBase64Url(new Uint8Array(ct)),
      };
    },

    /** @param {unknown} envelope */
    async openMessage(envelope) {
      if (typeof envelope !== 'object' || envelope === null) {
        throw new AccessLogCryptoError('envelope');
      }
      const { v, kid, iv, ct } = /** @type {Record<string, unknown>} */ (envelope);
      if (v !== 1 || typeof kid !== 'string' || typeof iv !== 'string' || typeof ct !== 'string') {
        throw new AccessLogCryptoError('envelope');
      }
      const ivBytes = fromBase64Url(iv);
      if (ivBytes.length !== IV_BYTES) throw new AccessLogCryptoError('envelope');
      const key = await keyFor('message', kid);
      let plain;
      try {
        plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivBytes, additionalData: utf8(MESSAGE_AAD) },
          key,
          fromBase64Url(ct),
        );
      } catch {
        throw new AccessLogCryptoError('authentication');
      }
      try {
        return JSON.parse(decoder.decode(plain));
      } catch {
        throw new AccessLogCryptoError('payload');
      }
    },

    /**
     * @param {string} objectKey
     * @param {Uint8Array} plaintext
     */
    async sealObject(objectKey, plaintext) {
      const kid = keyring.current;
      const kidBytes = utf8(kid);
      const header = concat(utf8(OBJECT_MAGIC), Uint8Array.of(kidBytes.length), kidBytes);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const key = await keyFor('object', kid);
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: concat(header, utf8(objectKey)) },
        key,
        new Uint8Array(plaintext),
      );
      return concat(header, iv, new Uint8Array(ct));
    },

    /**
     * @param {string} objectKey
     * @param {Uint8Array} data
     */
    async openObject(objectKey, data) {
      const kid = objectKid(data);
      if (!kid) throw new AccessLogCryptoError('header');
      const headerLength = OBJECT_MAGIC.length + 1 + utf8(kid).length;
      const header = data.slice(0, headerLength);
      const iv = data.slice(headerLength, headerLength + IV_BYTES);
      const key = await keyFor('object', kid);
      try {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: concat(header, utf8(objectKey)) },
          key,
          data.slice(headerLength + IV_BYTES),
        );
        return new Uint8Array(plain);
      } catch {
        throw new AccessLogCryptoError('authentication');
      }
    },
  };
}
