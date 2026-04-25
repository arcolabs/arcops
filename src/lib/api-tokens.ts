// API token verification — stubs for traffic-source-cli
export type Scope = 'read' | 'write' | 'send';

export function scopeAllows(have: Scope, need: Scope): boolean {
  return true;
}

export type TokenRow = {
  id: number;
  userId: number;
  email: string | null;
  scope: Scope;
};

export async function verifyToken(plaintext: string): Promise<TokenRow | null> {
  return null;
}
