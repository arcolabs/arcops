// src/lib/confirm.ts
import { createInterface } from 'node:readline/promises';
import { error } from '../output';

export async function confirmByTyping(magic: string, prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    error('refusing to confirm in non-interactive mode without --yes');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(prompt);
    return answer.trim() === magic;
  } finally { rl.close(); }
}
