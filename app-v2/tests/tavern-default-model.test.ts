import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadTavernHeroIncarnationProfile,
  syncTavernHeroStorageFromProfiles,
} from '../src/chrome/TavernModal';
import type { TavernHeroProfileDraft } from '../src/pty-client';
import { composeProjectAgentName, incarnationNameFields } from '../src/chrome/ProjectAgentName';

const PROFILE_STORAGE_KEY = 'kota-v2.tavern.hero-profiles';
const CUSTOM_HERO_STORAGE_KEY = 'kota-v2.tavern.custom-heroes';
let originalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  const storage = new Map<string, string>();
  originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  window.localStorage.removeItem(CUSTOM_HERO_STORAGE_KEY);
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(window, 'localStorage', originalStorage);
});

describe('Tavern CLI-default models', () => {
  it('keeps an invited incarnation name and structured fields through Tavern and a new project', () => {
    const nameFields = { titleId: 'doctor', given: '颦儿', middle: '绛珠', surname: 'v. Kota' };
    syncTavernHeroStorageFromProfiles([{
      ...legacyFactoryProfile('hero-invited-piner', 'codex', 'gpt-5.6-sol'),
      name: 'Dr. 颦儿-绛珠 v. Kota', nameFields, kind: 'invited',
      avatarId: 'user:portrait', ghost: 'Personal ghost',
    }]);
    const profile = loadTavernHeroIncarnationProfile('hero-invited-piner')!;
    expect(profile).toMatchObject({ name: 'Dr. 颦儿-绛珠 v. Kota', nameFields,
      avatarId: 'user:portrait', ghost: 'Personal ghost', model: 'gpt-5.6-sol' });
    const next = incarnationNameFields(profile.name, profile.nameFields, ' II', 'Other');
    expect(composeProjectAgentName(next)).toBe('Dr. 颦儿 II-绛珠 v. Other');
    expect(profile.nameFields).toEqual(nameFields);
    expect(loadTavernHeroIncarnationProfile('hero-invited-piner')?.name).toBe(profile.name);
  });

  it.each([
    ['hero-cc', 'claude', ['--dangerously-skip-permissions']],
    ['hero-dex', 'codex', ['--dangerously-bypass-approvals-and-sandbox']],
    ['hero-gem', 'antigravity', ['--dangerously-skip-permissions']],
    ['hero-op', 'opencode', ['--pure', '--dangerously-skip-permissions']],
    ['hero-pi', 'pi', ['--approve']],
    ['hero-kimi', 'kimi', ['--yolo']],
  ] as const)('omits model and effort for fresh and saved %s incarnations', (id, provider, args) => {
    const fresh = loadTavernHeroIncarnationProfile(id)!;
    expect(fresh).toMatchObject({ provider, model: 'default', effort: undefined });
    expect(fresh.args).toEqual(args);
    expect(fresh.shell).toContain('model: default');
    expect(fresh.shell).not.toMatch(/effort:|--model|--effort|--thinking|model_reasoning_effort/);

    syncTavernHeroStorageFromProfiles([{
      ...legacyFactoryProfile(id, provider, 'default'), effort: null, shell: fresh.shell,
    }]);
    const saved = loadTavernHeroIncarnationProfile(id)!;
    expect(saved.model).toBe('default');
    expect(saved.effort).toBeUndefined();
    expect(saved.args).toEqual(args);
  });

  it.each([
    ['hero-cc', 'claude', 'claude-opus-4-8[1m]', 'high', ['--effort', 'high']],
    ['hero-dex', 'codex', 'gpt-5.5', 'medium', ['--config', 'model_reasoning_effort="medium"']],
    ['hero-op', 'opencode', 'opencode/custom-model', null, []],
    ['hero-pi', 'pi', 'zai/glm-5.2', 'low', ['--thinking', 'low']],
    ['hero-kimi', 'kimi', 'custom-model', null, []],
  ] as const)('preserves later explicit choices for %s (no read-time reset)', (
    id, provider, model, effort, effortArgs,
  ) => {
    syncTavernHeroStorageFromProfiles([{ ...legacyFactoryProfile(id, provider, model), effort }]);
    const selected = loadTavernHeroIncarnationProfile(id)!;
    expect(selected.model).toBe(model);
    expect(selected.args.slice(0, 2)).toEqual(['--model', model]);
    expect(selected.args.slice(2, 2 + effortArgs.length)).toEqual(effortArgs);
    expect(selected.effort ?? null).toBe(effort);
  });

  it('keeps custom and invited profiles unchanged when they use former factory choices', () => {
    for (const kind of ['custom', 'invited'] as const) {
      const id = `hero-${kind}-outside-factory`;
      syncTavernHeroStorageFromProfiles([{
        ...legacyFactoryProfile(id, 'claude', 'claude-opus-4-8[1m]'), kind, effort: 'max',
      }]);
      expect(loadTavernHeroIncarnationProfile(id)).toMatchObject({
        model: 'claude-opus-4-8[1m]', effort: 'max', kind,
      });
    }
  });
});

function legacyFactoryProfile(
  heroId: string,
  provider: string,
  model: string,
): TavernHeroProfileDraft {
  return {
    heroId,
    name: heroId === 'hero-cc' ? 'CC' : 'Dex',
    provider,
    model,
    effort: provider === 'claude' ? 'max' : 'xhigh',
    skills: ['frontend-design'],
    ghost: 'Factory ghost',
    shell: [
      `provider: ${provider}`,
      `model: ${model}`,
      'args:',
      '  - "--model"',
      `  - "${model}"`,
    ].join('\n'),
  };
}
