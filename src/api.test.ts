import { describe, expect, test } from 'bun:test';
import { ApiError } from './api';

describe('ApiError', () => {
  test('captures status and message', () => {
    const e = new ApiError(404, 'Site not found');
    expect(e.status).toBe(404);
    expect(e.message).toBe('Site not found');
    expect(e instanceof Error).toBe(true);
  });
});