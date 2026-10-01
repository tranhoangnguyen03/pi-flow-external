import { expect, it, vi } from 'vitest';
import { ConfigModal, withConfigModal } from '../src/config-modal.ts';
import { visibleWidth } from '@earendil-works/pi-tui';

const theme={fg:(_name:string,s:string)=>s};
function fixture(rows=24){const tui={terminal:{rows},requestRender:vi.fn()};return {tui,modal:new ConfigModal(tui as never,theme as never)};}
it('keeps focus on prompts and cancels pending edits without submitting them',async()=>{
 const {modal}=fixture();const value=modal.input('Name');modal.handleInput('x');modal.render(40);modal.handleInput('\u001b');expect(await value).toBeUndefined();
 const editor=modal.editor('Instructions','Existing');modal.render(40);modal.handleInput('\u001b');expect(await editor).toBeUndefined();
 const pending=modal.select('Menu',['One','Two']);modal.dispose();expect(await pending).toBeUndefined();
});
it('renders resized menus within the viewport and remembers the selected row on return',async()=>{
 const {modal,tui}=fixture(14);const choices=Array.from({length:20},(_,i)=>`Choice ${i} 界`);
 const first=modal.select('Menu',choices);modal.render(40);modal.handleInput('\u001b[B');modal.handleInput('\r');expect(await first).toBe(choices[1]);
 const next=modal.select('Menu',choices);tui.terminal.rows=10;const lines=modal.render(22);expect(lines.length).toBeLessThanOrEqual(8);expect(lines.every(s=>visibleWidth(s)<=22)).toBe(true);
 modal.handleInput('\r');expect(await next).toBe(choices[1]);
});
it('searches model names and selects the current value initially',async()=>{
 const {modal}=fixture();const pending=modal.select('Models\nCurrent: Claude Opus',['Claude Sonnet · sonnet','Claude Opus · opus · Current']);modal.render(60);modal.handleInput('\r');expect(await pending).toBe('Claude Opus · opus · Current');
 const filtered=modal.select('Models',['Claude Sonnet · sonnet','Claude Opus · opus']);modal.render(60);modal.handleInput('/');modal.handleInput('s');modal.handleInput('o');modal.handleInput('n');modal.handleInput('\r');expect(await filtered).toBe('Claude Sonnet · sonnet');
});
it('defaults confirmations to cancel and allows reading beyond the first preview page',async()=>{
 const {modal}=fixture(12);const preview=Array.from({length:40},(_,i)=>`Line ${i}`).join('\n');
 const cancelled=modal.confirm('Remove?',preview);modal.render(40);modal.handleInput('\r');expect(await cancelled).toBe(false);
 const confirmed=modal.confirm('Remove?',preview);modal.render(40);modal.handleInput('\u001b[6~');expect(modal.render(40).join('\n')).toContain('Line 8');modal.handleInput('\u001b[B');modal.handleInput('\r');expect(await confirmed).toBe(true);
 const again=modal.confirm('Remove?',preview);modal.render(40);modal.handleInput('\r');expect(await again).toBe(false);
});
it('cancels a busy request and keeps its abort signal owned by the modal',async()=>{
 const {modal}=fixture();let signal:AbortSignal|undefined;
 const pending=modal.busy('Testing',async s=>{signal=s;await new Promise<void>(resolve=>s.addEventListener('abort',()=>resolve(),{once:true}));return 'cancelled';});
 modal.handleInput('\u001b');expect(signal?.aborted).toBe(true);expect(await pending).toBe('cancelled');
});
it('uses one overlay for the full interaction and never uses a custom terminal component in RPC',async()=>{
 const {tui}=fixture();let component:any;let completed:()=>void=()=>{};let config:any;
 const ctx={mode:'tui',ui:{custom:async(factory:any,opts:any)=>{config=opts;return new Promise<void>(resolve=>{completed=resolve;component=factory(tui,theme,{matches:()=>false},resolve);});},notify:vi.fn()}};
 const flow=withConfigModal(ctx as never,async c=>{await c.ui.select('Menu',['Close']);});
 expect(config.overlay).toBe(true);component.render(40);component.handleInput('\r');await flow;
 expect(completed).toBeTypeOf('function');
 const custom=vi.fn();const select=vi.fn(async()=>undefined);await withConfigModal({mode:'rpc',ui:{custom,select}} as never,async(c)=>{await c.ui.select('Menu',['Close']);});expect(custom).not.toHaveBeenCalled();expect(select).toHaveBeenCalledOnce();
});
