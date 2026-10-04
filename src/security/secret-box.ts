import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class SecretBox {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) throw new Error('Expected 256-bit key');
  }
  seal(value: string, context: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    return Buffer.concat([
      iv,
      cipher.update(value, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
  }
  open(value: string, context: string) {
    const data = Buffer.from(value, 'base64url');
    if (data.length < 28) throw new Error('Invalid encrypted secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString(
      'utf8',
    );
  }
}
