import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExtensionCommandContext, Theme } from '@earendil-works/pi-coding-agent';
import { Editor, Input, SelectList, Text, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';

/** One overlay owns every prompt; async lifecycle helpers use its ordinary dialog methods. */
export class ConfigModal implements Component {
  private control?: SelectList | Input | Editor;
  private resolve?: (value: string | undefined) => void;
  private title = 'External agents';
  private summary = '';
  private help = '';
  private choices: string[] = [];
  private filter?: Input;
  private text = '';
  private scroll = 0;
  private rows = 0;
  private message = '';
  private disposed = false;
  private positions = new Map<string, number>();
  private remember = false;
  private cancelBusy?: () => void;
  focused = true;
  constructor(private tui: TUI, private theme: Theme, private cancelled: (data:string)=>boolean = data=>matchesKey(data,Key.escape), private externalEditorKey:(data:string)=>boolean = ()=>false) {}
  private listTheme() {
    return { selectedPrefix: (s:string)=>this.theme.fg('accent',s), selectedText: (s:string)=>this.theme.fg('accent',s), description:(s:string)=>this.theme.fg('muted',s),scrollInfo:(s:string)=>this.theme.fg('dim',s),noMatch:(s:string)=>this.theme.fg('warning',s) };
  }
  private settle(value?: string) {
    const resolve = this.resolve; this.resolve = undefined;
    if (this.remember && this.control instanceof SelectList) this.positions.set(this.title, Math.max(0,this.choices.indexOf(this.control.getSelectedItem()?.value ?? '')));
    this.control = undefined; this.text = ''; this.message = ''; this.help = 'Working…';
    resolve?.(value); this.tui.requestRender();
  }
  private prompt(title:string, help:string, setup:()=>void):Promise<string|undefined> {
    if(this.disposed) return Promise.resolve(undefined);
    if(this.resolve) throw new Error('Configuration dialog already active');
    const [heading,...summary]=title.split('\n');this.title=heading!;this.summary=summary.join('\n');this.help=help;this.scroll=0;this.text='';this.choices=[];this.rows=0;this.filter=undefined;
    return new Promise(resolve=>{this.resolve=resolve;setup();this.tui.requestRender();});
  }
  private makeList(rows:number) {
    const selected=this.control instanceof SelectList ? this.choices.indexOf(this.control.getSelectedItem()?.value ?? '') : this.positions.get(this.title) ?? Math.max(0,this.choices.findIndex(s=>s.endsWith(' · Current')));
    const search=this.filter?.getValue().toLowerCase()??'';
    const filtered=this.choices.filter(value=>value.toLowerCase().includes(search));
    const list=new SelectList(filtered.map(value=>({value,label:value})),Math.max(1,rows),this.listTheme());
    list.setSelectedIndex(Math.max(0,filtered.indexOf(this.choices[selected]??'')));
    list.onSelect=item=>this.settle(item.value); list.onCancel=()=>this.settle();this.control=list;this.rows=rows;
  }
  select=(title:string,choices:string[])=>{this.remember=true;return this.prompt(title,'↑↓ Navigate · Enter Select · / Search · Esc Back',()=>{this.choices=choices;this.makeList(10);});};
  input=(title:string,placeholder?:string)=>this.prompt(title,'Enter Save · Esc Cancel',()=>{const input=new Input();input.onSubmit=value=>this.settle(value);input.onEscape=()=>this.settle();this.control=input;if(placeholder)this.message=placeholder;});
  editor=(title:string,prefill?:string)=>this.prompt(title,'Enter Save · Shift+Enter New line · Ctrl+G External editor · Esc Cancel',()=>{const editor=new Editor(this.tui,{borderColor:s=>this.theme.fg('border',s),selectList:this.listTheme()});editor.setText(prefill??'');editor.onSubmit=text=>this.settle(text);this.control=editor;});
  confirm=async(title:string,text:string)=>{
    this.remember=false;this.positions.delete(title);
    const value=await this.prompt(title,'↑↓ Choose · PgUp/PgDn Read preview · Enter Select · Esc Cancel',()=>{this.text=text;this.choices=['Cancel','Confirm'];this.makeList(2);});
    return value==='Confirm';
  };
  show=async(title:string,text:string)=>{await this.prompt(title,'↑↓ / PgUp/PgDn Scroll · Enter or Esc Back',()=>{this.text=text;});};
  notify=(text:string,type?:string)=>{this.message=`${type==='error'||type==='warning'?'Attention: ':''}${text}`;this.tui.requestRender();};
  async busy<T>(title:string, action:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    const controller=new AbortController();this.title=title;this.help='Esc Cancel test';this.control=undefined;this.text='';this.message='';
    this.cancelBusy=()=>{controller.abort(new Error('Cancelled from configuration window'));this.message='Cancelling…';this.tui.requestRender();};
    this.tui.requestRender();
    try{return await action(controller.signal);}finally{this.cancelBusy=undefined;this.help='';}
  }
  handleInput(data:string) {
    if(this.cancelBusy&&!this.resolve){if(this.cancelled(data)||matchesKey(data,Key.ctrl('c')))this.cancelBusy();return;}
    if(!this.resolve)return;
    if(this.control instanceof SelectList&&this.remember){
      if(data==='/'&&!this.filter){this.filter=new Input();this.filter.focused=this.focused;this.tui.requestRender();return;}
      if(this.filter){
        if(this.cancelled(data)){this.filter=undefined;this.makeList(this.rows);this.tui.requestRender();return;}
        if(!matchesKey(data,Key.up)&&!matchesKey(data,Key.down)&&!matchesKey(data,Key.enter)){
          this.filter.handleInput(data);this.makeList(this.rows);this.tui.requestRender();return;
        }
      }
    }
    if(this.control instanceof Editor&&this.externalEditorKey(data)) {
      const command=process.env.VISUAL||process.env.EDITOR;
      if(!command){this.notify('Set VISUAL or EDITOR to open an external editor.','warning');return;}
      const directory=mkdtempSync(join(tmpdir(),'pi-config-edit-'));const file=join(directory,'instructions.txt');
      try {
        writeFileSync(file,this.control.getExpandedText(),{mode:0o600});
        this.tui.stop();
        try {
          const result=spawnSync('/bin/sh',['-c',`${command} "$1"`,'pi-config-editor',file],{stdio:'inherit'});
          if(result.status===0)this.control.setText(readFileSync(file,'utf8'));
          else this.notify('External editor failed; the previous draft was kept.','warning');
        }finally{this.tui.start();}
      }catch(error){this.notify(String(error),'error');}
      finally{rmSync(directory,{recursive:true,force:true});this.tui.requestRender();}
      return;
    }
    if(this.cancelled(data)||(!(this.control instanceof Editor)&&matchesKey(data,Key.ctrl('c')))){this.settle();return;}
    if(this.text&&(matchesKey(data,Key.pageUp)||matchesKey(data,Key.pageDown)||(!this.control&&(matchesKey(data,Key.up)||matchesKey(data,Key.down))))) {
      const delta=matchesKey(data,Key.pageUp)?-8:matchesKey(data,Key.pageDown)?8:matchesKey(data,Key.up)?-1:1;
      this.scroll=Math.max(0,this.scroll+delta);this.tui.requestRender();return;
    }
    if(!this.control&&matchesKey(data,Key.enter)){this.settle();return;}
    this.control?.handleInput(data);this.tui.requestRender();
  }
  render(width:number):string[] {
    if(width<4)return [truncateToWidth('External',width)];
    const inner=width-4;const height=Math.max(4,this.tui.terminal.rows-2);
    const footer=this.theme.fg('dim',truncateToWidth(this.help,inner));
    const summary=this.summary?new Text(this.theme.fg('muted',this.summary),0,0).render(inner).slice(0,Math.max(1,Math.floor(height/4))):[];
    const message=this.message?new Text(this.theme.fg('muted',this.message),0,0).render(inner).slice(0,2):[];
    const available=Math.max(1,height-3-message.length-summary.length-(this.filter?1:0));
    let lines:string[]=[];
    if(this.text){
      const content=new Text(this.text,0,0).render(inner);
      const size=Math.max(0,available-(this.control?3:1));this.scroll=Math.min(this.scroll,Math.max(0,content.length-size));
      lines=content.slice(this.scroll,this.scroll+size);
      if(size>0)lines.push(this.theme.fg('dim',`${this.scroll+1}–${Math.min(content.length,this.scroll+size)} of ${content.length} lines · PgUp/PgDn`));
    }
    if(this.control instanceof SelectList){const rows=Math.max(1,available-lines.length-1);if(rows!==this.rows)this.makeList(rows);}
    if(this.control instanceof Input||this.control instanceof Editor)this.control.focused=this.focused;
    if(this.filter)this.filter.focused=this.focused;
    lines.push(...this.control?.render(inner)??[]);
    lines=lines.slice(0,available);
    const top=truncateToWidth(` ${this.title} `,width-2);
    const border=(s:string)=>this.theme.fg('border',s);
    return [border('╭')+this.theme.fg('accent',top)+border('─'.repeat(Math.max(0,width-2-visibleWidth(top)))+'╮'),...(this.filter?this.filter.render(inner).map(s=>border('│ ')+truncateToWidth(s,inner,'…',true)+border(' │')):[]),...summary.map(s=>border('│ ')+truncateToWidth(s,inner,'…',true)+border(' │')),...lines.map(s=>border('│ ')+truncateToWidth(s,inner,'…',true)+border(' │')),...message.map(s=>border('│ ')+truncateToWidth(s,inner,'…',true)+border(' │')),border('│ ')+truncateToWidth(footer,inner,'…',true)+border(' │'),border('╰'+'─'.repeat(width-2)+'╯')];
  }
  invalidate(){this.control?.invalidate();}
  dispose(){this.disposed=true;this.cancelBusy?.();this.settle();}
}

export async function withConfigModal(ctx:ExtensionCommandContext,run:(ctx:ExtensionCommandContext,show:(title:string,text:string)=>Promise<void>,busy:<T>(title:string,action:(signal:AbortSignal)=>Promise<T>)=>Promise<T>)=>Promise<void>) {
  if(ctx.mode!=='tui') {
    await run(ctx,async(title,text)=>{await ctx.ui.select(`${title}\n\n${text}`,['Back']);},async(_title,action)=>action(new AbortController().signal));return;
  }
  await ctx.ui.custom<void>((tui,theme,keys,done)=>{
    const modal=new ConfigModal(tui,theme,data=>keys.matches(data,'tui.select.cancel'),data=>keys.matches(data,'app.editor.external'));
    const ui=Object.create(ctx.ui,Object.getOwnPropertyDescriptors({select:modal.select,input:modal.input,editor:modal.editor,confirm:modal.confirm,notify:modal.notify}));
    const modalCtx=Object.create(ctx,{ui:{value:ui,enumerable:true}});
    void run(modalCtx,modal.show,(title,action)=>modal.busy(title,action)).catch(error=>ctx.ui.notify(`Configuration window failed: ${String(error)}`,'error')).finally(()=>done());
    return modal;
  },{overlay:true,overlayOptions:{anchor:'center',width:'90%',maxHeight:'100%',margin:1}});
}
