import { expect, it } from 'vitest';
import { parseCliModels } from '../src/config-models.ts';
it('parses backend catalogs into named selections without accepting progress or failure text',()=>{
 expect(parseCliModels('agy','Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)')).toEqual([{id:'gemini-3.8-flash-high',name:'Gemini 3.8 Flash (High)'}]);
 expect(parseCliModels('codex',JSON.stringify({models:[{slug:'gpt-6-sol',display_name:'GPT-6-Sol',visibility:'list'},{slug:'internal',display_name:'Internal',visibility:'hide'}]}))).toEqual([{id:'gpt-6-sol',name:'GPT-6-Sol'}]);
});
