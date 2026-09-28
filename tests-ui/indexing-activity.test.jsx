import React from 'react';
import {test,expect,afterEach,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,act} from '@testing-library/react';
import {IndexingActivity} from '../src/components/IndexingActivity.jsx';
afterEach(()=>{cleanup();vi.useRealTimers();});
test('three balls follow distinct branch animations',()=>{const {container}=render(<IndexingActivity/>);expect(container.querySelectorAll('.scan-ball')).toHaveLength(3);for(const branch of ['top','bottom','middle'])expect(container.querySelector('.scan-ball-'+branch)).toBeTruthy();});
test('activity has honest status and animation can be paused without canceling indexing',()=>{render(<IndexingActivity/>);expect(screen.getByRole('status').textContent).toContain('Exploring');expect(screen.getByText(/not a completion estimate/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Pause animation'}));expect(screen.getByRole('button',{name:'Resume animation'}).getAttribute('aria-pressed')).toBe('true');expect(screen.getByRole('status').textContent).toContain('Exploring');});
test('elapsed timer follows time and is cleaned up on unmount',()=>{vi.useFakeTimers();const view=render(<IndexingActivity stage="registering"/>);expect(screen.getByRole('status').textContent).toContain('Preparing');act(()=>vi.advanceTimersByTime(3000));expect(screen.getByText('3s elapsed')).toBeTruthy();view.unmount();expect(vi.getTimerCount()).toBe(0);});
