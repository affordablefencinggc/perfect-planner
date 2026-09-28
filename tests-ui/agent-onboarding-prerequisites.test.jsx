import React from 'react';
import {afterEach, expect, test, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {AgentSessionsPanel} from '../src/components/AgentSessionsPanel.jsx';

const registered = {
  projectId: 'pp_onboarding', generation: 1, state: 'ready',
  registration: {adapter: 'native', workspaceId: 'onboarding', registryRevision: 1, rootIdentity: 'a'.repeat(64)},
};
afterEach(() => {cleanup(); delete window.__TAURI_INTERNALS__;});

test('missing project routes to setup without requesting native consent or claiming access', async () => {
  window.__TAURI_INTERNALS__ = {};
  const invoke = vi.fn(), onOpenProjectSetup = vi.fn();
  render(<AgentSessionsPanel invoke={invoke} onOpenProjectSetup={onOpenProjectSetup}/>);
  expect(screen.getByRole('button', {name: 'Connect an IDE agent'}).disabled).toBe(true);
  expect(screen.queryByText(/Connection status is still available/)).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', {name: 'Choose an app folder'}));
  expect(onOpenProjectSetup).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox', {name: 'IDE MCP configuration'})).toBeNull();
});

test.each(['stale', 'unavailable'])('a %s registration offers recovery without enabling pairing', async (state) => {
  window.__TAURI_INTERNALS__ = {};
  const invoke = vi.fn(), onOpenProjectSetup = vi.fn();
  render(<AgentSessionsPanel project={{...registered, state}} invoke={invoke} onOpenProjectSetup={onOpenProjectSetup}/>);
  expect(screen.getByRole('button', {name: 'Connect an IDE agent'}).disabled).toBe(true);
  await userEvent.setup().click(screen.getByRole('button', {name: 'Open app setup'}));
  expect(onOpenProjectSetup).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
});

test('browser project clearly requires the desktop app and cannot invoke pairing', async () => {
  const invoke = vi.fn();
  render(<AgentSessionsPanel project={registered} invoke={invoke} onOpenProjectSetup={vi.fn()}/>);
  expect(screen.getByText('Open this project in the desktop app to connect an IDE agent.')).toBeTruthy();
  const connect = screen.getByRole('button', {name: 'Connect an IDE agent'});
  await userEvent.setup().click(connect);
  expect(connect.disabled).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', {name: 'Open app setup'})).toBeNull();
});

test('restored native registration enables only connection status until a census exists', () => {
  window.__TAURI_INTERNALS__ = {};
  const view = render(<AgentSessionsPanel project={{...registered, state:'stale'}} onOpenProjectSetup={vi.fn()}/>);
  view.rerender(<AgentSessionsPanel project={registered} onOpenProjectSetup={vi.fn()}/>);
  expect(screen.queryByRole('button', {name:'Open app setup'})).toBeNull();
  expect(screen.getByRole('button', {name:'Connect an IDE agent'}).disabled).toBe(false);
  expect(screen.getByRole('radio', {name:'Read my submitted plan'}).disabled).toBe(true);
  expect(screen.getByRole('radio', {name:'Read, propose tasks and report exchanges'}).disabled).toBe(true);
});
