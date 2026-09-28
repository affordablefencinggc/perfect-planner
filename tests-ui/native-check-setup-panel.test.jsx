import React from 'react';
import {test,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NativeCheckSetupPanel} from '../src/components/NativeCheckSetupPanel.jsx';
import {createNativeCheckSetupHost} from '../src/native/checkSetupHost.js';
import {createNativeTaskResultHost} from '../src/native/taskResultHost.js';
vi.mock('../src/native/taskResultHost.js',()=>({createNativeTaskResultHost:vi.fn()}));
vi.mock('../src/native/checkSetupHost.js',()=>({createNativeCheckSetupHost:vi.fn()}));
afterEach(()=>{cleanup();vi.restoreAllMocks();localStorage.clear();});
const project={projectId:'pp_test'},snapshot={observedHead:{hostRevision:1,headDigest:'d'.repeat(64)},ledger:{tasks:[{id:'T0001',archived:false}]}};
const fixedSetup={setupReference:'c'.repeat(64),profileId:'perfect-planner-checks-v1',assignments:[{taskId:'T0001',categories:['tests','build','secrets']}]};
function host(){return {available:true,binding:{projectId:'pp_test',rootIdentity:'a'.repeat(64),censusDigest:'b'.repeat(64)},choose:vi.fn(async()=>({selectionState:'saved',setupReference:'c'.repeat(64)})),inspect:vi.fn(async()=>({setup:fixedSetup,contractHead:{revision:0,headDigest:'GENESIS'},retainedOriginal:null})),prepare:vi.fn(async()=>({contractHead:{revision:1},idempotent:false}))};}
test('saved choice requires inspection before preparation and reference survives remount',async()=>{const h=host();createNativeCheckSetupHost.mockReturnValue(h);const user=userEvent.setup();const view=render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);expect(screen.getByRole('button',{name:'Prepare check definitions'}).disabled).toBe(true);await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await screen.findByText(/Setup saved. Refresh/);expect(screen.getByRole('button',{name:'Prepare check definitions'}).disabled).toBe(true);view.unmount();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await screen.findByText(/Saved reference restored/);await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Prepare check definitions'}));await screen.findByText(/Checks prepared at revision 1/);expect(h.prepare).toHaveBeenCalledTimes(1);expect(h.prepare.mock.calls[0][0].expected).toEqual(snapshot.observedHead);});
test('pending retry sends exact native original, not current shared head',async()=>{const h=host();const pending={setupReference:'e'.repeat(64),expected:{hostRevision:7,headDigest:'f'.repeat(64)},originalRequest:{requestId:'kept',expectedRevision:2,expectedHeadDigest:'1'.repeat(64)}};h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:3},retainedOriginal:pending});createNativeCheckSetupHost.mockReturnValue(h);const user=userEvent.setup();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Retry original preparation'}));expect(h.prepare).toHaveBeenCalledWith(pending);});
test('failed inspection never enables preparation',async()=>{const h=host();h.inspect.mockRejectedValue(Error('Unavailable'));createNativeCheckSetupHost.mockReturnValue(h);const user=userEvent.setup();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Prepare check definitions'}).disabled).toBe(true);expect(h.prepare).not.toHaveBeenCalled();});
test('late selection from an earlier registration generation never enters the new view',async()=>{const h=host();let resolve;h.choose.mockImplementation(()=>new Promise(r=>resolve=r));createNativeCheckSetupHost.mockReturnValue(h);const view=render(<NativeCheckSetupPanel project={{...project,generation:1}} snapshot={snapshot}/>);await userEvent.setup().click(screen.getByRole('button',{name:'Choose npm tool…'}));view.rerender(<NativeCheckSetupPanel project={{...project,generation:2}} snapshot={snapshot}/>);await act(async()=>resolve({selectionState:'saved',setupReference:'c'.repeat(64)}));expect(screen.queryByText(/Setup saved. Refresh/)).toBeNull();expect(screen.getByRole('button',{name:'Refresh check status'}).disabled).toBe(true);});
test('cache write failure stays visible alongside successful native save',async()=>{const h=host();createNativeCheckSetupHost.mockReturnValue(h);vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await userEvent.setup().click(screen.getByRole('button',{name:'Choose npm tool…'}));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByText(/reference could not be cached/)).toBeTruthy();expect(screen.getByText(/Setup saved. Refresh/)).toBeTruthy();});

test('prepared review uses the same request on repeat and never claims execution',async()=>{
 const h=host();h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:2,headDigest:'e'.repeat(64)},retainedOriginal:null});h.review=vi.fn(async()=>({confirmation:{status:'approved'},retainedResult:false}));createNativeCheckSetupHost.mockReturnValue(h);
 const user=userEvent.setup();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 expect(screen.getByRole('button',{name:'Review prepared checks…'}).disabled).toBe(true);
 await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));
 await screen.findByText('Native review approved. No task was executed.');const original=h.review.mock.calls[0][0];expect(original.expected).toEqual(snapshot.observedHead);expect(original.contractHead.revision).toBe(2);
 await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));expect(h.review.mock.calls[1][0]).toEqual(original);
 h.review.mockRejectedValue(Error('Review outcome unknown'));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));await screen.findByRole('alert');expect(screen.queryByText('Native review approved. No task was executed.')).toBeNull();expect(screen.getByRole('button',{name:'Review prepared checks…'}).disabled).toBe(true);
});

test('reload restores the original review for recovery without launching a new dialog',async()=>{
 const h=host();h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:2,headDigest:'e'.repeat(64)},retainedOriginal:null});h.review=vi.fn(async()=>({confirmation:{status:'approved'},retainedResult:false}));h.recoverReview=vi.fn(async()=>({confirmation:{status:'approved'},recoveredSession:true}));createNativeCheckSetupHost.mockReturnValue(h);
 const user=userEvent.setup(),view=render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));const original=h.review.mock.calls[0][0];view.unmount();
 render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await user.click(screen.getByRole('button',{name:'Recover saved review'}));
 expect(h.recoverReview).toHaveBeenCalledWith(original);expect(h.review).toHaveBeenCalledTimes(1);await screen.findByText('Saved native review approved. Interrupted session recovered. No task was executed.');
});


function executionFixture(){
 const h=host(),resultHost={available:true,read:vi.fn()};let original;
 h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:2,headDigest:'e'.repeat(64)},retainedOriginal:null});
 h.review=vi.fn(async()=>({confirmation:{id:'approved-1',status:'approved'},retainedResult:false}));
 const receipt=input=>({retainedResult:false,receipt:{grantId:'11111111-1111-4111-8111-111111111111',runId:'22222222-2222-4222-8222-222222222222',intentDigest:'a'.repeat(64),artifactDigest:'b'.repeat(64)}});
 h.execute=vi.fn(async input=>{original=input;return receipt(input);});
 h.recoverExecution=vi.fn(async input=>{original=input;return {...receipt(input),retainedResult:true};});
 resultHost.read.mockImplementation(async()=>({...receipt(original).receipt,taskId:original.taskId,checkId:original.checkId,attemptId:original.attemptId,attemptNumber:original.attemptNumber,state:'failure-observed',exitCode:7,failureReasons:['nonzero-exit']}));
 createNativeCheckSetupHost.mockReturnValue(h);createNativeTaskResultHost.mockReturnValue(resultHost);return {h,resultHost};
}
async function approve(user){await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));}

test('explicit run requires approval, shows failure and recovers exact request after reload',async()=>{
 const {h}=executionFixture(),user=userEvent.setup(),view=render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);await approve(user);expect(h.execute).not.toHaveBeenCalled();
 await user.selectOptions(screen.getByLabelText('Check type'),'pp-build');await user.click(screen.getByRole('button',{name:'Run selected check'}));await screen.findByText('Check failed');
 const original=h.execute.mock.calls[0][0];expect(original).toMatchObject({taskId:'T0001',checkId:'pp-build',confirmationId:'approved-1',attemptNumber:1});expect(screen.getByText(/Observed exit: 7/)).toBeTruthy();
 view.unmount();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);expect(screen.queryByText('Check failed')).toBeNull();
 await user.click(screen.getByRole('button',{name:'Recover saved check'}));await screen.findByText('Check failed');expect(h.recoverExecution).toHaveBeenCalledWith(original);expect(h.execute).toHaveBeenCalledTimes(1);
});

test('lost execution reply prevents replacement and never retains a stale successful outcome',async()=>{
 const {h}=executionFixture(),user=userEvent.setup();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await approve(user);await user.click(screen.getByRole('button',{name:'Run selected check'}));await screen.findByText('Check failed');
 h.execute.mockRejectedValue(Error('Execution outcome unknown'));await user.click(screen.getByRole('button',{name:'Run a new check attempt'}));await screen.findByRole('alert');
 expect(h.execute.mock.calls[1][0].attemptNumber).toBe(2);expect(h.execute.mock.calls[1][0].requestId).not.toBe(h.execute.mock.calls[0][0].requestId);expect(screen.queryByLabelText('Selected check result')).toBeNull();expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);expect(screen.getByRole('button',{name:'Prepare check definitions'}).disabled).toBe(true);
});

test('request reference must be saved before execution is invoked',async()=>{
 const {h}=executionFixture(),user=userEvent.setup();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await approve(user);
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});await user.click(screen.getByRole('button',{name:'Run selected check'}));await screen.findByText(/Request reference could not be saved/);expect(h.execute).not.toHaveBeenCalled();
});

test('result identity mismatch blocks a new check and preserves its original',async()=>{
 const {resultHost}=executionFixture(),user=userEvent.setup();resultHost.read.mockResolvedValue({runId:'foreign'});render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await approve(user);await user.click(screen.getByRole('button',{name:'Run selected check'}));await screen.findByText(/Result does not match/);expect(screen.queryByLabelText('Selected check result')).toBeNull();expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);expect(screen.getByRole('button',{name:'Recover saved check'}).disabled).toBe(false);
});

test('late execution reply cannot paint a new project generation and repeat click stays single',async()=>{
 const {h}=executionFixture(),user=userEvent.setup();let finish;h.execute.mockImplementation(()=>new Promise(r=>finish=r));const view=render(<NativeCheckSetupPanel project={{...project,generation:1}} snapshot={snapshot}/>);await approve(user);await user.dblClick(screen.getByRole('button',{name:'Run selected check'}));expect(h.execute).toHaveBeenCalledTimes(1);view.rerender(<NativeCheckSetupPanel project={{...project,generation:2}} snapshot={snapshot}/>);await act(async()=>finish({receipt:{grantId:'foreign'}}));expect(screen.queryByLabelText('Selected check result')).toBeNull();expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);
});

test('repository selection prepares only selected scripts and reopening reads native assignments',async()=>{
 const {h}=executionFixture(),user=userEvent.setup();
 const setup={...fixedSetup,profileId:'npm-project-checks-v1',assignments:[{taskId:'T0001',categories:['build']}]};
 h.inspect.mockResolvedValue({setup,contractHead:{revision:2,headDigest:'e'.repeat(64)},retainedOriginal:null});
 const view=render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 await user.selectOptions(screen.getByLabelText('Repository profile'),'npm-project-checks-v1');
 expect(screen.getByLabelText('Prepare tests').checked).toBe(true);expect(screen.getByLabelText('Prepare secret check').checked).toBe(false);
 await user.click(screen.getByLabelText('Prepare tests'));expect(screen.getByRole('button',{name:'Choose npm tool…'}).disabled).toBe(true);
 await user.click(screen.getByLabelText('Prepare build'));await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));
 expect(h.choose).toHaveBeenCalledWith([{taskId:'T0001',categories:['build']}],'npm-project-checks-v1');
 view.unmount();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 expect(screen.getByLabelText('Check type').disabled).toBe(true);
 await user.click(screen.getByRole('button',{name:'Refresh check status'}));
 expect(screen.getByLabelText('Verified check setup').textContent).toContain('Repository npm scripts');
 expect([...screen.getByLabelText('Check type').options].map(o=>o.value)).toEqual(['npm-build']);
 // Changing new-setup preferences must never rewrite the restored executable selection.
 await user.selectOptions(screen.getByLabelText('Repository profile'),'npm-project-checks-v1');
 await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));await user.click(screen.getByRole('button',{name:'Run selected check'}));
 await screen.findByText('Check failed');expect(h.execute.mock.calls[0][0].checkId).toBe('npm-build');
});

test.each(['review','recoverReview'])('settled %s refusal permits changed heads only after refresh and explicit review',async(method)=>{
 const h=host();h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:2,headDigest:'e'.repeat(64)},retainedOriginal:null});
 const failure=Object.assign(Error('Review did not start. Refresh check status.'),{code:'NATIVE_CHECK_REVIEW_NOT_STARTED',requiresRecovery:false,requestMayHaveCommitted:false});
 h.review=vi.fn().mockRejectedValue(failure);h.recoverReview=vi.fn().mockRejectedValue(failure);createNativeCheckSetupHost.mockReturnValue(h);
 const user=userEvent.setup(),view=render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));
 const original=h.review.mock.calls[0][0];
 if(method==='recoverReview'){view.unmount();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await user.click(screen.getByRole('button',{name:'Recover saved review'}));expect(h.recoverReview).toHaveBeenCalledWith(original);}
 expect(screen.getByRole('button',{name:'Review prepared checks…'}).disabled).toBe(true);
 expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);
 h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:3,headDigest:'f'.repeat(64)},retainedOriginal:null});
 await user.click(screen.getByRole('button',{name:'Refresh check status'}));expect(h.review).toHaveBeenCalledTimes(1);
 h.review.mockResolvedValue({confirmation:{status:'cancelled'},retainedResult:false});
 await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));
 expect(h.review).toHaveBeenCalledTimes(2);expect(h.review.mock.calls[1][0].contractHead.revision).toBe(3);expect(h.review.mock.calls[1][0].requestId).not.toBe(original.requestId);
 await screen.findByText('Native review cancelled. No task was executed.');expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);
});

test.each([
 {code:'NATIVE_CHECK_REVIEW_NOT_STARTED',requiresRecovery:true,requestMayHaveCommitted:false},
 {code:'NATIVE_CHECK_REVIEW_NOT_STARTED',requiresRecovery:false,requestMayHaveCommitted:true},
 {code:'NATIVE_DRAFT_SESSION_UNRESOLVED',requiresRecovery:false,requestMayHaveCommitted:false},
])('uncertain recovery does not reuse earlier completion: %j',async(flags)=>{
 const h=host();h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:2,headDigest:'e'.repeat(64)},retainedOriginal:null});
 h.review=vi.fn(async()=>({confirmation:{status:'cancelled'},retainedResult:false}));h.recoverReview=vi.fn(async()=>{throw Object.assign(Error('Uncertain recovery'),flags);});createNativeCheckSetupHost.mockReturnValue(h);
 const user=userEvent.setup();render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);
 await user.click(screen.getByRole('button',{name:'Choose npm tool…'}));await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));
 const original=h.review.mock.calls[0][0];await user.click(screen.getByRole('button',{name:'Recover saved review'}));
 h.inspect.mockResolvedValue({setup:fixedSetup,contractHead:{revision:3,headDigest:'f'.repeat(64)},retainedOriginal:null});await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));
 await screen.findByText(/Recover the saved review before starting a different review/);expect(h.review).toHaveBeenCalledTimes(1);expect(h.recoverReview).toHaveBeenCalledWith(original);
 expect(screen.getByRole('button',{name:'Run selected check'}).disabled).toBe(true);
});

test('proven not-started recovery shows no result and permits a separate approved attempt',async()=>{
 const {h,resultHost}=executionFixture(),user=userEvent.setup();h.execute.mockRejectedValueOnce(Error('Enrollment capacity reached'));
 h.recoverExecution.mockResolvedValue({retainedResult:true,receipt:{kind:'NATIVE_CHECK_NOT_STARTED_RECEIPT',state:'not-started',proofDigest:'a'.repeat(64)}});
 render(<NativeCheckSetupPanel project={project} snapshot={snapshot}/>);await approve(user);await user.click(screen.getByRole('button',{name:'Run selected check'}));await screen.findByRole('alert');
 const original=h.execute.mock.calls[0][0];await user.click(screen.getByRole('button',{name:'Recover saved check'}));await screen.findByText(/The saved check did not start/);
 expect(resultHost.read).not.toHaveBeenCalled();expect(h.execute).toHaveBeenCalledTimes(1);expect(h.recoverExecution).toHaveBeenCalledWith(original);expect(screen.queryByLabelText('Selected check result')).toBeNull();
 await user.click(screen.getByRole('button',{name:'Refresh check status'}));await user.click(screen.getByRole('button',{name:'Review prepared checks…'}));await user.click(screen.getByRole('button',{name:'Run selected check'}));await screen.findByText('Check failed');
 expect(h.execute).toHaveBeenCalledTimes(2);expect(h.execute.mock.calls[1][0].attemptNumber).toBe(2);expect(h.execute.mock.calls[1][0].requestId).not.toBe(original.requestId);
});
