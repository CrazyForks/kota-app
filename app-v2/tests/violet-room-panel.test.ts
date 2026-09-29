import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import * as ptyClient from '../src/pty-client';
import codexIcon from '../src/assets/tavern/icons/providers/openai.svg';

import {
  VioletRoomPanel,
  mergeOlderRoomMessages,
  mergeRoomMessages,
  mergeSyncedNativeMessages,
  normalizeAttachmentInsensitive,
  normalizeForDedupe,
} from '../src/chrome/VioletRoomPanel';
import type { VioletChatMessage } from '../src/pty-client';
import { splitLeadingEnvelopePrefix, stripLeadingTemporalGapForDisplay } from '../src/lib/violet-message-dedupe';

it('splits envelope prefixes without dropping or normalizing any bytes', () => {
  for (const prefix of ['', ' \u0015\n', '\r\n[Image #1] \t[Attachment #2]\r\n']) {
    const body = '<KOTA_QUOTE_META v="1">\r\nbody';
    expect(splitLeadingEnvelopePrefix(prefix + body)).toEqual({ prefix, rest: body });
  }
  expect(splitLeadingEnvelopePrefix('[not an attachment] body')).toEqual({ prefix: '', rest: '[not an attachment] body' });
});

describe('temporal context display', () => {
  const gap = [
    '<KOTA_TEMPORAL_GAP v="1" current_time="2026-09-01T12:00:00Z">',
    'It has been over 24 hours since your last completed response in this room.',
    '</KOTA_TEMPORAL_GAP>',
  ].join('\n');

  it('leaves text without a valid leading block unchanged', () => {
    for (const text of ['', ' \u0015hello world\n', '[Image #1] hi', `quoted:\n${gap}\nhello`, `${gap.replace('v="1"', 'v="2"')}\nhello`]) {
      expect(stripLeadingTemporalGapForDisplay(text)).toBe(text);
    }
  });

  it('removes the block but preserves leading whitespace, controls and the remaining body', () => {
    expect(stripLeadingTemporalGapForDisplay(`${gap}\nhello world`)).toBe('hello world');
    const prefix = '\u0015 \t\n\u0000';
    expect(stripLeadingTemporalGapForDisplay(`${prefix}${gap}\n\nhello world\n`)).toBe(`${prefix}\nhello world\n`);
  });

  it('retains provider attachment markers before the block', () => {
    const prefix = ' \u0015[Image #1] \n[Image #2]\t';
    expect(stripLeadingTemporalGapForDisplay(`${prefix}${gap}\nhi`)).toBe(`${prefix}hi`);
  });

  it('handles CRLF without normalizing the preserved prefix or body', () => {
    const prefix = '\r\n[Image #1] \r\n';
    const body = '\r\nhello\r\nworld\r\n';
    expect(stripLeadingTemporalGapForDisplay(`${prefix}${gap.replaceAll('\n', '\r\n')}\r\n${body}`)).toBe(prefix + body);
  });
});

it('shows the actual turn provider badge only on known-provider end-turn bubbles', async () => {
  const projectRoot = '/tmp/fable-provider-badges';
  const readCache = vi.spyOn(ptyClient, 'readVioletRoomCache').mockResolvedValue({
    messages: [
      roomMessage({ id: 'final', role: 'assistant', shell: 'codex', agentProvider: 'claude', text: 'Finished the draft.' }),
      roomMessage({ id: 'system', role: 'assistant', shell: 'system', text: 'System notice.' }),
      roomMessage({ id: 'unknown', role: 'assistant', shell: 'future-cli', text: 'Unknown provider reply.' }),
      roomMessage({ id: 'progress', role: 'assistant', kind: 'commentary', shell: 'codex', text: 'Checking the draft.' }),
      roomMessage({ id: 'user', role: 'user', shell: 'codex', text: 'Please check the draft.' }),
    ],
    sources: [], workEvents: [], agentBusReceipts: [],
    rawLogDir: `${projectRoot}/project-memory/raw_logs`,
    chathistoryDir: `${projectRoot}/project-memory/chathistory`,
    syncedAt: '2026-05-18T08:51:27.000Z',
  });
  const view = render(createElement(VioletRoomPanel, { projectRoot, agentIds: ['agent-a'] }));
  try {
    const bubble = (await screen.findByText('Finished the draft.')).closest('.violet-msg') as HTMLElement;
    const badge = within(bubble).getByLabelText('Codex');
    expect(badge.parentElement).toHaveClass('violet-msg-model');
    expect(bubble.querySelector('.violet-msg-avatar-host .provider-badge')).toBeNull();
    expect(bubble.querySelector('.with-provider-badge')).toBeNull();
    expect(badge.querySelector('img')).toHaveAttribute('src', codexIcon);
    expect(badge.querySelector('img')).toHaveAttribute('width', '10');
    expect(badge.querySelector('img')).toHaveAttribute('height', '10');
    const tooltip = within(badge).getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveTextContent('Codex');
    expect(badge).toHaveAttribute('aria-describedby', tooltip.id);
    expect(badge).toHaveAttribute('tabindex', '0');
    for (const id of ['system', 'unknown', 'progress', 'user']) {
      const other = view.container.querySelector(`[data-violet-message-id="${id}"]`);
      expect(other).not.toBeNull();
      expect(other?.querySelector('.provider-badge')).toBeNull();
      expect(other?.querySelector('.violet-msg-model')).toBeNull();
    }
    expect(view.container.querySelectorAll('.provider-badge')).toHaveLength(1);
  } finally {
    view.unmount();
    readCache.mockRestore();
  }
});

it('shows an inline provider icon with optional model and effort only on known-provider end turns', async () => {
  const projectRoot = '/tmp/fable-model-captions';
  const readCache = vi.spyOn(ptyClient, 'readVioletRoomCache').mockResolvedValue({
    messages: [
      roomMessage({ id: 'caption-both', role: 'assistant', shell: 'codex', text: 'Both fields.', model: 'gpt-fable-6', effort: 'max' }),
      roomMessage({ id: 'caption-model', role: 'assistant', shell: 'opencode', text: 'Model only.', model: 'gpt-fable-open' }),
      roomMessage({ id: 'caption-neither', role: 'assistant', shell: 'antigravity', text: 'Unknown fields.' }),
      roomMessage({ id: 'caption-effort-only', role: 'assistant', shell: 'antigravity', text: 'Unknown model.', effort: 'High' }),
      roomMessage({ id: 'caption-progress', role: 'assistant', kind: 'commentary', shell: 'codex', text: 'Checking.', model: 'gpt-fable-6', effort: 'max' }),
      roomMessage({ id: 'caption-system', role: 'assistant', shell: 'system', text: 'System notice.', model: 'ignored', effort: 'ignored' }),
      roomMessage({ id: 'caption-unknown', role: 'assistant', shell: 'future-cli', text: 'Unknown provider.', model: 'ignored', effort: 'ignored' }),
      roomMessage({ id: 'caption-user', role: 'user', shell: 'codex', text: 'A request.', model: 'ignored', effort: 'ignored' }),
    ],
    sources: [], workEvents: [], agentBusReceipts: [],
    rawLogDir: `${projectRoot}/project-memory/raw_logs`,
    chathistoryDir: `${projectRoot}/project-memory/chathistory`,
    syncedAt: '2026-05-18T08:51:27.000Z',
  });
  const view = render(createElement(VioletRoomPanel, { projectRoot, agentIds: ['agent-a'] }));
  try {
    const both = (await screen.findByText('Both fields.')).closest('.violet-msg') as HTMLElement;
    const caption = both.querySelector('.violet-msg-model');
    expect(caption).toHaveTextContent('gpt-fable-6 • max');
    expect(caption?.previousElementSibling).toHaveClass('violet-msg-body');
    expect(caption?.parentElement).toHaveClass('violet-msg-content');
    expect(caption?.firstElementChild).toHaveClass('provider-badge');
    expect(caption?.querySelector('.provider-badge img')).toHaveAttribute('width', '10');
    expect(caption?.querySelector('.violet-msg-model-text')).toHaveTextContent(/^gpt-fable-6 • max$/);
    const modelOnly = (await screen.findByText('Model only.')).closest('.violet-msg') as HTMLElement;
    expect(modelOnly.querySelector('.violet-msg-model-text')).toHaveTextContent(/^gpt-fable-open$/);
    expect(modelOnly.querySelector('.violet-msg-effort')).toBeNull();
    for (const id of ['caption-neither', 'caption-effort-only']) {
      const iconOnly = view.container.querySelector(`[data-violet-message-id="${id}"] .violet-msg-model`) as HTMLElement;
      expect(iconOnly).not.toBeNull();
      expect(iconOnly.children).toHaveLength(1);
      expect(within(iconOnly).getByLabelText('Antigravity CLI')).toHaveClass('provider-badge');
      expect(iconOnly.querySelector('.violet-msg-model-text')).toBeNull();
    }
    for (const id of ['caption-progress', 'caption-system', 'caption-unknown', 'caption-user']) {
      const bubble = view.container.querySelector(`[data-violet-message-id="${id}"]`);
      expect(bubble).not.toBeNull();
      expect(bubble?.querySelector('.violet-msg-model')).toBeNull();
    }
    expect(view.container.querySelectorAll('.violet-msg-model')).toHaveLength(4);
  } finally {
    view.unmount();
    readCache.mockRestore();
  }
});

describe('Violet room message dedupe', () => {
  it('matches absolute and project-memory-relative attachment prompts', () => {
    expect(
      normalizeForDedupe(
        '/Users/example/Kota/Workspaces/demo-project/project-memory/attachments/composer/att_1/original.png 图上是什么',
      ),
    ).toBe('project-memory/attachments/composer/att_1/original.png 图上是什么');
    expect(
      normalizeForDedupe('project-memory/attachments/composer/att_1/original.png 图上是什么'),
    ).toBe('project-memory/attachments/composer/att_1/original.png 图上是什么');
  });

  it('ignores terminal control padding when deduping provider echoes', () => {
    expect(normalizeForDedupe('\x15same prompt\x0b')).toBe('same prompt');
  });

  it('normalizes a very long non-attachment token without attachment regex backtracking', () => {
    const prompt = `https://example.test/${'x'.repeat(154_000)} final instruction`;

    expect(normalizeAttachmentInsensitive(prompt)).toBe(prompt);
  });

  it('strips attachment paths and provider markers without stripping user text', () => {
    expect(normalizeAttachmentInsensitive(
      '/Users/example/Kota/project-memory/attachments/composer/att_1/original.png explain this',
    )).toBe('explain this');
    expect(normalizeAttachmentInsensitive('[Image #12]explain this')).toBe('explain this');
    expect(normalizeAttachmentInsensitive('[Image: source: /tmp/input.png] explain this')).toBe('explain this');
    expect(normalizeAttachmentInsensitive('a user literally wrote project-memory/attachment')).toBe(
      'a user literally wrote project-memory/attachment',
    );
  });

  it('collapses broadcast user echoes from native and raw cache into one bubble', () => {
    const messages = ['agent-a', 'agent-b', 'agent-c'].flatMap((agentId, index) => [
      roomMessage({
        id: `native-${agentId}`,
        agentId,
        timestamp: `2026-05-18T08:51:26.${530 + index}Z`,
        text: '/Users/example/Kota/Workspaces/demo-project/project-memory/attachments/composer/att_1/original.png 图上是什么',
      }),
      roomMessage({
        id: `cache-${agentId}`,
        agentId,
        timestamp: `2026-05-18T08:51:26.${530 + index}Z`,
        text: 'project-memory/attachments/composer/att_1/original.png 图上是什么',
      }),
    ]);

    const merged = mergeRoomMessages(messages, []);

    expect(merged).toHaveLength(1);
    expect(merged[0].targetAgentIds).toEqual(['agent-a', 'agent-b', 'agent-c']);
  });

  it('keeps original exact composer echo dedupe before ghost folding', () => {
    const native = roomMessage({
      id: 'native-exact-echo',
      agentId: 'agent-a',
      text: 'same prompt',
      timestamp: '2026-06-07T20:00:02.000Z',
    });
    const local = localComposerMessage({
      id: 'local-exact-prompt',
      text: 'same prompt',
      targetAgentIds: ['agent-a'],
      timestamp: '2026-06-07T20:00:00.000Z',
    });

    const merged = mergeRoomMessages([native], [local]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe('local-exact-prompt');
    expect((merged[0] as { ghostSasayaki?: boolean } | undefined)?.ghostSasayaki).toBeUndefined();
  });

  it('keeps a matched local composer prompt before a coarse same-second reply', () => {
    const nativeUser = roomMessage({
      id: 'native-coarse-user',
      agentId: 'agent-a',
      role: 'user',
      text: 'fast prompt',
      timestamp: '2026-08-20T18:43:56+00:00',
      violetSeq: 313,
    });
    const nativeReply = roomMessage({
      id: 'native-coarse-reply',
      agentId: 'agent-a',
      role: 'assistant',
      text: 'fast reply',
      timestamp: '2026-08-20T18:43:56+00:00',
      violetSeq: 314,
    });
    const local = localComposerMessage({
      id: 'local-precise-prompt',
      text: 'fast prompt',
      targetAgentIds: ['agent-a'],
      timestamp: '2026-08-20T18:43:56.412Z',
    });

    const merged = mergeRoomMessages([nativeUser, nativeReply], [local]);

    expect(merged.map((message) => message.id)).toEqual([
      'local-precise-prompt',
      'native-coarse-reply',
    ]);
    expect(merged[0]?.violetSeq).toBe(313);
    expect((merged[0] as { quoteRefId?: string } | undefined)?.quoteRefId).toBe('native-coarse-user');
  });

  it('marks only the first near native user echo as Ghost Sasayaki', () => {
    const nativeFirst = roomMessage({
      id: 'native-near-first',
      agentId: 'agent-a',
      text: '[Image #4]same prompt',
      timestamp: '2026-06-07T20:00:02.000Z',
    });
    const nativeSecond = roomMessage({
      id: 'native-near-second',
      agentId: 'agent-a',
      text: '[Image #5]same prompt',
      timestamp: '2026-06-07T20:00:04.000Z',
    });
    const local = localComposerMessage({
      id: 'local-image-prompt',
      text: 'project-memory/attachments/composer/att_1/original.png composer prompt',
      targetAgentIds: ['agent-a'],
      timestamp: '2026-06-07T20:00:00.000Z',
    });

    const merged = mergeRoomMessages([nativeFirst, nativeSecond], [local]);
    const first = merged.find((message) => message.id === 'native-near-first') as { ghostSasayaki?: boolean } | undefined;
    const second = merged.find((message) => message.id === 'native-near-second') as { ghostSasayaki?: boolean } | undefined;

    expect(first?.ghostSasayaki).toBe(true);
    expect(second?.ghostSasayaki).toBeUndefined();
  });

  it('does not mark native user echoes outside the Ghost Sasayaki window', () => {
    const native = roomMessage({
      id: 'native-late-echo',
      agentId: 'agent-a',
      text: '[Image #4]same prompt',
      timestamp: '2026-06-07T20:00:09.000Z',
    });
    const local = localComposerMessage({
      id: 'local-image-prompt',
      text: 'project-memory/attachments/composer/att_1/original.png same prompt',
      targetAgentIds: ['agent-a'],
      timestamp: '2026-06-07T20:00:00.000Z',
    });

    const merged = mergeRoomMessages([native], [local]);
    const late = merged.find((message) => message.id === 'native-late-echo') as { ghostSasayaki?: boolean } | undefined;

    expect(late?.ghostSasayaki).toBeUndefined();
  });

  it('marks native echoes that arrive just before the local composer bubble', () => {
    const native = roomMessage({
      id: 'native-early-echo',
      agentId: 'agent-a',
      text: '[Image #15]button spacing',
      timestamp: '2026-06-07T20:00:00Z',
    });
    const local = localComposerMessage({
      id: 'local-image-prompt',
      text: 'project-memory/attachments/composer/att_1/original.png composer button spacing',
      targetAgentIds: ['agent-a'],
      timestamp: '2026-06-07T20:00:02.000Z',
    });

    const merged = mergeRoomMessages([native], [local]);
    const early = merged.find((message) => message.id === 'native-early-echo') as { ghostSasayaki?: boolean } | undefined;

    expect(merged.map((message) => message.id)).toEqual(['local-image-prompt', 'native-early-echo']);
    expect(early?.ghostSasayaki).toBe(true);
  });

  it('marks internal KOTA_MESSAGE native echoes with provider attachment markers as Ghost Sasayaki', () => {
    const native = roomMessage({
      id: 'native-kota-message-echo',
      agentId: 'agent-a',
      text: '[Image #13]<KOTA_MESSAGE id="ember-reminder-1" from="ember" to="agent-a" intent="reminder">\nhello\n</KOTA_MESSAGE>',
      timestamp: '2026-06-07T20:00:00.000Z',
    });

    const merged = mergeRoomMessages([native], []);
    const echo = merged[0] as { ghostSasayaki?: boolean } | undefined;

    expect(echo?.ghostSasayaki).toBe(true);
  });

  it('marks internal KOTA_MESSAGE native echoes with trailing terminal controls as Ghost Sasayaki', () => {
    const native = roomMessage({
      id: 'native-kota-message-control-echo',
      agentId: 'agent-a',
      text: '<KOTA_MESSAGE id="ember-reminder-1" from="ember" to="agent-a" intent="reminder">\nhello\n</KOTA_MESSAGE>\u0015',
      timestamp: '2026-06-07T20:00:00.000Z',
    });

    const merged = mergeRoomMessages([native], []);
    const echo = merged[0] as { ghostSasayaki?: boolean } | undefined;

    expect(echo?.ghostSasayaki).toBe(true);
  });

});

describe('Violet room pagination merge', () => {
  it('keeps older loaded pages when the live window is already full', () => {
    const current = numberedMessages(200, 400);
    const older = numberedMessages(170, 200);

    const merged = mergeOlderRoomMessages(current, older);

    expect(merged).toHaveLength(230);
    expect(merged[0]?.id).toBe('m-170');
    expect(merged.at(-1)?.id).toBe('m-399');
  });

  it('does not recut loaded history on later live sync', () => {
    const current = mergeOlderRoomMessages(numberedMessages(200, 400), numberedMessages(170, 200));

    const merged = mergeSyncedNativeMessages(current, numberedMessages(400, 401), {
      preserveLoadedHistory: true,
    });

    expect(merged).toHaveLength(231);
    expect(merged[0]?.id).toBe('m-170');
    expect(merged.at(-1)?.id).toBe('m-400');
  });

  it('keeps normal live sync bounded before history is expanded', () => {
    const current = numberedMessages(0, 200);

    const merged = mergeSyncedNativeMessages(current, numberedMessages(200, 201));

    expect(merged).toHaveLength(200);
    expect(merged[0]?.id).toBe('m-1');
    expect(merged.at(-1)?.id).toBe('m-200');
  });

  it('keeps a loaded history page even when the merged count is exactly the live limit', () => {
    const current = mergeOlderRoomMessages(numberedMessages(30, 200), numberedMessages(0, 30));

    const merged = mergeSyncedNativeMessages(current, numberedMessages(200, 201), {
      preserveLoadedHistory: true,
    });

    expect(merged).toHaveLength(201);
    expect(merged[0]?.id).toBe('m-0');
    expect(merged.at(-1)?.id).toBe('m-200');
  });
});

function numberedMessages(start: number, end: number): VioletChatMessage[] {
  const base = Date.parse('2026-06-06T00:00:00.000Z');
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
    const index = start + offset;
    return roomMessage({
      id: `m-${index}`,
      timestamp: new Date(base + index * 1000).toISOString(),
      text: `message ${index}`,
    });
  });
}

function roomMessage(overrides: Partial<VioletChatMessage>): VioletChatMessage {
  return {
    id: 'm',
    sessionId: 's',
    agentId: 'agent-a',
    shell: 'claude',
    role: 'user',
    kind: 'message',
    timestamp: '2026-05-18T08:51:26.530Z',
    text: 'hello',
    sourcePath: null,
    nativeEventId: null,
    ...overrides,
  };
}

function localComposerMessage(
  overrides: Partial<VioletChatMessage> & { targetAgentIds: string[] },
): VioletChatMessage & {
  local: true;
  projectRoot: string;
  targetAgentIds: string[];
} {
  return {
    ...roomMessage({
      agentId: 'user',
      shell: 'composer',
      ...overrides,
    }),
    local: true,
    projectRoot: '/Users/example/Kota/Workspaces/demo-project',
    targetAgentIds: overrides.targetAgentIds,
  };
}


it('uses the explicit shell handoff origin for a whisper without turning the original input into one', () => {
  const base = { sessionId: 'new', agentId: 'agent-a', shell: 'claude', kind: 'message', timestamp: '2026-09-20T12:00:00Z' };
  const native: VioletChatMessage[] = [
    { ...base, id: 'handoff-id', role: 'system', text: 'Read project memory.', messageOrigin: 'shell_handoff' },
    { ...base, id: 'original-id', role: 'user', text: 'Continue the task.' },
  ];
  const merged = mergeRoomMessages(native, []);
  expect(merged.find((m) => m.id === 'handoff-id')).toMatchObject({ ghostSasayaki: true, text: 'Read project memory.' });
  expect(merged.find((m) => m.id === 'original-id')?.ghostSasayaki).toBeUndefined();
});
