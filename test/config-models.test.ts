import { expect, it } from 'vitest';
import { parseCliModels } from '../src/config-models.ts';
it('parses backend catalogs into named selections without accepting progress or failure text',()=>{
 expect(parseCliModels('agy','Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)')).toEqual([{id:'gemini-3.8-flash-high',name:'Gemini 3.8 Flash (High)'}]);
 expect(parseCliModels('grok','Default model: grok-4.7\nAvailable models:\n  * grok-4.7 (default)')).toEqual([{id:'grok-4.7',name:'Grok 4.7'}]);
 expect(parseCliModels('opencode','You are not authenticated.')).toEqual([]);
 expect(parseCliModels('opencode','anthropic/claude-sonnet-4-6\nopenai/gpt-6-sol')).toEqual([{id:'anthropic/claude-sonnet-4-6',name:'Claude Sonnet 4 6'},{id:'openai/gpt-6-sol',name:'GPT 6 Sol'}]);
 expect(parseCliModels('codex',JSON.stringify({models:[{slug:'gpt-6-sol',display_name:'GPT-6-Sol',visibility:'list'},{slug:'internal',display_name:'Internal',visibility:'hide'}]}))).toEqual([{id:'gpt-6-sol',name:'GPT-6-Sol'}]);
});
