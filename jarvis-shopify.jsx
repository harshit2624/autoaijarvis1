/**
 * JARVIS Agent — Shopify Edition
 * Connect to your proxy server at http://localhost:3001
 * Change PROXY_URL below to your deployed server URL in production.
 */

import { useState, useEffect, useRef, useCallback } from "react";

const PROXY_URL = "http://localhost:3001"; // ← Change to your deployed URL

// ── Storage helpers ──────────────────────────────────────────────────────────
const load = (k, def) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : def; } catch { return def; } };
const save = (k, v)   => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const CHAT_KEY     = "jarvis_chat_shopify";
const FEATURES_KEY = "jarvis_features_shopify";

function defaultChat() {
  return [{ role: "assistant", text: "Hello! I'm JARVIS — connected to your Shopify store. I can analyze orders, surface insights, and answer any questions. Loading your data now…" }];
}

// ── Sub-components ───────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <div style={{ display:"flex", gap:4, padding:"8px 0", alignItems:"center" }}>
      {[0,1,2].map(i => <div key={i} style={{ width:7, height:7, borderRadius:"50%", background:"#22d3ee", animation:`bounce 1.2s ${i*0.2}s infinite` }} />)}
      <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}`}</style>
    </div>
  );
}

function Badge({ status }) {
  const m = { fulfilled:{bg:"#052e16",color:"#4ade80"}, pending:{bg:"#422006",color:"#fbbf24"}, cancelled:{bg:"#3b0764",color:"#e879f9"} };
  const s = m[status] || m.pending;
  return <span style={{ background:s.bg, color:s.color, padding:"2px 10px", borderRadius:999, fontSize:11, fontWeight:700, letterSpacing:1, textTransform:"uppercase" }}>{status}</span>;
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background:"#0d1f3c", border:"1px solid #1e3a5f", borderRadius:12, padding:"16px 18px" }}>
      <div style={{ fontSize:10, color:"#64748b", letterSpacing:2, textTransform:"uppercase", marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:28, fontWeight:800, color: color||"#e2e8f0", lineHeight:1 }}>{value}</div>
    </div>
  );
}

function BarChart({ data, color }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div style={{ display:"flex", alignItems:"flex-end", gap:6, height:60 }}>
      {data.map((d,i) => (
        <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
          <div style={{ width:"100%", background:color, height:`${(d.value/max)*52}px`, borderRadius:"3px 3px 0 0", transition:"height 0.6s", minHeight:d.value?4:0 }} />
          <span style={{ fontSize:9, color:"#6b7280", fontFamily:"monospace" }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function JarvisShopify() {
  const [tab, setTab]         = useState("dashboard");
  const [orders, setOrders]   = useState([]);
  const [stats, setStats]     = useState({ total:0, fulfilled:0, pending:0, cancelled:0 });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [filterStatus, setFilter] = useState("all");

  const [chat, setChat]       = useState(() => load(CHAT_KEY, defaultChat()));
  const [features, setFeatures] = useState(() => load(FEATURES_KEY, []));
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [featureInput, setFeatureInput] = useState("");
  const [featureLoading, setFeatureLoading] = useState(false);

  const chatEndRef = useRef(null);
  const inputRef   = useRef(null);

  useEffect(() => { save(CHAT_KEY, chat.slice(-60)); }, [chat]);
  useEffect(() => { save(FEATURES_KEY, features); }, [features]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [chat, chatLoading]);

  // ── Fetch from proxy ────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [ordersRes, statsRes] = await Promise.all([
        fetch(`${PROXY_URL}/orders?limit=50`),
        fetch(`${PROXY_URL}/orders/stats`),
      ]);
      if (!ordersRes.ok || !statsRes.ok) throw new Error("Proxy server error. Is it running?");
      const { orders: o } = await ordersRes.json();
      const s = await statsRes.json();
      setOrders(o);
      setStats(s);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Weekly chart ────────────────────────────────────────────────────────
  const weekDays = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const weekData = weekDays.map((label, i) => ({
    label,
    value: orders.filter(o => new Date(o.date).getDay() === (i+1)%7).length
  }));

  // ── Export CSV via proxy ────────────────────────────────────────────────
  const exportCSV = () => window.open(`${PROXY_URL}/orders/export`, "_blank");

  // ── Chat ────────────────────────────────────────────────────────────────
  async function sendChat() {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    const newChat = [...chat, { role:"user", text:userMsg }];
    setChat(newChat);
    setChatLoading(true);

    const system = `You are JARVIS, an elite AI agent managing a Shopify e-commerce dashboard.
Live store data:
- Total orders: ${stats.total}
- Fulfilled: ${stats.fulfilled}
- Pending: ${stats.pending}
- Cancelled: ${stats.cancelled}
- Recent orders sample: ${JSON.stringify(orders.slice(0,5))}
Be concise, smart, and data-driven. Under 3 sentences unless details requested.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system,
          messages: newChat.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }))
        })
      });
      const data = await res.json();
      setChat(c => [...c, { role:"assistant", text: data.content?.[0]?.text || "Sorry, try again." }]);
    } catch {
      setChat(c => [...c, { role:"assistant", text:"Network error." }]);
    }
    setChatLoading(false);
  }

  // ── Feature generator ───────────────────────────────────────────────────
  async function generateFeature() {
    if (!featureInput.trim() || featureLoading) return;
    const req = featureInput.trim(); setFeatureInput(""); setFeatureLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          messages:[{ role:"user", content:`You are JARVIS. Write a React/JS feature for an e-commerce dashboard: "${req}"\n\nFormat EXACTLY:\nFEATURE: [name]\nDESC: [one sentence]\nCODE:\n[working code]` }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || "";
      setFeatures(f => [{
        id: Date.now(),
        name: text.match(/FEATURE:\s*(.+)/)?.[1]?.trim() || req,
        desc: text.match(/DESC:\s*(.+)/)?.[1]?.trim() || "",
        code: text.match(/CODE:\n([\s\S]+)/)?.[1]?.trim() || text,
        date: new Date().toLocaleDateString(),
      }, ...f]);
    } catch { /* silent */ }
    setFeatureLoading(false);
  }

  const [searchQuery, setSearchQuery] = useState(\"\");\n\n  const filteredOrders = orders\n    .filter(o => filterStatus === \"all\" || o.status === filterStatus)\n    .filter(o => !searchQuery || \n      o.customer.toLowerCase().includes(searchQuery.toLowerCase()) ||\n      o.product.toLowerCase().includes(searchQuery.toLowerCase()) ||\n      o.id.toLowerCase().includes(searchQuery.toLowerCase())\n    );

  // ── Styles ──────────────────────────────────────────────────────────────
  const S = {
    app:{ minHeight:"100vh", background:"#060b14", color:"#e2e8f0", fontFamily:"'IBM Plex Mono','Courier New',monospace", display:"flex", flexDirection:"column" },
    header:{ background:"linear-gradient(135deg,#0a1628,#0d1f3c)", borderBottom:"1px solid #1e3a5f", padding:"14px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" },
    logo:{ display:"flex", alignItems:"center", gap:10 },
    logoIcon:{ width:36, height:36, borderRadius:"50%", background:"radial-gradient(circle,#22d3ee,#0e7490)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, boxShadow:"0 0 16px #22d3ee55", animation:"pulse 3s infinite" },
    nav:{ display:"flex", gap:4 },
    navBtn:(a)=>({ padding:"6px 16px", borderRadius:6, border:"none", cursor:"pointer", fontSize:11, fontWeight:700, letterSpacing:1.5, textTransform:"uppercase", background:a?"#22d3ee":"transparent", color:a?"#060b14":"#64748b", fontFamily:"'IBM Plex Mono',monospace" }),
    main:{ flex:1, padding:"20px 24px", maxWidth:1100, margin:"0 auto", width:"100%" },
    section:{ background:"#0a1628", border:"1px solid #1e3a5f", borderRadius:14, padding:18, marginBottom:16 },
    sectionTitle:{ fontSize:11, color:"#22d3ee", letterSpacing:2, textTransform:"uppercase", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"space-between" },
    table:{ width:"100%", borderCollapse:"collapse" },
    th:{ textAlign:"left", fontSize:10, color:"#64748b", letterSpacing:2, textTransform:"uppercase", padding:"6px 10px", borderBottom:"1px solid #1e3a5f" },
    td:{ padding:"10px 10px", borderBottom:"1px solid #0d1f3c", fontSize:12 },
    input:{ flex:1, background:"#0d1f3c", border:"1px solid #1e3a5f", borderRadius:8, padding:"10px 14px", color:"#e2e8f0", fontSize:13, outline:"none", fontFamily:"'IBM Plex Mono',monospace" },
    btn:{ background:"#22d3ee", border:"none", borderRadius:8, padding:"10px 18px", color:"#060b14", fontWeight:800, fontSize:12, cursor:"pointer", letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" },
    outlineBtn:{ background:"transparent", border:"1px solid #22d3ee", color:"#22d3ee", borderRadius:8, padding:"6px 16px", fontSize:11, fontWeight:700, cursor:"pointer", letterSpacing:1, fontFamily:"'IBM Plex Mono',monospace" },
    bubble:(isUser)=>({ maxWidth:"78%", alignSelf:isUser?"flex-end":"flex-start", background:isUser?"#0e7490":"#0d1f3c", border:`1px solid ${isUser?"#22d3ee44":"#1e3a5f"}`, borderRadius:isUser?"14px 14px 4px 14px":"14px 14px 14px 4px", padding:"10px 14px", fontSize:13, lineHeight:1.6 }),
    codeBlock:{ background:"#0a0f1e", border:"1px solid #1e3a5f", borderRadius:6, padding:12, fontSize:11, color:"#a5f3fc", fontFamily:"monospace", overflowX:"auto", maxHeight:160, marginTop:8 },
  };

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700;800&display=swap');
        @keyframes pulse{0%,100%{box-shadow:0 0 16px #22d3ee55}50%{box-shadow:0 0 28px #22d3eeaa}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#060b14}::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:4px}
        *{box-sizing:border-box}
      `}</style>

      {/* Header */}
      <div style={S.header}>
        <div style={S.logo}>
          <div style={S.logoIcon}>⚡</div>
          <div>
            <div style={{ fontSize:20, fontWeight:800, letterSpacing:3, color:"#22d3ee" }}>JARVIS</div>
            <div style={{ fontSize:10, color:"#64748b", letterSpacing:2 }}>SHOPIFY INTELLIGENCE</div>
          </div>
        </div>
        <div style={S.nav}>
          {["dashboard","orders","features","chat"].map(t => (
            <button key={t} style={S.navBtn(tab===t)} onClick={()=>setTab(t)}>
              {t==="dashboard"?"📊":t==="orders"?"📦":t==="features"?"🔧":"💬"} {t}
            </button>
          ))}
          <button style={{ ...S.outlineBtn, marginLeft:8 }} onClick={fetchData}>↻ Refresh</button>
        </div>
      </div>

      <div style={S.main}>
        {/* Error banner */}
        {error && (
          <div style={{ background:"#3b0000", border:"1px solid #7f1d1d", borderRadius:8, padding:"12px 16px", marginBottom:16, color:"#fca5a5", fontSize:12 }}>
            ❌ {error} — Make sure your proxy server is running: <code>node server.js</code>
          </div>
        )}

        {/* Pending alert */}
        {stats.pending > 0 && (
          <div style={{ background:"#422006", border:"1px solid #92400e", borderRadius:8, padding:"10px 16px", marginBottom:16, color:"#fbbf24", fontSize:12 }}>
            ⚠️ {stats.pending} order{stats.pending>1?"s":""} pending fulfillment in your Shopify store.
          </div>
        )}

        {/* ── DASHBOARD ─────────────────────────────── */}
        {tab==="dashboard" && (
          <div style={{ animation:"fadeIn 0.4s" }}>
            {loading ? (
              <div style={{ textAlign:"center", color:"#22d3ee", padding:40 }}><TypingDots /> Loading Shopify data...</div>
            ) : (
              <>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:14, marginBottom:20 }}>
                  <StatCard label="Total Orders"  value={stats.total}     />
                  <StatCard label="Fulfilled"     value={stats.fulfilled}  color="#4ade80" />
                  <StatCard label="Pending"       value={stats.pending}    color="#fbbf24" />
                  <StatCard label="Cancelled"     value={stats.cancelled}  color="#e879f9" />
                </div>

                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:16 }}>
                  <div style={S.section}>
                    <div style={S.sectionTitle}><span>📈 Orders by Day</span></div>
                    <BarChart data={weekData} color="#22d3ee" />
                  </div>
                  <div style={S.section}>
                    <div style={S.sectionTitle}><span>🎯 Fulfillment Rate</span></div>
                    {[
                      { label:"Fulfilled", pct: stats.total?(stats.fulfilled/stats.total*100).toFixed(0):0, color:"#4ade80" },
                      { label:"Pending",   pct: stats.total?(stats.pending/stats.total*100).toFixed(0):0,   color:"#fbbf24" },
                      { label:"Cancelled", pct: stats.total?(stats.cancelled/stats.total*100).toFixed(0):0, color:"#e879f9" },
                    ].map(item => (
                      <div key={item.label} style={{ marginBottom:10 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#94a3b8", marginBottom:3 }}>
                          <span>{item.label}</span><span style={{ color:item.color }}>{item.pct}%</span>
                        </div>
                        <div style={{ height:6, background:"#1e3a5f", borderRadius:3, overflow:"hidden" }}>
                          <div style={{ width:`${item.pct}%`, height:"100%", background:item.color, borderRadius:3, transition:"width 0.8s" }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={S.section}>
                  <div style={S.sectionTitle}>
                    <span>📦 Recent Orders</span>
                    <button style={S.outlineBtn} onClick={exportCSV}>⬇ Export CSV</button>
                  </div>
                  <table style={S.table}>
                    <thead><tr>{["Order","Customer","Product","Amount","Status","Date","City"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {orders.slice(0,8).map(o=>(
                        <tr key={o.id}>
                          <td style={{ ...S.td, color:"#22d3ee" }}>{o.id}</td>
                          <td style={S.td}>{o.customer}</td>
                          <td style={{ ...S.td, color:"#94a3b8" }}>{o.product}</td>
                          <td style={{ ...S.td, color:"#4ade80" }}>{o.currency} {o.amount?.toFixed(2)}</td>
                          <td style={S.td}><Badge status={o.status} /></td>
                          <td style={{ ...S.td, color:"#64748b" }}>{o.date}</td>
                          <td style={{ ...S.td, color:"#64748b" }}>{o.city}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── ORDERS ──────────────────────────────────── */}
        {tab==="orders" && (
          <div style={{ animation:"fadeIn 0.4s" }}>
            <div style={S.section}>
              <div style={S.sectionTitle}>
                <span>📦 All Orders ({filteredOrders.length})</span>
                <button style={S.outlineBtn} onClick={exportCSV}>⬇ Export CSV</button>
              </div>
              <div style={{ display:"flex", gap:8, marginBottom:12 }}>
                {["all","fulfilled","pending","cancelled"].map(s=>(
                  <button key={s} onClick={()=>setFilter(s)} style={{ padding:"4px 14px", borderRadius:20, border:`1px solid ${filterStatus===s?"#22d3ee":"#1e3a5f"}`, background:filterStatus===s?"#0e7490":"transparent", color:filterStatus===s?"#fff":"#64748b", fontSize:11, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>
                    {s.charAt(0).toUpperCase()+s.slice(1)} ({s==="all"?orders.length:orders.filter(o=>o.status===s).length})
                  </button>
                ))}
              </div>
              <table style={S.table}>
                <thead><tr>{["Order","Customer","Product","Amount","Status","Financial","Date","City"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {filteredOrders.map(o=>(
                    <tr key={o.id}>
                      <td style={{ ...S.td, color:"#22d3ee" }}>{o.id}</td>
                      <td style={S.td}>{o.customer}</td>
                      <td style={{ ...S.td, color:"#94a3b8" }}>{o.product}</td>
                      <td style={{ ...S.td, color:"#4ade80" }}>{o.currency} {o.amount?.toFixed(2)}</td>
                      <td style={S.td}><Badge status={o.status} /></td>
                      <td style={{ ...S.td, color:"#94a3b8", fontSize:10 }}>{o.financial}</td>
                      <td style={{ ...S.td, color:"#64748b" }}>{o.date}</td>
                      <td style={{ ...S.td, color:"#64748b" }}>{o.city}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredOrders.length===0 && <div style={{ textAlign:"center", color:"#64748b", padding:24, fontSize:13 }}>No orders found.</div>}
            </div>
          </div>
        )}

        {/* ── FEATURES ────────────────────────────────── */}
        {tab==="features" && (
          <div style={{ animation:"fadeIn 0.4s" }}>
            <div style={S.section}>
              <div style={S.sectionTitle}><span>🔧 Self-Coding Feature Generator</span></div>
              <p style={{ fontSize:12, color:"#64748b", marginBottom:14, lineHeight:1.7 }}>Describe any feature and JARVIS will write the code instantly.</p>
              <div style={{ display:"flex", gap:8 }}>
                <input style={S.input} value={featureInput} onChange={e=>setFeatureInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&generateFeature()} placeholder="e.g. Show top 5 customers by revenue..." />
                <button style={{ ...S.btn, opacity:featureLoading?0.6:1 }} onClick={generateFeature} disabled={featureLoading}>{featureLoading?"BUILDING...":"⚡ BUILD"}</button>
              </div>
            </div>
            {features.map(f=>(
              <div key={f.id} style={{ background:"#060b14", border:"1px solid #1e3a5f", borderRadius:10, padding:14, marginBottom:10, animation:"fadeIn 0.4s" }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <div style={{ fontWeight:700, color:"#22d3ee", fontSize:13 }}>⚡ {f.name}</div>
                  <div style={{ fontSize:10, color:"#64748b" }}>{f.date}</div>
                </div>
                <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6 }}>{f.desc}</div>
                <div style={S.codeBlock}><pre style={{ margin:0, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{f.code}</pre></div>
                <div style={{ display:"flex", gap:8, marginTop:8 }}>
                  <button onClick={()=>navigator.clipboard.writeText(f.code)} style={{ ...S.outlineBtn, fontSize:10, padding:"4px 12px" }}>Copy</button>
                  <button onClick={()=>setFeatures(fs=>fs.filter(x=>x.id!==f.id))} style={{ ...S.outlineBtn, borderColor:"#e879f9", color:"#e879f9", fontSize:10, padding:"4px 12px" }}>Remove</button>
                </div>
              </div>
            ))}
            {features.length===0 && !featureLoading && <div style={{ textAlign:"center", color:"#64748b", padding:40, fontSize:13 }}>No features yet. Ask JARVIS to build something!</div>}
          </div>
        )}

        {/* ── CHAT ────────────────────────────────────── */}
        {tab==="chat" && (
          <div style={{ animation:"fadeIn 0.4s" }}>
            <div style={S.section}>
              <div style={S.sectionTitle}><span>💬 Talk to JARVIS</span></div>
              <div style={{ display:"flex", flexDirection:"column", height:420 }}>
                <div style={{ flex:1, overflowY:"auto", padding:"4px 0", display:"flex", flexDirection:"column", gap:10 }}>
                  {chat.map((m,i)=>(
                    <div key={i} style={S.bubble(m.role==="user")}>
                      {m.role==="assistant" && <div style={{ fontSize:10, color:"#22d3ee", marginBottom:4, letterSpacing:1 }}>JARVIS</div>}
                      <div style={{ whiteSpace:"pre-wrap" }}>{m.text}</div>
                    </div>
                  ))}
                  {chatLoading && <div style={S.bubble(false)}><div style={{ fontSize:10, color:"#22d3ee", marginBottom:4 }}>JARVIS</div><TypingDots /></div>}
                  <div ref={chatEndRef} />
                </div>
                <div style={{ display:"flex", gap:8, marginTop:10 }}>
                  <input ref={inputRef} style={S.input} value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Ask JARVIS about your Shopify orders..." />
                  <button style={{ ...S.btn, opacity:chatLoading?0.6:1 }} onClick={sendChat} disabled={chatLoading}>{chatLoading?"...":"SEND"}</button>
                </div>
              </div>
              <div style={{ marginTop:10, display:"flex", flexWrap:"wrap", gap:6 }}>
                {["How many orders are pending?","What's my fulfilment rate?","Which product sold most?","Summarize today's orders"].map(q=>(
                  <button key={q} onClick={()=>{setChatInput(q);inputRef.current?.focus();}} style={{ background:"#0d1f3c", border:"1px solid #1e3a5f", color:"#94a3b8", borderRadius:20, padding:"4px 12px", fontSize:11, cursor:"pointer", fontFamily:"'IBM Plex Mono',monospace" }}>{q}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
