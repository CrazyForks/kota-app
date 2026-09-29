import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VioletSummaryFault } from '../src/chrome/RightColumn';

const ERROR = 'codex summary CLI exited exit status: 1: Error: stream disconnected\n    at run_turn (codex.rs:1187)';
// The body is a <pre>; testing-library's text matcher collapses whitespace, so read it directly.
const body = () => document.querySelector('.violet-summary-fault-text');

describe('VioletSummaryFault', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing without an error and folds the text behind one line', () => {
    const view = render(<VioletSummaryFault error={null} provider="codex" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    view.rerender(<VioletSummaryFault error={ERROR} provider="codex" />);
    const line = screen.getByRole('button', { name: 'Show CLI error · codex' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('exited exit status: 1: Error: stream disconnected')).toBeInTheDocument();
    expect(body()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();

    fireEvent.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(body()?.textContent).toBe(ERROR);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    fireEvent.click(line);
    expect(body()).toBeNull();
  });

  it('copies the full error text and does not bubble clicks to the card', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onCard = vi.fn();
    render(
      <section onClick={onCard} onKeyDown={onCard}>
        <VioletSummaryFault error={ERROR} provider="codex" />
      </section>,
    );
    const line = screen.getByRole('button', { name: 'Show CLI error · codex' });
    fireEvent.keyDown(line, { key: 'Enter' });
    expect(line).toHaveAttribute('aria-expanded', 'true');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })); });
    expect(writeText).toHaveBeenCalledWith(ERROR);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1300); });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    fireEvent.click(body()!);
    expect(onCard).not.toHaveBeenCalled();
  });

  it('lets Enter on the Copy button copy instead of folding the line', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<VioletSummaryFault error={ERROR} provider="codex" />);
    const line = screen.getByRole('button', { name: 'Show CLI error · codex' });
    fireEvent.click(line);
    const copyButton = screen.getByRole('button', { name: 'Copy' });
    copyButton.focus();
    // A real Enter on a focused button: keydown bubbles first, then the
    // browser synthesizes the click only if keydown was not cancelled.
    const keydown = fireEvent.keyDown(copyButton, { key: 'Enter' });
    expect(keydown).toBe(true);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    await act(async () => { fireEvent.click(copyButton); });
    expect(writeText).toHaveBeenCalledWith(ERROR);
    expect(body()?.textContent).toBe(ERROR);
  });

  it('unmounts a folded line when the error clears', () => {
    const view = render(<VioletSummaryFault error={ERROR} provider="codex" />);
    expect(screen.getByRole('button', { name: 'Show CLI error · codex' })).toBeInTheDocument();
    view.rerender(<VioletSummaryFault error={null} provider="codex" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps an open line as resolved until the user closes it', () => {
    const view = render(<VioletSummaryFault error={ERROR} provider="codex" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show CLI error · codex' }));
    // The same error refreshed again keeps the open state.
    view.rerender(<VioletSummaryFault error={ERROR} provider="codex" />);
    expect(body()?.textContent).toBe(ERROR);

    view.rerender(<VioletSummaryFault error={null} provider="codex" />);
    const resolved = screen.getByRole('button', { name: 'Hide Resolved · codex' });
    expect(body()?.textContent).toBe(ERROR);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    fireEvent.click(resolved);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('replaces a resolved line with a new error folded', () => {
    const view = render(<VioletSummaryFault error={ERROR} provider="codex" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show CLI error · codex' }));
    view.rerender(<VioletSummaryFault error={null} provider="codex" />);
    expect(screen.getByRole('button', { name: 'Hide Resolved · codex' })).toBeInTheDocument();

    view.rerender(<VioletSummaryFault error="claude summary CLI timed out" provider="claude" />);
    const line = screen.getByRole('button', { name: 'Show CLI error · claude' });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('timed out')).toBeInTheDocument();
    expect(body()).toBeNull();
  });
});
