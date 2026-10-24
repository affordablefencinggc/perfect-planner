import React from 'react';
import {afterEach,expect,test} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {SettingsWorkspace} from '../src/settings/SettingsWorkspace.jsx';
afterEach(cleanup);
test('Settings says uninstall keeps data, where it lives on each OS, and how to remove it',()=>{
 render(<SettingsWorkspace onWorkspace={()=>{}} onClose={()=>{}} invoke={async()=>({stored:false})} jevStatusOverride={{stored:false}}/>);
 expect(screen.getByRole('heading',{name:'Your data'})).toBeTruthy();
 expect(screen.getByText(/Uninstalling Perfect Planner keeps your plans/)).toBeTruthy();
 for(const where of [/LOCALAPPDATA%\\com\.perfectplanner\.desktop/,/Library\/Application Support\/com\.perfectplanner\.desktop/,/\.local\/share\/com\.perfectplanner\.desktop/])expect(screen.getByText(where)).toBeTruthy();
 expect(screen.getByText(/delete that folder/)).toBeTruthy();
});
