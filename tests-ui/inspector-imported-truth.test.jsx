import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { InspectorDrawer } from '../src/PerfectPlannerShell.jsx';
afterEach(cleanup);
test('imported category never inherits demo work or fake proof gates', () => {
  const selected={id:'A03',title:'Application layers',status:'active',estimate:'3 metadata receipts',items:['Finding receipts: S020, S021, S023','Review question: Where are boundaries?']};
  const {container}=render(<InspectorDrawer open onClose={vi.fn()} selected={selected}/>);
  expect(screen.getByRole('dialog',{name:'Project evidence inspector'})).toBeTruthy();
  expect(container.textContent).toContain('Finding receipts: S020, S021, S023');
  for(const invented of ['Danie','pp/pp-014','src/sync/plan.ts','plan-registry:v2','NO-GO','Screenshot required','Wave 4','0/4']) expect(container.textContent).not.toContain(invented);
  expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
});
test('demo-only inspector retains explicit demo presentation', () => {
  render(<InspectorDrawer open demoMode onClose={vi.fn()} selected={{id:'B04',title:'Demo work'}}/>);
  expect(screen.getByRole('dialog',{name:'Work item inspector'})).toBeTruthy();
});
