import { describe, test, expect } from 'vitest';
import { withMember } from './member-path';

describe('withMember', () => {
  test('prefixes internal paths with the username', () => {
    expect(withMember('alice', '/')).toBe('/alice');
    expect(withMember('alice', '/channels')).toBe('/alice/channels');
    expect(withMember('alice', '/settings?tab=account')).toBe('/alice/settings?tab=account');
    expect(withMember('alice', '/?q=hi')).toBe('/alice?q=hi');
  });

  test('leaves root paths, external URLs and prefixed paths alone', () => {
    expect(withMember('alice', '/api/channels/slack/connect')).toBe('/api/channels/slack/connect');
    expect(withMember('alice', '/auth/login')).toBe('/auth/login');
    expect(withMember('alice', 'https://mawadao.com/')).toBe('https://mawadao.com/');
    expect(withMember('alice', '//cdn.example.com/x')).toBe('//cdn.example.com/x');
    expect(withMember('alice', '/alice/inbox')).toBe('/alice/inbox');
    expect(withMember('alice', '#section')).toBe('#section');
  });

  test('does nothing outside a member space', () => {
    expect(withMember(undefined, '/channels')).toBe('/channels');
  });
});
