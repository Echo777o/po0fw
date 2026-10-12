// 运行：node egern-custom/tests/po0-firewall-whitelist.test.mjs
// 全部 HTTP 请求均为模拟，不连接真实加白接口。
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const source = readFileSync(new URL("../po0-firewall-whitelist.js", import.meta.url), "utf8");
const run = (await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"))).default;
const A="203.0.113.0/24",B="198.51.100.0/24",C="192.0.2.0/24";
const token="pgnfw_UNIT_TEST_ONLY";
const snapshot=(ips,currentIp=A,extra={})=>({
  enabled:true,currentIp,limit:5,
  whitelist:ips.map(ip=>typeof ip==="string"?{ip,slot:null}:ip),...extra
});
const get=(body,extra={})=>({method:"get",body,...extra});
const post=(body,extra={})=>({method:"post",body,...extra});
async function invoke(replies,{storage=new Map(),tokens=token,device={wifi:{ssid:"test"}},setJSONError=""}={}){
  const queue=replies.slice(),notifications=[],calls=[];
  async function request(method,url,options){
    const parsed=new URL(url);
    const actualToken=parsed.hostname==="console.po0.io"
      ?parsed.searchParams.get("token"):decodeURIComponent(parsed.pathname.split("/")[3]);
    const at=queue.findIndex(r=>!r.token||r.token===actualToken);
    assert.ok(at>=0,"Unexpected HTTP request: "+method);
    const reply=queue.splice(at,1)[0];
    assert.equal(method,reply.method);
    if(reply.path)assert.ok(url.endsWith(reply.path),"Incorrect request path");
    calls.push({method,url,options,token:actualToken});
    if(reply.delay)await new Promise(resolve=>setTimeout(resolve,reply.delay));
    if(reply.throw)throw new Error(reply.throw);
    return {status:reply.status??200,text:async()=>{
      if(reply.textThrows)throw new Error(reply.textThrows);
      return typeof reply.body==="string"?reply.body:JSON.stringify(reply.body);
    }};
  }
  const ctx={
    env:{tokens},device,
    storage:{
      get:k=>storage.get(k)??null,set:(k,v)=>storage.set(k,v),
      getJSON:k=>storage.has(k)?JSON.parse(storage.get(k)):null,
      setJSON:(k,v)=>{if(setJSONError)throw new Error(setJSONError);storage.set(k,JSON.stringify(v));}
    },
    http:{get:(u,o)=>request("get",u,o),post:(u,o)=>request("post",u,o)},
    notify:n=>notifications.push(n)
  };
  await run(ctx);
  assert.equal(queue.length,0,"Not all HTTP fixtures consumed");
  return {notifications,calls,storage};
}
const passed=[];
async function test(name,fn){await fn();passed.push(name);}
function expectNotice(r,count=1){assert.equal(r.notifications.length,count);}
function expectFailure(r,detail){
  expectNotice(r);
  assert.ok(r.notifications[0].subtitle.includes("加白失败"));
  if(detail)assert.ok(r.notifications[0].body.includes(detail));
}
await test("首次已加白：静默，先 GET 状态再 POST 加白",async()=>{
  const r=await invoke([get(snapshot([A])),post(snapshot([A]))]);
  expectNotice(r,0);
  assert.ok(r.calls[0].url.endsWith("/"+token));
  assert.equal(r.calls[0].options.timeout,5000);
  assert.ok(r.calls[1].url.endsWith("/add"));
  assert.equal(r.calls[1].options.timeout,15000);
});
await test("确认新增：一次成功通知",async()=>{
  const r=await invoke([get(snapshot([])),post(snapshot([A]))]);
  expectNotice(r);assert.ok(r.notifications[0].subtitle.includes("新增加白 1 项"));
});
await test("重复成功执行：不重复通知",async()=>{
  const storage=new Map();
  expectNotice(await invoke([get(snapshot([])),post(snapshot([A]))],{storage}));
  expectNotice(await invoke([get(snapshot([A])),post(snapshot([A]))],{storage}),0);
});
await test("在两个已加白网络之间切换：均静默",async()=>{
  const storage=new Map();
  for(const ip of [A,B,A])
    expectNotice(await invoke([get(snapshot([A,B],ip)),post(snapshot([A,B],ip))],{storage}),0);
});
await test("同 /24 更换精确 IP：静默",async()=>{
  expectNotice(await invoke([get(snapshot([A],"203.0.113.42")),post(snapshot([A],"203.0.113.87"))]),0);
});
await test("FIFO 淘汰后写回同一网段：旧缓存不能吞掉通知",async()=>{
  const storage=new Map([["po0_fw_custom_0",A+"|1|primary|"]]);
  expectNotice(await invoke([get(snapshot([B,C])),post(snapshot([A,B,C]))],{storage}));
});
await test("固定槽位 @0 新增：保留槽位验证和参数",async()=>{
  const r=await invoke([get(snapshot([])),post(snapshot([{ip:A,slot:0}]),{path:"/add?slot=0"})],{tokens:token+"@0"});
  expectNotice(r);assert.ok(r.notifications[0].body.includes("📌0"));
});
await test("同网段升级固定槽位：不是新增 IP",async()=>{
  expectNotice(await invoke([get(snapshot([A])),post(snapshot([{ip:A,slot:0}]))],{tokens:token+"@0"}),0);
});
await test("固定槽位不一致：每次失败通知",async()=>{
  const storage=new Map();
  for(let i=0;i<2;i++)
    expectFailure(await invoke([get(snapshot([])),post(snapshot([{ip:A,slot:1}]))],{storage,tokens:token+"@0"}),"未固定到槽位 0");
});
await test("403 槽位冲突：通知失败，不盲目回退",async()=>{
  const r=await invoke([get(snapshot([])),post({currentIp:A},{status:403})],{tokens:token+"@0"});
  expectFailure(r,"槽位冲突");assert.equal(r.calls.length,2);
});
await test("serviceId 兼容问题：备用写入确认新增才提示成功",async()=>{
  const r=await invoke([get(snapshot([])),post(null,{throw:'HTTP error! status: 400, body: {"error":"serviceId is required"}'}),get(snapshot([A]))]);
  expectNotice(r);assert.ok(r.notifications[0].subtitle.includes("新增加白"));
  assert.ok(r.notifications[0].body.includes("↪备用"));
  assert.ok(r.calls[2].url.startsWith("https://console.po0.io/"));
});
await test("主接口兼容失败但备用成功且网段已存在：静默",async()=>{
  expectNotice(await invoke([get(snapshot([A])),post({error:"serviceId is required"},{status:400}),get(snapshot([A]))]),0);
});
await test("备用接口超时：保留失败详情",async()=>{
  const r=await invoke([get(snapshot([])),post({error:"serviceId is required"},{status:400}),get(null,{throw:"request timed out"})]);
  expectFailure(r,"备用接口网络失败: request timed out");
  assert.equal(r.calls[2].options.timeout,15000);
});
await test("主接口连续相同超时：两次都通知，不按缓存去重",async()=>{
  const storage=new Map();
  for(let i=0;i<2;i++){
    const r=await invoke([get(snapshot([])),post(null,{throw:"request timed out"})],{storage});
    expectFailure(r,"request timed out");
    assert.equal(r.calls.length,2);
  }
});
await test("网络断开：保留失败通知，恢复但无新增则静默",async()=>{
  const storage=new Map();
  expectFailure(await invoke([get(null,{throw:"offline"}),post(null,{throw:"offline"})],{storage}),"offline");
  expectNotice(await invoke([get(snapshot([A])),post(snapshot([A]))],{storage}),0);
});
await test("失败后真正新增：恢复时通知新增成功",async()=>{
  const storage=new Map();
  expectFailure(await invoke([get(snapshot([])),post(null,{throw:"offline"})],{storage}));
  const r=await invoke([get(snapshot([])),post(snapshot([A]))],{storage});
  expectNotice(r);assert.ok(r.notifications[0].subtitle.includes("新增加白 1 项"));
});
await test("HTTP 2xx 读取响应超时：不得吞掉超时详情",async()=>{
  expectFailure(await invoke([get(snapshot([])),post(null,{textThrows:"body read timed out"})]),"读取响应失败: body read timed out");
});
for(const [name,reply] of [
  ["网络超时",get(null,{throw:"timeout"})],
  ["HTTP 500",get({error:"server error"},{status:500})],
  ["非 JSON",get("<html>error</html>")],
  ["缺 whitelist",get({enabled:true,currentIp:A})],
  ["whitelist 非数组",get({enabled:true,currentIp:A,whitelist:null})],
  ["条目为 null",get({enabled:true,currentIp:A,whitelist:[null]})],
  ["条目缺 IP",get({enabled:true,currentIp:A,whitelist:[{slot:0}]})],
  ["非法 IP",get(snapshot(["999.0.0.0/24"]))],
  ["IP 类型异常",get({enabled:true,currentIp:42,whitelist:[]})],
  ["非 /24 网段",get(snapshot(["203.0.0.0/16"]))],
  ["token 不可用",get(snapshot([],A,{tokenAvailable:false}))],
  ["JSON 错误体",get(snapshot([],A,{error:"failed"}))],
  ["缺 enabled",get({currentIp:A,whitelist:[]})],
]){
  await test("辅助写前查询异常："+name+"，加白成功仍执行、不冒报新增",async()=>{
    const r=await invoke([reply,post(snapshot([A]))]);
    expectNotice(r,0);
    assert.equal(r.calls.filter(c=>c.method==="post").length,1);
    assert.ok(r.storage.get("po0_fw_custom_0").includes("|1|primary|"));
  });
}
await test("写前查询异常同时加白超时：仍通知真正的加白失败",async()=>{
  expectFailure(await invoke([get(null,{throw:"query timeout"}),post(null,{throw:"add timeout"})]),"add timeout");
});
await test("写前查询不兼容：不阻止备用加白成功",async()=>{
  const r=await invoke([get({error:"serviceId is required"},{status:400}),post({error:"serviceId is required"},{status:400}),get(snapshot([A]))]);
  expectNotice(r,0);assert.ok(r.storage.get("po0_fw_custom_0").includes("|1|fallback|"));
});
await test("加白返回 2xx 但列表没有当前网段：保留未生效失败提示",async()=>{
  expectFailure(await invoke([get(snapshot([])),post(snapshot([]))]),"加白未生效");
});
await test("防火墙未启用：保留失败提示",async()=>{
  expectFailure(await invoke([get(snapshot([])),post(snapshot([A],A,{enabled:false}))]),"防火墙未启用");
});
await test("响应包含错误：不能因名单有当前网段而算成功",async()=>{
  const r=await invoke([get(snapshot([])),post(snapshot([A],A,{error:"write failed"}))]);
  expectFailure(r,"write failed");assert.ok(r.notifications[0].subtitle.includes("已生效 0/1"));
});
await test("写入 token 不可用：保留失败提示",async()=>{
  expectFailure(await invoke([get(snapshot([])),post(snapshot([],A,{tokenAvailable:false}))]),"token 不可用");
});
await test("2xx 返回非法 JSON：保留失败提示",async()=>{
  expectFailure(await invoke([get(snapshot([])),post("<html>bad gateway</html>")]),"响应异常");
});
await test("查询和写入之间再次切网但最终加白成功：不冒报新增",async()=>{
  expectNotice(await invoke([get(snapshot([],A)),post(snapshot([B],B))]),0);
});
await test("多 token 部分新增、部分超时：合并一次通知，新增出口不能被失败覆盖",async()=>{
  const t2="pgnfw_SECOND_TEST_ONLY",t3="pgnfw_THIRD_TEST_ONLY";
  const r=await invoke([
    get(snapshot([A]),{token}),post(snapshot([A]),{token}),
    get(snapshot([],B),{token:t2}),post(snapshot([B],B),{token:t2}),
    get(snapshot([],C),{token:t3}),post(null,{token:t3,throw:"timeout "+t3})
  ],{tokens:[token,t2,t3].join(",")});
  expectFailure(r,"timeout");
  assert.ok(r.notifications[0].subtitle.includes("加白失败 1/3"));
  assert.ok(r.notifications[0].subtitle.includes("已生效 2/3"));
  assert.ok(r.notifications[0].subtitle.includes("新增 1 项"));
  assert.ok(r.notifications[0].subtitle.includes(B));
  assert.ok(!r.notifications[0].subtitle.includes(C));
  for(const tok of [token,t2,t3])assert.ok(!JSON.stringify(r.notifications).includes(tok));
  assert.ok(!r.storage.get("po0_fw_custom_2").includes(t3));
});
await test("不同 token 并行，不让多个超时串行累积",async()=>{
  const t2="pgnfw_SECOND_TEST_ONLY";
  const r=await invoke([
    get(snapshot([]),{token,delay:10}),post(null,{token,throw:"first timeout"}),
    get(snapshot([],B),{token:t2}),post(null,{token:t2,throw:"second timeout"})
  ],{tokens:[token,t2].join(",")});
  expectFailure(r);assert.ok(r.notifications[0].subtitle.includes("加白失败 2/2"));
  assert.equal(r.calls[0].method,"get");assert.equal(r.calls[1].method,"get");
  assert.equal(r.calls[2].token,t2);
});
await test("同一 token 的两个槽位保持顺序，不并发改写",async()=>{
  const r=await invoke([
    get(snapshot([])),post(snapshot([{ip:A,slot:0}]),{path:"/add?slot=0",delay:10}),
    get(snapshot([{ip:A,slot:0}])),post({currentIp:A},{status:403,path:"/add?slot=1"})
  ],{tokens:token+"@0,"+token+"@1"});
  expectFailure(r,"槽位冲突");
  assert.deepEqual(r.calls.map(c=>c.method),["get","post","get","post"]);
});
await test("调整 token 顺序：不以旧缓存推断新增",async()=>{
  const storage=new Map([["po0_fw_custom_0",B+"|1|primary|"]]);
  expectNotice(await invoke([get(snapshot([A])),post(snapshot([A]))],{storage}),0);
});
await test("成功响应伪造新增标记：仍须写前快照确认",async()=>{
  expectNotice(await invoke([get(snapshot([A])),post(snapshot([A],A,{newIpAdded:true,added:true}))]),0);
});
for(const status of [400,401,404,500]){
  await test("HTTP "+status+"：保留失败，不滥用备用接口",async()=>{
    const r=await invoke([get(snapshot([])),post({error:"unrelated"},{status})]);
    expectFailure(r,String(status));assert.equal(r.calls.length,2);
  });
}
await test("非 2xx 以 Egern throw 形式返回：保留错误状态和详情",async()=>{
  expectFailure(await invoke([get(snapshot([])),post(null,{throw:'HTTP error! status: 503, body: {"error":"busy"}'})]),"503");
});
await test("未配置 token：保留配置失败提示，不请求接口",async()=>{
  const r=await invoke([],{tokens:""});
  expectNotice(r);assert.equal(r.notifications[0].subtitle,"未配置 token");
  assert.equal(r.calls.length,0);
});
await test("脚本内部异常：也转为失败通知",async()=>{
  const r=await invoke([get(snapshot([])),post(snapshot([A]))],{setJSONError:"storage failure"});
  expectFailure(r,"脚本异常: storage failure");
});
await test("服务端错误回显 token：通知和缓存均打码",async()=>{
  const r=await invoke([get(snapshot([])),post(snapshot([A],A,{error:"invalid "+token}))]);
  expectFailure(r,"pgnfw_***");
  assert.ok(!JSON.stringify(r.notifications).includes(token));
  assert.ok(!r.storage.get("po0_fw_custom_0").includes(token));
});
console.log(JSON.stringify({passed:passed.length,tests:passed},null,2));
