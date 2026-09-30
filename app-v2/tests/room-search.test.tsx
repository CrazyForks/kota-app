import { useState, type ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../src/pty-client';
import { VioletRoomSearch } from '../src/chrome/VioletRoomSearch';
import { Stage } from '../src/chrome/Stage';
import { SearchMatchText } from '../src/chrome/room-search-elements';
import { serializeRoomQuotePrompt, type RoomQuoteReference } from '../src/lib/room-quote';

const root = '/tmp/search-demo';
const agentMeta = { 'agent-a': { name: 'Ada', emoji: 'A', role: 'Engineer', hue: '#fff', avatarClass: 'provider-claude' } };
const message = (id: string, text = `Message ${id}`, extra: Partial<client.VioletChatMessage> = {}): client.VioletChatMessage => ({
  id, text, agentId: 'agent-a', sessionId: 'session', shell: 'claude', role: 'assistant', kind: 'message', timestamp: '2026-09-01T12:00:00Z', model: 'test-model', ...extra,
});
const page = (hits = [message('one', 'First matching message'), message('two', 'Second matching message')], nextCursor?: string): client.VioletRoomSearchResult => ({ hits, matchTerms: ['matching'], total: 7, truncated: false, nextCursor });
const context = (messages = [message('one')], resolvedTargetId?: string): client.VioletRoomState => ({ messages, resolvedTargetId, sources: [], rawLogDir: '', chathistoryDir: '', syncedAt: '' });
const temporalGap = [
  '<KOTA_TEMPORAL_GAP v="1" current_time="2026-09-01T12:00:00Z">',
  'It has been over 24 hours since your last completed response in this room.',
  '</KOTA_TEMPORAL_GAP>',
].join('\n');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Harness({ onQuoteMessage }: Pick<ComponentProps<typeof VioletRoomSearch>, 'onQuoteMessage'>) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Reopen search</button>{open && <VioletRoomSearch projectRoot={root} projectName="Demo" agentMeta={agentMeta} onClose={() => setOpen(false)} onQuoteMessage={onQuoteMessage} />}</>;
}
async function search(query = 'matching') {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
  await act(async () => { await vi.advanceTimersByTimeAsync(301); });
}
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[data-search-message-id]')];
function geometry(element: HTMLElement, scrollTop: number, scrollHeight = 2000, clientHeight = 400) {
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: scrollHeight }, clientHeight: { configurable: true, value: clientHeight } });
  element.scrollTop = scrollTop;
  fireEvent.scroll(element);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(client, 'loadAccountUserIdentity').mockResolvedValue({ name: 'Morgan', avatarId: 'user-default' });
  vi.spyOn(client, 'searchVioletRoom').mockResolvedValue(page());
  vi.spyOn(client, 'readVioletRoomCache').mockResolvedValue(context());
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('project room search', () => {
  it('repeats the full date and room-formatted clock on each result, leaving context timestamps unchanged', async () => {
    // Reinstall the clock: beforeEach only fakes timeout functions, not Date.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 8, 28, 12));
    const today = message('today', 'First matching result', { timestamp: new Date(2026, 8, 28, 9, 42).toISOString() });
    const sameDay = message('same-day', 'Second matching result', { timestamp: new Date(2026, 8, 28, 9, 40).toISOString() });
    const yesterday = message('yesterday', 'Older matching result', { timestamp: new Date(2026, 8, 27, 21, 30).toISOString() });
    const invalid = message('invalid-time', 'Matching result with invalid timestamp', { timestamp: 'invalid timestamp' });
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([today, sameDay, yesterday, invalid]));
    vi.mocked(client.readVioletRoomCache).mockResolvedValue(context([yesterday], yesterday.id));
    render(<Harness />);
    await search();
    const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
    expect(rows().map((row) => row.querySelector('.room-search-day')?.textContent)).toEqual(['Today', 'Today', 'Yesterday', 'invalid timestamp']);
    expect(rows()[0].querySelector('.room-search-clock')).toHaveTextContent(clock.format(new Date(today.timestamp)));
    expect(rows()[1].querySelector('.room-search-clock')).toHaveTextContent(clock.format(new Date(sameDay.timestamp)));
    expect(rows()[0].querySelector('time')).toHaveAttribute('datetime', today.timestamp);
    expect(rows()[0].querySelector('.room-search-result-heading time')).toBeNull();
    expect(rows().every((row) => !row.hasAttribute('aria-current'))).toBe(true);
    expect(rows()[3].querySelector('.room-search-when')).toHaveClass('invalid');
    expect(rows()[3].querySelector('.room-search-clock')).toBeNull();
    fireEvent.click(rows()[2]);
    await act(async () => {});
    const area = screen.getByLabelText('Context messages');
    expect(area.querySelector('.room-search-when')).toBeNull();
    expect(area.querySelector('time')).toHaveTextContent(`${clock.format(new Date(yesterday.timestamp))} [Sep-27-2026]`);
  });

  it('collapses broadcast hits with all targets, but keeps different text and sends beyond five seconds separate', async () => {
    const first = message('broadcast-a', 'A matching broadcast', { role: 'user' });
    const copy = message('broadcast-b', first.text, { role: 'user', agentId: 'agent-b', timestamp: '2026-09-01T12:00:05Z' });
    const different = message('different', 'A different matching question', { role: 'user', timestamp: '2026-09-01T12:00:04Z' });
    const later = message('later', first.text, { role: 'user', timestamp: '2026-09-01T12:00:05.001Z' });
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([later, copy, different, first]));
    render(<Harness />);
    await search();
    expect(rows().map((row) => row.dataset.searchMessageId)).toEqual(['later', 'different', first.id]);
    expect(within(rows()[2]).getByText('@Ada')).toBeInTheDocument();
    expect(within(rows()[2]).getByText('@agent b')).toBeInTheDocument();
    expect(rows()[0].querySelectorAll('.violet-target-badge')).toHaveLength(1);
    expect(screen.getByText('7 matching records')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    expect(rows()[2]).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    await act(async () => {});
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: first.id, before: 15, after: 15 } });
    expect(copy.targetAgentIds).toBeUndefined();
  });

  it('recomputes broadcasts across Load more and transfers selection to the representative', async () => {
    const first = message('broadcast-a', 'A matching broadcast', { role: 'user' });
    const copy = message('broadcast-b', first.text, { role: 'user', agentId: 'agent-b', timestamp: '2026-09-01T12:00:04Z' });
    const between = message('between', 'A matching reply', { timestamp: '2026-09-01T12:00:02Z' });
    vi.mocked(client.searchVioletRoom).mockResolvedValueOnce(page([copy], 'broadcast-page')).mockResolvedValueOnce(page([between, first]));
    render(<Harness />);
    await search();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    await act(async () => {});
    expect(rows().map((row) => row.dataset.searchMessageId)).toEqual([between.id, first.id]);
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');
    expect(within(rows()[1]).getByText('@Ada')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('@agent b')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowUp' });
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    await act(async () => {});
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: first.id, before: 15, after: 15 } });
  });

  it('resolves a collapsed context target and uses representative IDs through pagination', async () => {
    const first = message('broadcast-a', 'A matching broadcast', { role: 'user' });
    const copy = message('broadcast-b', first.text, { role: 'user', agentId: 'agent-b', timestamp: '2026-09-01T12:00:04Z' });
    // The target fits both representatives' pairwise windows; the room's first group must win.
    const later = message('broadcast-later', first.text, { role: 'user', timestamp: '2026-09-01T12:00:06Z' });
    const older = message('broadcast-older', first.text, { role: 'user', agentId: 'agent-c', timestamp: '2026-09-01T11:59:59Z' });
    vi.mocked(client.readVioletRoomCache).mockResolvedValueOnce(context([first, copy, later], copy.id))
      .mockResolvedValueOnce(context([older, first, copy]))
      .mockResolvedValueOnce(context([later, message('after', 'A later reply', { timestamp: '2026-09-01T12:00:10Z' })]));
    render(<Harness />);
    await search();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    const area = screen.getByLabelText('Context messages');
    const targetId = () => area.querySelector<HTMLElement>('.room-search-context-target [data-violet-message-id]')?.dataset.violetMessageId;
    expect(targetId()).toBe(first.id);
    expect(area.querySelectorAll('[data-violet-message-id]')).toHaveLength(2);
    expect(area.querySelector('.room-search-context-target')).toHaveTextContent('@agent b');
    geometry(area, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier 15 messages' }));
    await act(async () => {});
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: first.id, before: 15, after: 0 } });
    expect(targetId()).toBe(older.id);
    expect(area.querySelectorAll('[data-violet-message-id]')).toHaveLength(2);
    expect(area.querySelector('.room-search-context-target')).toHaveTextContent('@agent c');
    geometry(area, 1600);
    fireEvent.click(screen.getByRole('button', { name: 'Later 15 messages' }));
    await act(async () => {});
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: later.id, before: 0, after: 15 } });
    expect(area.querySelectorAll('[data-violet-message-id]')).toHaveLength(3);
    expect(targetId()).toBe(older.id);
  });

  it.each([
    ['none', '', 'matching response'],
    ['padding', ' \u0015\n', '\u0015 matching response'],
    ['image', '[Image #1] ', '[Image #1] matching response'],
    ['gap-image', `${temporalGap}\n[Image #1] `, '[Image #1] matching response'],
    ['image-gap', `[Image #1] ${temporalGap}\n`, '[Image #1] matching response'],
  ])('renders and quotes an envelope after a preserved prefix (%s)', async (name, prefix, excerpt) => {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      disconnect() {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    });
    const nativeImages = vi.spyOn(client, 'claudeNativeImagesForEvent').mockResolvedValue({ '1': 'data:image/png;base64,dGVzdA==' });
    const ref: RoomQuoteReference = { ref: 'quoted-event', project: 'search-demo', from: { id: 'agent-a', name: 'Ada' }, to: [{ id: 'user', name: 'Morgan' }], at: '2026-09-01T11:00:00Z', excerpt: 'Original quoted text', truncated: false };
    const original = prefix + serializeRoomQuotePrompt([ref], 'matching response');
    const hit = message('quoted-user', original, { role: 'user', sourcePath: `/Users/example/.claude/projects/mock-search/quote-${name}.jsonl`, nativeEventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd:0' });
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([hit]));
    vi.mocked(client.readVioletRoomCache).mockResolvedValue(context([hit]));
    const onQuote = vi.fn<NonNullable<ComponentProps<typeof VioletRoomSearch>['onQuoteMessage']>>().mockReturnValue('inserted');
    render(<Harness onQuoteMessage={onQuote} />);
    await search();
    expect(rows()[0]).toHaveTextContent('Original quoted text');
    expect(rows()[0]).not.toHaveTextContent('KOTA_QUOTE_META');
    expect(rows()[0]).not.toHaveTextContent('KOTA_TEMPORAL_GAP');
    fireEvent.click(rows()[0]);
    await act(async () => {});
    const bubble = document.querySelector('[data-violet-message-id="quoted-user"]') as HTMLElement;
    expect(within(bubble).getByTestId('violet-room-quote-cards')).toHaveTextContent('Original quoted text');
    expect(bubble).toHaveTextContent('matching response');
    expect(bubble).not.toHaveTextContent('KOTA_QUOTE_META');
    expect(bubble).not.toHaveTextContent('over 24 hours');
    if (prefix.includes('[Image #1]')) {
      expect(rows()[0]).toHaveTextContent('[Image #1]');
      expect(nativeImages).toHaveBeenCalledWith({ sourcePath: hit.sourcePath, nativeEventId: hit.nativeEventId, maxImages: 1 });
      expect(within(bubble).getByRole('img', { name: '[Image #1]' })).toHaveAttribute('src', 'data:image/png;base64,dGVzdA==');
    }
    fireEvent.click(within(bubble).getByRole('button', { name: /Quote/ }));
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ ref: hit.id, excerpt }));
    expect(hit.text).toBe(original);
  });

  it('leaves malformed quote metadata visible instead of consuming its prefix or text', async () => {
    const original = ' \u0015[Image #1] <KOTA_QUOTE_META v="1">\nAn incomplete quote';
    const hit = message('malformed-quote', original, { role: 'user' });
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([hit]));
    vi.mocked(client.readVioletRoomCache).mockResolvedValue(context([hit]));
    render(<Harness />);
    await search('quote');
    expect(rows()[0]).toHaveTextContent('[Image #1] <KOTA_QUOTE_META');
    fireEvent.click(rows()[0]);
    await act(async () => {});
    expect(screen.queryByTestId('violet-room-quote-cards')).not.toBeInTheDocument();
    const bubble = document.querySelector('[data-violet-message-id="malformed-quote"]') as HTMLElement;
    expect(bubble).toHaveTextContent('KOTA_QUOTE_META');
    expect(bubble).toHaveTextContent('An incomplete quote');
    expect(hit.text).toBe(original);
  });

  it('hides a leading temporal reminder in results, context and quoted excerpts without changing the source', async () => {
    const original = `${temporalGap}\n\nhello world`;
    const hit = message('temporal-user', original, { role: 'user' });
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([hit]));
    vi.mocked(client.readVioletRoomCache).mockResolvedValue(context([hit]));
    const onQuote = vi.fn<NonNullable<ComponentProps<typeof VioletRoomSearch>['onQuoteMessage']>>().mockReturnValue('inserted');
    render(<Harness onQuoteMessage={onQuote} />);
    await search('hello');
    expect(rows()[0]).toHaveTextContent('hello world');
    expect(rows()[0]).not.toHaveTextContent('over 24 hours');
    expect(rows()[0]).not.toHaveTextContent('KOTA_TEMPORAL_GAP');
    fireEvent.click(rows()[0]);
    await act(async () => {});
    const bubble = document.querySelector('[data-violet-message-id="temporal-user"]') as HTMLElement;
    expect(bubble).toHaveTextContent('hello world');
    expect(bubble).not.toHaveTextContent('over 24 hours');
    expect(bubble).not.toHaveTextContent('KOTA_TEMPORAL_GAP');
    fireEvent.click(within(bubble).getByRole('button', { name: /Quote/ }));
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ ref: hit.id, excerpt: 'hello world' }));
    expect(hit.text).toBe(original);
  });

  it('preserves image-marker recovery when hiding a leading temporal reminder', async () => {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      disconnect() {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
    });
    const imageUrl = 'data:image/png;base64,dGVzdC1pbWFnZQ==';
    const nativeImages = vi.spyOn(client, 'claudeNativeImagesForEvent').mockResolvedValue({ '1': imageUrl });
    const original = `[Image #1] ${temporalGap}\n\nhi`;
    const hit = message('temporal-image', original, {
      role: 'user', sourcePath: '/Users/example/.claude/projects/mock-search/session.jsonl',
      nativeEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc:0',
    });
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([hit]));
    vi.mocked(client.readVioletRoomCache).mockResolvedValue(context([hit]));
    render(<Harness />);
    await search('hi');
    expect(rows()[0]).toHaveTextContent('[Image #1]');
    expect(rows()[0]).toHaveTextContent('hi');
    expect(rows()[0]).not.toHaveTextContent('over 24 hours');
    fireEvent.click(rows()[0]);
    await act(async () => {});
    const bubble = document.querySelector('[data-violet-message-id="temporal-image"]') as HTMLElement;
    expect(bubble).toHaveTextContent('hi');
    expect(bubble).not.toHaveTextContent('over 24 hours');
    expect(bubble).not.toHaveTextContent('KOTA_TEMPORAL_GAP');
    expect(nativeImages).toHaveBeenCalledWith({ sourcePath: hit.sourcePath, nativeEventId: hit.nativeEventId, maxImages: 1 });
    expect(within(bubble).getByRole('img', { name: '[Image #1]' })).toHaveAttribute('src', imageUrl);
    expect(hit.text).toBe(original);
  });

  it('starts unselected, first Down selects first, Enter opens context; Back preserves explicit selection and scroll; Esc has two layers', async () => {
    render(<Harness />);
    await search();
    expect(rows().every((row) => !row.hasAttribute('aria-current'))).toBe(true);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    expect(screen.queryByRole('region', { name: 'Message context' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowUp' });
    expect(rows()[0]).not.toHaveAttribute('aria-current');
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' });
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
    geometry(screen.getByLabelText('Result list'), 280);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
    await act(async () => {});
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: 'one', before: 15, after: 15 } });
    expect(screen.getByRole('region', { name: 'Message context' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByLabelText('Result list').scrollTop).toBe(280);
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
    expect(document.activeElement).toBe(rows()[0]);
    expect(screen.getByRole('searchbox')).toHaveValue('matching');
    fireEvent.keyDown(rows()[0], { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reopen search'));
    await act(async () => {});
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(rows()).toHaveLength(0);
  });

  it('debounces, keeps only the latest pending query, and never overlaps scans even after failure', async () => {
    const first = deferred<client.VioletRoomSearchResult>();
    const last = deferred<client.VioletRoomSearchResult>();
    vi.mocked(client.searchVioletRoom).mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    render(<Harness />);
    await search('slow');
    await search('discard this queued query');
    await search('latest');
    expect(client.searchVioletRoom).toHaveBeenCalledTimes(1);
    await act(async () => first.reject('old failure'));
    expect(client.searchVioletRoom).toHaveBeenCalledTimes(2);
    expect(client.searchVioletRoom).toHaveBeenLastCalledWith({ projectRoot: root, query: 'latest', humanOnly: false, limit: 50 });
    expect(screen.queryByText('old failure')).not.toBeInTheDocument();
    await act(async () => last.resolve(page([message('latest')])));
    expect(rows().map((row) => row.dataset.searchMessageId)).toEqual(['latest']);
    fireEvent.click(screen.getByText('Human Msg Only'));
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(client.searchVioletRoom).toHaveBeenLastCalledWith(expect.objectContaining({ humanOnly: true }));
    expect(rows()[0]).not.toHaveAttribute('aria-current');
  });

  it('clearing the query invalidates the running scan without scheduling an empty scan', async () => {
    const scan = deferred<client.VioletRoomSearchResult>();
    vi.mocked(client.searchVioletRoom).mockReturnValueOnce(scan.promise);
    render(<Harness />);
    await search();
    fireEvent.click(screen.getByLabelText('Clear query'));
    await act(async () => scan.resolve(page()));
    expect(rows()).toHaveLength(0);
    expect(client.searchVioletRoom).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Find a message in this room')).toBeInTheDocument();
  });

  it('paginates a short deduped page by nextCursor, keeps raw total, and reveals Load more only at the boundary', async () => {
    vi.mocked(client.searchVioletRoom).mockResolvedValueOnce(page([message('one')], 'opaque-cursor')).mockResolvedValueOnce({ hits: [message('one'), message('three')], matchTerms: ['matching'], truncated: false });
    render(<Harness />);
    await search();
    const list = screen.getByLabelText('Result list');
    geometry(list, 200);
    expect(screen.queryByRole('button', { name: 'Load more results' })).not.toBeInTheDocument();
    geometry(list, 1600);
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    await act(async () => {});
    expect(client.searchVioletRoom).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'opaque-cursor', limit: 50 }));
    expect(rows().map((row) => row.dataset.searchMessageId)).toEqual(['one', 'three']);
    expect(screen.getByText('7 matching records')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more results' })).not.toBeInTheDocument();
  });

  it('keeps human identity, Telegram identity and bus target mapping, provider/model and literal match highlights', async () => {
    vi.mocked(client.searchVioletRoom).mockResolvedValue(page([
      message('human', 'A matching question', { role: 'user', agentId: 'agent-a' }),
      message('telegram', 'A matching Telegram message', { agentId: 'laughing-man', shell: 'system', actorIntent: 'telegram', targetAgentIds: ['agent-a'] }),
      message('bus', 'A matching handoff', { shell: 'system', nativeEventId: 'agentbus-test', targetAgentIds: ['agent-b'], agentDisplayName: 'Ada' }),
      message('answer', 'A MATCHING answer'),
    ]));
    render(<Harness />);
    await search();
    expect(within(rows()[0]).getByText('Morgan')).toBeInTheDocument();
    expect(rows()[0].querySelector('.room-search-avatar')).toHaveClass('system-human');
    expect(within(rows()[1]).getByText('Laughing Man')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('@Ada')).toBeInTheDocument();
    expect(within(rows()[2]).getByText('@agent b')).toBeInTheDocument();
    expect(rows()[3].querySelector('[data-provider="claude"]')).toBeInTheDocument();
    expect(within(rows()[3]).getByText('test-model')).toBeInTheDocument();
    expect(rows()[3].querySelector('mark')).toHaveTextContent('MATCHING');
    expect(document.querySelector('.room-search-results .violet-msg')).not.toBeInTheDocument();
    const { container } = render(<SearchMatchText text="A [literal] and <script>never</script>" terms={['[literal]', '<script>']} />);
    expect(container.querySelectorAll('mark')).toHaveLength(2);
    expect(container.querySelector('script')).toBeNull();
  });

  it('retries the failed next page without discarding the already loaded results', async () => {
    vi.mocked(client.searchVioletRoom).mockResolvedValueOnce(page([message('one')], 'next-page')).mockRejectedValueOnce('Read failed').mockResolvedValueOnce(page([message('two')]));
    render(<Harness />);
    await search();
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    await act(async () => {});
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {});
    expect(client.searchVioletRoom).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'next-page' }));
    expect(rows().map((row) => row.dataset.searchMessageId)).toEqual(['one', 'two']);
  });

  it('recenters after images settle, but stops adjusting as soon as the user scrolls', async () => {
    const resizes = new Set<() => void>();
    vi.stubGlobal('ResizeObserver', class {
      notify: () => void;
      constructor(callback: ResizeObserverCallback) { this.notify = () => callback([], this as unknown as ResizeObserver); }
      observe() { resizes.add(this.notify); }
      disconnect() { resizes.delete(this.notify); }
    });
    render(<Harness />);
    await search();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    const area = screen.getByLabelText('Context messages');
    geometry(area, 0);
    const node = area.querySelector<HTMLElement>('[data-violet-message-id="one"]')!;
    Object.defineProperty(node, 'offsetHeight', { value: 100 });
    let contentTop = 500;
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => ({ top: contentTop - area.scrollTop } as DOMRect));
    act(() => { resizes.forEach((notify) => notify()); });
    expect(area.scrollTop).toBe(350);
    contentTop = 650;
    act(() => { resizes.forEach((notify) => notify()); });
    expect(area.scrollTop).toBe(500);
    fireEvent.wheel(area);
    contentTop = 750;
    act(() => { resizes.forEach((notify) => notify()); });
    expect(area.scrollTop).toBe(500);
  });

  it('uses resolvedTargetId, preserves original quote/system bubbles, and reports quote limits inside the modal', async () => {
    const ref: RoomQuoteReference = { ref: 'original', project: 'search-demo', from: { id: 'agent-a', name: 'Ada' }, to: [{ id: 'user', name: 'Morgan' }], at: '2026-09-01T12:00:00Z', excerpt: 'Quoted excerpt', truncated: false };
    const quoted = serializeRoomQuotePrompt([ref], 'Body with a quote');
    vi.mocked(client.readVioletRoomCache).mockResolvedValue(context([
      message('earlier', 'Context earlier'), message('resolved', quoted),
      message('system', 'Session compacted', { kind: 'compaction', role: 'system' }),
      message('later', 'Context later'),
    ], 'resolved'));
    const onQuote = vi.fn<NonNullable<ComponentProps<typeof VioletRoomSearch>['onQuoteMessage']>>().mockReturnValue('limit');
    render(<Harness onQuoteMessage={onQuote} />);
    await search();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    expect(document.querySelector('.room-search-context-target [data-violet-message-id="resolved"]')).toBeInTheDocument();
    expect(screen.getByTestId('violet-room-quote-cards')).toHaveTextContent('Quoted excerpt');
    expect(document.querySelector('.violet-msg.compaction')).toHaveTextContent('Session compacted');
    fireEvent.click(within(document.querySelector('[data-violet-message-id="resolved"]') as HTMLElement).getByRole('button', { name: /Quote/ }));
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ ref: 'resolved' }));
    expect(within(screen.getByRole('dialog')).getByText('4 quotes max')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Message context' })).toBeInTheDocument();
    expect(screen.queryByText('Open terminal')).not.toBeInTheDocument();
    expect(document.querySelector('.agent-commend-button')).toBeNull();
  });

  it('loads context at ID anchors, dedupes overlap, preserves scroll anchor and caps the window at 200', async () => {
    const initial = Array.from({ length: 190 }, (_, n) => message(String(n), `Context item ${n}`));
    vi.mocked(client.readVioletRoomCache).mockResolvedValueOnce(context(initial, '90')).mockResolvedValueOnce(context(Array.from({ length: 16 }, (_, n) => message(String(n - 15), `Context item ${n - 15}`))));
    render(<Harness />);
    await search();
    fireEvent.click(rows()[0]);
    await act(async () => {});
    const area = screen.getByLabelText('Context messages');
    geometry(area, 800);
    expect(screen.queryByRole('button', { name: 'Earlier 15 messages' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Later 15 messages' })).not.toBeInTheDocument();
    geometry(area, 0);
    const node = area.querySelector<HTMLElement>('[data-violet-message-id="0"]')!;
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => {
      const top = area.querySelector('[data-violet-message-id="-15"]') ? 90 : 30;
      return { top, bottom: top + 70 } as DOMRect;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Earlier 15 messages' }));
    await act(async () => {});
    expect(area.scrollTop).toBe(60);
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: '0', before: 15, after: 0 } });
    const ids = [...area.querySelectorAll<HTMLElement>('[data-violet-message-id]')].map((item) => item.dataset.violetMessageId);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(ids[0]).toBe('-15');
    expect(ids.at(-1)).toBe('184');
    geometry(area, 1600);
    vi.mocked(client.readVioletRoomCache).mockResolvedValueOnce(context([message('184')]));
    fireEvent.click(screen.getByRole('button', { name: 'Later 15 messages' }));
    await act(async () => {});
    expect(client.readVioletRoomCache).toHaveBeenLastCalledWith({ projectRoot: root, around: { id: '184', before: 0, after: 15 } });
    expect(screen.getByText('End of history')).toBeInTheDocument();
  });

  it('closing from context discards late reads and a late search cannot fill a reopened session', async () => {
    const read = deferred<client.VioletRoomState>();
    vi.mocked(client.readVioletRoomCache).mockReturnValueOnce(read.promise);
    render(<Harness />);
    await search();
    fireEvent.click(rows()[0]);
    fireEvent.click(screen.getByLabelText('Close search'));
    await act(async () => read.resolve(context([message('late-context')])));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reopen search'));
    const late = deferred<client.VioletRoomSearchResult>();
    vi.mocked(client.searchVioletRoom).mockReturnValueOnce(late.promise);
    await search();
    fireEvent.click(screen.getByLabelText('Close search'));
    fireEvent.click(screen.getByText('Reopen search'));
    await act(async () => late.resolve(page()));
    expect(rows()).toHaveLength(0);
  });
});

const stageProps: ComponentProps<typeof Stage> = {
  sceneKey: 'conversation', liveAgents: new Set(), tableSlots: [], targetAgent: null,
  centerpiece: 'fire', roomColor: '#222', deskColor: '#333', roomTheme: 'classic', deskTheme: 'warm',
  onOpenAgent: () => {}, onChangeCenter: () => {}, onChangeRoom: () => {}, onChangeDesk: () => {}, onChangeRoomTheme: () => {}, onChangeDeskTheme: () => {},
};
it('Stage owns search outside room mounting; project changes close it, discard old responses, and do not reopen on return', async () => {
  vi.useRealTimers();
  const old = deferred<client.VioletRoomSearchResult>();
  vi.mocked(client.searchVioletRoom).mockReturnValueOnce(old.promise);
  const { rerender } = render(<Stage {...stageProps} groupChatOpen projectRoot={root} />);
  fireEvent.click(screen.getByLabelText('Search room history'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old project query' } });
  await waitFor(() => expect(client.searchVioletRoom).toHaveBeenCalledTimes(1));
  rerender(<Stage {...stageProps} groupChatOpen={false} projectRoot={root} />);
  expect(screen.getByRole('searchbox')).toHaveValue('old project query');
  rerender(<Stage {...stageProps} groupChatOpen projectRoot="/tmp/other-demo" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Search room history'));
  await act(async () => old.resolve(page([message('old-project-hit')])));
  expect(rows()).toHaveLength(0);
  expect(screen.getByRole('searchbox')).toHaveValue('');
  rerender(<Stage {...stageProps} groupChatOpen projectRoot={root} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'f', metaKey: true });
  await act(async () => {});
  expect(screen.getByRole('searchbox')).toHaveValue('');
});

it('Stage leaves Find to dialogs, menus and terminal inputs', () => {
  render(<>
    <Stage {...stageProps} groupChatOpen projectRoot={root} />
    <div role="dialog"><textarea aria-label="Dialog input" /></div>
    <div role="menu"><button>Menu item</button></div>
    <textarea className="win-ime-capture" aria-label="Terminal input" />
  </>);
  for (const target of [screen.getByLabelText('Dialog input'), screen.getByText('Menu item'), screen.getByLabelText('Terminal input')]) {
    target.focus();
    expect(fireEvent.keyDown(target, { key: 'f', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(target, { key: 'f', ctrlKey: true })).toBe(true);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  }
});

it('Stage opens Find from the composer only with an open project room and an unhandled plain shortcut', async () => {
  const composer = <textarea aria-label="Composer input" onKeyDown={(event) => { if (event.key === 'F') event.preventDefault(); }} />;
  const { rerender } = render(<Stage {...stageProps} groupChatOpen={false} projectRoot={root} composer={composer} />);
  const input = screen.getByLabelText('Composer input');
  input.focus();
  fireEvent.keyDown(input, { key: 'f', metaKey: true });
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  rerender(<Stage {...stageProps} groupChatOpen composer={composer} />);
  fireEvent.keyDown(input, { key: 'f', metaKey: true });
  expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  rerender(<Stage {...stageProps} groupChatOpen projectRoot={root} composer={composer} />);
  for (const shortcut of [
    { key: 'f' }, { key: 'g', metaKey: true },
    { key: 'f', metaKey: true, shiftKey: true }, { key: 'f', metaKey: true, altKey: true },
    { key: 'f', metaKey: true, repeat: true }, { key: 'f', metaKey: true, isComposing: true },
    { key: 'F', metaKey: true },
  ]) {
    fireEvent.keyDown(input, shortcut);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  }
  expect(screen.getByRole('region', { name: 'Violet room' })).not.toHaveAttribute('tabindex');
  expect(fireEvent.keyDown(input, { key: 'f', ctrlKey: true })).toBe(false);
  await act(async () => {});
  expect(screen.getByRole('searchbox')).toHaveValue('');
});

it('Find in an open search preserves its query and returns from context without creating a new session', async () => {
  vi.useRealTimers();
  render(<Stage {...stageProps} groupChatOpen projectRoot={root} />);
  fireEvent.keyDown(document.body, { key: 'f', metaKey: true });
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'matching' } });
  await waitFor(() => expect(rows()).toHaveLength(2));
  const input = screen.getByRole('searchbox');
  fireEvent.keyDown(window, { key: 'f', metaKey: true });
  expect(screen.getByRole('searchbox')).toBe(input);
  expect(input).toHaveValue('matching');
  fireEvent.click(rows()[0]);
  await act(async () => {});
  fireEvent.keyDown(screen.getByRole('button', { name: /Back to results/ }), { key: 'f', metaKey: true });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(screen.queryByRole('region', { name: 'Message context' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('dialog', { name: 'Search room history' })).toHaveLength(1);
  expect(input).toHaveValue('matching');
  expect(rows()).toHaveLength(2);
  expect(client.searchVioletRoom).toHaveBeenCalledTimes(1);
});
