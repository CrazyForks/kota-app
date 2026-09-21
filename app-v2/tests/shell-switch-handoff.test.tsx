import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { VioletRoomPanel, mergeRoomMessages } from '../src/chrome/VioletRoomPanel';
import * as client from '../src/pty-client';
import fixture from './fixtures/shell-switch-handoff.json';

afterEach(() => vi.restoreAllMocks());

it('renders the real Rust handoff as one whisper alongside the unchanged composer message', async () => {
  const messages = fixture as client.VioletChatMessage[];
  const merged = mergeRoomMessages(messages, [{
    id: 'local-input', sessionId: 'local-composer', agentId: 'human', shell: 'human',
    role: 'user', kind: 'message', timestamp: '2026-09-20T12:00:00Z',
    text: 'Do the next task.', targetAgentIds: ['agent-fixture73'],
  }]);
  expect(merged.filter((message) => message.text === 'Do the next task.')).toHaveLength(1);
  expect(merged.filter((message) => message.messageOrigin === 'shell_handoff')).toHaveLength(1);
  vi.spyOn(client, 'readVioletRoomCache').mockResolvedValue({
    messages, sources: [], workEvents: [], agentBusReceipts: [],
    rawLogDir: '/tmp/fixture-zenith-river-73/raw_logs',
    chathistoryDir: '/tmp/fixture-zenith-river-73/chathistory',
    syncedAt: '2026-09-20T12:00:02Z',
  });
  const view = render(<VioletRoomPanel projectRoot="/tmp/fixture-zenith-river-73" agentIds={['agent-fixture73']} />);
  try {
    await screen.findByText('Do the next task.');
    const whisper = await screen.findByText('Ghost Sasayaki');
    await userEvent.click(whisper);
    await screen.findByText(/Your provider changed from codex to claude/);
    await waitFor(() => expect(view.container.querySelectorAll('.ghost-sasayaki')).toHaveLength(1));
    expect(screen.getAllByText('Do the next task.')).toHaveLength(1);
  } finally {
    view.unmount();
  }
});
