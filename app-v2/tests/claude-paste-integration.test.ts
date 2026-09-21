import { describe, expect, it } from 'vitest';

import { mergeRoomMessages } from '../src/chrome/VioletRoomPanel';
import type { VioletChatMessage } from '../src/pty-client';
import native from './fixtures/claude-pasted-native.json';
import projection from './fixtures/claude-pasted-projection.json';

// Reconstruct the local composer records for the two captured prompts. Their
// original in-memory UI ids were not archived; input/target match the capture.
function composer(index: number) {
  return {
    id: `local-claude-paste-${index}`,
    sessionId: 'composer',
    agentId: 'user',
    shell: 'composer',
    role: 'user',
    kind: 'message',
    timestamp: new Date(Date.parse(native.records[index].timestamp) - 100).toISOString(),
    text: native.originals[index],
    sourcePath: null,
    nativeEventId: null,
    local: true as const,
    projectRoot: '/Users/example/Kota/Workspaces/fixture-zenith-river-73',
    targetAgentIds: [native.agentId],
  } satisfies VioletChatMessage & { local: true; projectRoot: string };
}

describe('actual Claude pasted inputs through the room merge', () => {
  it('shows one explicit whisper and the original local composer bubble on the first input', () => {
    const local = composer(0);
    const merged = mergeRoomMessages(projection.first, [local]);
    expect(merged).toHaveLength(2);
    const whispers = merged.filter((message) => message.ghostSasayaki);
    expect(whispers).toHaveLength(1);
    expect(whispers[0]).toMatchObject({
      messageOrigin: 'shell_handoff',
      nativeEventId: 'kota-handoff:0c00ed19-f5cc-4e27-ac44-8158c7c831d9',
      role: 'system',
    });
    expect(whispers[0].text).not.toContain(native.originals[0]);
    expect(whispers[0].text).not.toContain('pasted_content');
    expect(merged.find((message) => message.id === local.id)).toMatchObject({
      text: native.originals[0],
      quoteRefId: projection.first[1].id,
    });
    expect(merged.find((message) => message.id === local.id)?.ghostSasayaki).toBeUndefined();
  });

  it('deduplicates the second native echo without adding a whisper', () => {
    const local = composer(1);
    const merged = mergeRoomMessages(projection.second, [local]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: local.id,
      text: native.originals[1],
      quoteRefId: projection.second[0].id,
    });
    expect(merged[0].ghostSasayaki).toBeUndefined();
  });

  it('keeps exactly two composer bubbles and one handoff when both rounds are present', () => {
    const local = [composer(0), composer(1)];
    const merged = mergeRoomMessages([...projection.first, ...projection.second], local);
    expect(merged).toHaveLength(3);
    expect(merged.filter((message) => message.ghostSasayaki)).toHaveLength(1);
    expect(merged.filter((message) => message.role === 'user').map((message) => message.text))
      .toEqual(native.originals);
    expect(merged.every((message) => !message.text.includes('pasted_content'))).toBe(true);
  });
});
