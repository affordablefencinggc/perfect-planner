import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComponentPlansWorkspace } from '../src/components/ComponentPlansWorkspace.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('component registry bootstrap uses an empty JSON POST before capability inspection', async () => {
  const fetcher = vi.fn(async (url) => ({ ok: true, status: 200, json: async () => String(url).endsWith('/session')
    ? { actor: 'fixture-owner', token: 'fixture-component-token' }
    : { valid: true, planId: 'PP-CLEANROOM', revision: 0, head: null, registrations: [] } }));
  vi.stubGlobal('fetch', fetcher);
  render(<ComponentPlansWorkspace activeProject={{ kind: 'demo' }} />);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/inspect'))).toBe(true));
  const session = fetcher.mock.calls.find(([url]) => String(url).endsWith('/session'))[1];
  expect(session.method).toBe('POST');
  expect(session.credentials).toBe('same-origin');
  expect(session.headers['content-type']).toBe('application/json');
  expect(JSON.parse(session.body)).toEqual({});
  const inspection = fetcher.mock.calls.find(([url]) => String(url).endsWith('/inspect'))[1];
  expect(inspection.headers['x-pp-component-token']).toBe('fixture-component-token');
  expect(JSON.parse(inspection.body)).toEqual({ planId: 'PP-CLEANROOM' });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/publish'))).toBe(false);
});

const atlasDocuments = import.meta.glob('../docs/architecture/maps/*.md', { query: '?raw', import: 'default', eager: true });
test('all sixteen atlas diagrams retain the exact displayed documentation text', () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline fixture'); }));
  render(<ComponentPlansWorkspace activeProject={{ kind: 'demo' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Open map atlas' }));
  const documents = Object.entries(atlasDocuments).filter(([file]) => /\/(?:0\d|1[0-5])-/.test(file)).sort(([a], [b]) => a.localeCompare(b));
  expect(documents).toHaveLength(16);
  for (const [file, source] of documents) {
    const id = `M${file.match(/\/(\d{2})-/)[1]}`;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${id}`) }));
    const diagram = source.match(/```mermaid\s*([\s\S]*?)```/)?.[1]?.trim();
    expect(diagram).toBeTruthy();
    expect(screen.getByLabelText(`${id} Mermaid source`).textContent).toBe(diagram);
  }
});
