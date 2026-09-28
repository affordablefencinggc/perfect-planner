import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

assert.equal(os.hostname().toLowerCase(), 'dans1', 'Browser qualification runs on DANS1');
const {chromium} = await import(pathToFileURL('C:/Users/danie/Documents/perfect-planner-tests/pp-20260905-remote-01/tools/browser/node_modules/playwright/index.mjs'));
const output = path.resolve(process.argv[2] ?? '../onboarding-browser');
await mkdir(output, {recursive:true});
const report = {host:os.hostname(), startedAt:new Date().toISOString(), scope:'Headless browser onboarding; no native consent, IDE pairing or code execution', steps:[], pageErrors:[], verdict:'RUNNING', cleanup:false};
let browser;
try {
  browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true});
  for (const [label, port] of [['before',4187],['after',4186]]) {
    const context = await browser.newContext({viewport:{width:1440,height:1080}});
    const page = await context.newPage();
    page.on('pageerror',error=>report.pageErrors.push({label,message:error.message}));
    await page.goto(`http://127.0.0.1:${port}/`, {waitUntil:'networkidle'});
    await page.getByRole('button',{name:'More actions',exact:true}).click();
    await page.getByRole('button',{name:/Runtime & connections/}).click();
    const panel = page.getByRole('region',{name:'Agent session observations',exact:true});
    await panel.waitFor();
    assert.equal(await panel.getByRole('button',{name:'Connect an IDE agent',exact:true}).isDisabled(),true);
    report.steps.push({label,check:'Pairing remains disabled without a registered project',pass:true});
    if(label==='before') {
      assert.equal(await panel.getByRole('button',{name:'Choose an app folder',exact:true}).count(),0);
      assert.match(await panel.innerText(),/Connection status is still available/);
      report.steps.push({label,check:'Original missing-project dead end and misleading availability reproduced',pass:true});
    } else {
      assert.match(await panel.innerText(),/Choose an app folder before connecting an agent/);
      assert.doesNotMatch(await panel.innerText(),/Connection status is still available/);
      report.steps.push({label,check:'Actionable prerequisite shown without claiming access',pass:true});
    }
    await panel.screenshot({path:path.join(output,`${label}-connection-panel.png`)});
    if(label==='after') {
      await panel.getByRole('button',{name:'Choose an app folder',exact:true}).click();
      await page.waitForURL(url=>url.searchParams.get('workspace')==='structure');
      await page.getByRole('button',{name:'Choose app folder',exact:true}).waitFor();
      assert.equal(await page.getByRole('region',{name:'Runtime and connections',exact:true}).count(),0);
      assert.equal(await page.getByRole('textbox',{name:'IDE MCP configuration'}).count(),0);
      report.steps.push({label,check:'Setup action closes menu and reaches real folder selection without pairing',pass:true});
      await page.screenshot({path:path.join(output,'after-project-setup.png'),fullPage:true});
      await page.reload({waitUntil:'networkidle'});
      assert.equal(new URL(page.url()).searchParams.get('workspace'),'structure');
      await page.getByRole('button',{name:'Choose app folder',exact:true}).waitFor();
      report.steps.push({label,check:'Setup route survives page reload',pass:true});
    }
    await context.close();
  }
  assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));
  report.verdict='PASS';
} catch(error) {
  report.verdict='FAIL';
  report.error=error.stack;
  process.exitCode=1;
} finally {
  if(browser){await browser.close();report.cleanup=true;}
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
