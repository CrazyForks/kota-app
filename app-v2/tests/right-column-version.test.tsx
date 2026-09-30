import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { RightColumn } from '../src/chrome/RightColumn';
import { version as bundledVersion } from '../src-tauri/tauri.conf.json';

describe('Right column app version', () => {
  it('keeps the version outside the scrolling cards while Archive stays inside', async () => {
    await act(async () => {
      render(
        <RightColumn
          sceneKey="conversation"
          onOpenHotMem={vi.fn()}
          footerSlot={<button type="button">Archive</button>}
        />,
      );
    });

    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveClass('sidebar-right');
    const scroller = sidebar.querySelector('.sr-body');
    expect(scroller).not.toBeNull();
    expect(scroller!.parentElement).toBe(sidebar);

    const version = screen.getByRole('note', { name: `Kota version ${bundledVersion}` });
    expect(version).toHaveClass('kota-version-label');
    expect(version.parentElement).toBe(sidebar);
    const children = Array.from(sidebar.children);
    expect(children.indexOf(version)).toBeGreaterThan(children.indexOf(scroller!));
    expect(version).toHaveTextContent('KOTA');
    expect(version).toHaveTextContent(`v${bundledVersion}`);

    const archiveSlot = scroller!.querySelector('.sr-footer-slot');
    expect(archiveSlot).not.toBeNull();
    expect(archiveSlot).toContainElement(screen.getByRole('button', { name: 'Archive' }));
  });
});
