import { open } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { aggregates, validateRange } from "./query.ts";

const json = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
export async function writeReport(db: DatabaseSync, file: string, warnings: string[], from?: string, to?: string): Promise<void> {
  validateRange(from, to);
  if (!!from !== !!to) throw new Error("请求明细必须同时指定起止日期");
  const handle = await open(file, "w", 0o600);
  try {
    await handle.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><title>模型 Token 统计</title><style>
body{font:15px system-ui,sans-serif;margin:32px auto;padding:0 20px;max-width:1200px;color:#182433;background:#f6f8fa}h1{margin-bottom:6px}p{line-height:1.6}section{background:white;padding:20px;border:1px solid #d7dfe7;border-radius:8px;margin:20px 0}label{display:inline-block;margin:8px 12px 8px 0}input,select,button{font:inherit;padding:6px;border:1px solid #aab8c5;border-radius:4px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:10px;border-bottom:1px solid #e1e6eb}th:first-child,td:first-child{text-align:left}.scroll{overflow:auto}.muted{color:#56677a}.warning{color:#8c3d00;white-space:pre-wrap}#totals{font-size:18px;font-weight:600}button{cursor:pointer;background:white}@media(max-width:600px){body{margin:16px auto;padding:0 12px}section{padding:12px}}
</style></head><body><h1>模型 Token 统计</h1><p class="muted" id="meta"></p><p class="warning" id="warnings"></p>
<section><label>模型 <select id="model"><option value="">全部模型</option></select></label><label>开始 <input type="date" id="from"></label><label>结束 <input type="date" id="to"></label><button id="reset">重置筛选</button><p id="totals"></p><div class="scroll"><table><thead><tr><th>模型</th><th>记录数</th><th>未命中输入</th><th>缓存命中</th><th>输出</th><th>命中率</th><th>估算 USD</th><th>费用未知说明</th></tr></thead><tbody id="summary"></tbody></table></div></section>
<section><h2>按日统计</h2><div class="scroll"><table><thead><tr><th>日期 / 模型</th><th>未命中输入</th><th>命中</th><th>输出</th><th>估算 USD</th></tr></thead><tbody id="daily"></tbody></table></div><button id="dailyPrev">上一页</button> <span id="dailyPage"></span> <button id="dailyNext">下一页</button></section>
<section><h2>请求明细</h2><p class="muted" id="detailInfo"></p><div class="scroll"><table><thead><tr><th>时间 / 模型</th><th>未命中输入</th><th>命中</th><th>缓存写入</th><th>输出</th><th>耗时 ms</th><th>估算 USD</th></tr></thead><tbody id="details"></tbody></table></div><button id="prev">上一页</button> <span id="page"></span> <button id="next">下一页</button></section>
<p class="muted">官方 API 标准价估算，不是实际扣款或订阅月费；DeepSeek 按官方峰值价估算，不含非高峰/节假日优惠。未知费用未计入已知金额；“≥”只标记缺项的计数。命中率按 token 加权：命中 ÷（未命中＋命中），缓存写入计入未命中；输入缺项的请求不参与比例，并标注“仅已知输入”，不是全量准确值。无输入时显示“—”。失败/取消未返回用量不当成零消耗。历史导入按导入时价格估算。快照不会自动更新；在 Pi 中重新执行 /token html。数据仅来自本机已记录用量。</p>
<script type="application/json" id="data">{"generatedAt":${json(new Date().toISOString())},"rows":${json(aggregates(db, true))},"warnings":${json(warnings)},"range":${json(from && to ? [from, to] : null)},"details":[`);
    if (from && to) {
      let separator = "";
      for (const row of db.prepare("SELECT data FROM records WHERE strftime('%Y-%m-%d',time/1000,'unixepoch','localtime') BETWEEN ? AND ? ORDER BY time,id").iterate(from, to)) {
        await handle.write(separator + json(JSON.parse(String(row.data)))); separator = ",";
      }
    }
    await handle.write(`]}</script><script>
'use strict';
const data=JSON.parse(document.getElementById('data').textContent), $=id=>document.getElementById(id), fmt=n=>n===null?'未知':Number(n).toLocaleString(), money=n=>n===null?'未知':'$'+Number(n).toFixed(6);
const tokens=n=>n===null?'未知':n>=1000000?Number((n/1000000).toFixed(1))+'百万':n>=10000?Number((n/10000).toFixed(1))+'万':fmt(n);
const count=(n,missing,requests)=>missing===requests&&n===0?'未知':(missing?'≥':'')+tokens(n);
const rate=r=>r.cacheInput+r.cacheHit===0?(r.inputUnknown||r.hitUnknown?'未知':'—'):(100*r.cacheHit/(r.cacheInput+r.cacheHit)).toFixed(1)+'%'+(r.inputUnknown||r.hitUnknown?'（仅已知输入）':'');
const keys=['requests','input','hit','output','cost','unpriced','inputUnknown','hitUnknown','outputUnknown','cacheInput','cacheHit','unreported'];
const empty=()=>Object.fromEntries(keys.map(k=>[k,0]));
const cost=r=>money(r.requests&&r.unpriced===r.requests?null:r.cost);
const unknown=r=>[r.unreported?'失败/取消未返回用量 '+fmt(r.unreported)+' 条（费用未知）':'',r.unpriced>r.unreported?fmt(r.unpriced-r.unreported)+' 条费用未知':''].filter(Boolean).join('；')||'—';
$('meta').textContent='快照生成于 '+new Date(data.generatedAt).toLocaleString()+' · 本机时区 '+Intl.DateTimeFormat().resolvedOptions().timeZone;
$('warnings').textContent=data.warnings.join('\\n');
for(const name of [...new Set(data.rows.map(r=>r.model))].sort()){const option=document.createElement('option');option.value=name;option.textContent=name;$('model').append(option);}
$('detailInfo').textContent=data.range?'包含 '+data.range.join(' 至 ')+' 的请求明细；缺失时间/耗时不猜测':'当前快照只含汇总。使用 /token html YYYY-MM-DD YYYY-MM-DD 导出该范围请求明细。';
let page=0,dailyPage=0;
const localDay=t=>{const d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
const selected=(model,day)=>(!$('model').value||model===$('model').value)&&(!$('from').value||day>=$('from').value)&&(!$('to').value||day<=$('to').value);
function fill(id,rows){const body=$(id);body.replaceChildren();for(const row of rows){const tr=document.createElement('tr');for(const text of row){const td=document.createElement('td');td.textContent=String(text);tr.append(td);}body.append(tr);}}
function render(){
 const rows=data.rows.filter(r=>selected(r.model,r.day)), groups=new Map();
 const total=empty();
 for(const r of rows){let sum=groups.get(r.model);if(!sum){sum={model:r.model,...empty()};groups.set(r.model,sum);}for(const k of keys){sum[k]+=r[k];total[k]+=r[k];}}
 const list=[...groups.values()];fill('summary',list.map(r=>[r.model,fmt(r.requests),count(r.input,r.inputUnknown,r.requests),count(r.hit,r.hitUnknown,r.requests),count(r.output,r.outputUnknown,r.requests),rate(r),cost(r),unknown(r)]));
 $('totals').textContent=total.requests?'整体命中率 '+rate(total)+' · 已知估算 '+cost(total)+(total.unpriced?' · '+unknown(total):''):'暂无数据';
 const sorted=rows.slice().reverse();const dailyPages=Math.max(1,Math.ceil(sorted.length/100));dailyPage=Math.min(dailyPage,dailyPages-1);fill('daily',sorted.slice(dailyPage*100,dailyPage*100+100).map(r=>[r.day+' / '+r.model,count(r.input,r.inputUnknown,r.requests),count(r.hit,r.hitUnknown,r.requests),count(r.output,r.outputUnknown,r.requests),cost(r)]));$('dailyPage').textContent=(dailyPage+1)+' / '+dailyPages;
 const details=data.details.filter(r=>selected(r.model,localDay(r.startedAt??r.recordedAt)));const pages=Math.max(1,Math.ceil(details.length/100));page=Math.min(page,pages-1);
 fill('details',details.slice(page*100,page*100+100).map(r=>[new Date(r.startedAt??r.recordedAt).toLocaleString()+(r.startedAt===null?'（记录时间）':'')+' / '+r.model+(r.historicalEstimate?'（历史估算）':''),r.counts.input===null||r.counts.cacheWrite===null?'未知':tokens(r.counts.input+r.counts.cacheWrite),tokens(r.counts.cacheRead),tokens(r.counts.cacheWrite),tokens(r.counts.output),fmt(r.durationMs),money(r.cost)]));$('page').textContent=(page+1)+' / '+pages;
}
for(const id of ['model','from','to'])$(id).addEventListener('change',()=>{page=0;dailyPage=0;render();});
$('reset').onclick=()=>{for(const id of ['model','from','to'])$(id).value='';page=0;dailyPage=0;render();};
$('prev').onclick=()=>{page=Math.max(0,page-1);render();};$('next').onclick=()=>{page++;render();};$('dailyPrev').onclick=()=>{dailyPage=Math.max(0,dailyPage-1);render();};$('dailyNext').onclick=()=>{dailyPage++;render();};render();
</script></body></html>`);
  } finally { await handle.close(); }
}
