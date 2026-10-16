// Types of ./access-log-crypto.js (see that file for the format).

export declare const HKDF_SALT: string;
export declare const MESSAGE_AAD: string;
export declare const OBJECT_MAGIC: string;
export declare const IV_BYTES: number;
export declare const MIN_SECRET_LENGTH: number;

export declare class AccessLogCryptoError extends Error {
  readonly code: string;
  constructor(code: string);
}

export interface MessageEnvelope {
  v: 1;
  kid: string;
  iv: string;
  ct: string;
}

export interface AccessLogCrypto {
  readonly currentKid: string;
  sealMessage(record: unknown): Promise<MessageEnvelope>;
  /** Throws {@link AccessLogCryptoError} for malformed, unknown-key or tampered envelopes. */
  openMessage(envelope: unknown): Promise<unknown>;
  sealObject(objectKey: string, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
  openObject(objectKey: string, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
}

export declare function toBase64Url(bytes: Uint8Array): string;
export declare function fromBase64Url(value: string): Uint8Array<ArrayBuffer>;
export declare function parseKeyring(secret: string): {
  current: string;
  secrets: Map<string, string>;
};
export declare function objectKid(data: Uint8Array): string | null;
export declare function createAccessLogCrypto(secret: string): AccessLogCrypto;
