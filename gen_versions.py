#!/usr/bin/env python3
"""Generate 10 themed + structurally-distinct variants of the Axon AI site + a gallery."""
import re, pathlib

BASE = pathlib.Path.home() / "axon-site" / "index.html"
OUT  = pathlib.Path.home() / "axon-site" / "versions"
OUT.mkdir(exist_ok=True)
base = BASE.read_text()

def rgb(h): return ",".join(str(int(h[i:i+2],16)) for i in (0,2,4))

# name, accent, accentLight, bg, bg2, display, mono, fontquery
THEMES = [
 ("Axon Cyan","3df2ff","9beaff","04060a","070b12","Space Grotesk","JetBrains Mono",
  "Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500"),
 ("Biotech Emerald","34e0a0","a7f0d0","04100c","07140f","Sora","IBM Plex Mono",
  "Sora:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600"),
 ("Impact Crimson","ff4d6d","ffb0c0","0c0406","140709","Chakra Petch","Share Tech Mono",
  "Chakra+Petch:wght@300;400;500;600;700&family=Share+Tech+Mono"),
 ("Neural Violet","a78bfa","d6c9ff","07040f","0b0716","Outfit","Space Mono",
  "Outfit:wght@300;400;500;600;700&family=Space+Mono:wght@400;700"),
 ("Gridiron Gold","ffc24b","ffe0a0","0a0803","120d05","Rajdhani","JetBrains Mono",
  "Rajdhani:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500"),
 ("Clinical Ice","8ad7ff","c8ecff","050a0f","081119","Manrope","IBM Plex Mono",
  "Manrope:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500"),
 ("Synapse Magenta","ff5cf0","ffbdf6","0b040a","140714","Orbitron","Share Tech Mono",
  "Orbitron:wght@400;500;600;700;900&family=Share+Tech+Mono"),
 ("Safety Orange","ff8c42","ffc79e","0c0703","140b05","Archivo","Space Mono",
  "Archivo:wght@300;400;500;600;700&family=Space+Mono:wght@400;700"),
 ("Deep Teal","2dd4bf","99f0e4","03100e","071613","Exo 2","Fira Code",
  "Exo+2:wght@300;400;500;600;700&family=Fira+Code:wght@400;500"),
 ("Mono Graphite","e8eef5","ffffff","060708","0c0e10","Inter","JetBrains Mono",
  "Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500"),
]
# heroAlign, heroOrder, panel, titleScale(None if benefit-led), model, sceneOpacity
LAYOUTS = [
 ("left",  "name",   "sharp",  1.00,"brain", .80),
 ("center","benefit","glass",  None,"array", .85),
 ("right", "name",   "outline",1.15,"helmet",.75),
 ("left",  "benefit","round",  None,"brain", .80),
 ("center","name",   "none",   1.20,"helmet",.70),
 ("left",  "benefit","outline",None,"array", .90),
 ("center","name",   "glass",  1.10,"brain", .95),
 ("right", "benefit","sharp",  None,"helmet",.80),
 ("left",  "name",   "round",  0.95,"array", .85),
 ("center","benefit","none",   None,"brain", .55),
]
MODEL_LABEL = {"brain":"NEURAL CORTEX","helmet":"SMART HELMET","array":"SENSOR ARRAY"}

def overrides(align, order, panel, tscale, scene):
    css = [f"#scene{{opacity:{scene}}}"]
    if align=="center":
        css.append("#hero{align-items:center;text-align:center}#hero .kicker{justify-content:center}#hero .hero-cta{justify-content:center}.wl-count{text-align:center}")
    elif align=="right":
        css.append("#hero{align-items:flex-end;text-align:right}#hero .kicker{justify-content:flex-end}#hero .hero-cta{justify-content:flex-end}")
    if order=="benefit":
        css.append("#hero .block{display:flex;flex-direction:column}#hero .kicker{order:0}"
                   ".hero-benefit{order:1;font-size:clamp(34px,7vw,96px);font-weight:700;letter-spacing:-.02em;line-height:.96;margin-top:18px}"
                   ".hero-title{order:2;font-size:clamp(24px,3.5vw,46px);opacity:.85;font-weight:500}"
                   ".hero-sub{order:3}.hero-cta{order:4}.wl-count{order:5}")
    elif tscale and tscale!=1.0:
        a,b,c = int(54*tscale),round(9.5*tscale,1),int(148*tscale)
        css.append(f".hero-title{{font-size:clamp({a}px,{b}vw,{c}px)}}")
    if panel=="round":
        css.append(".block{border-radius:20px}.spec,.research-card,.modal-card,.specs{border-radius:14px;overflow:hidden}")
    elif panel=="outline":
        css.append(".block{background:rgba(8,12,18,.4);border:1px solid var(--cyan);box-shadow:0 0 30px -12px var(--cyan)}")
    elif panel=="glass":
        css.append(".block{background:rgba(255,255,255,.05);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.14);border-radius:16px}")
    elif panel=="none":
        css.append(".block{background:transparent!important;backdrop-filter:none!important;border:0!important;padding:0!important}"
                   ".body,h2,.hero-sub{text-shadow:0 2px 28px rgba(0,0,0,.95),0 1px 4px rgba(0,0,0,.9)}")
    return "\n".join(css)

manifest=[]
for i,((name,acc,accL,bg,bg2,disp,mono,fq),(align,order,panel,tscale,model,scene)) in enumerate(zip(THEMES,LAYOUTS),1):
    t = base
    # fonts
    t = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?family=[^"]*" rel="stylesheet" />',
               f'<link href="https://fonts.googleapis.com/css2?family={fq}&display=swap" rel="stylesheet" />', t)
    t = t.replace("Space Grotesk", disp).replace("JetBrains Mono", mono)
    # colors
    for a,b in [("rgba(61,242,255",f"rgba({rgb(acc)}"),("0x3df2ff","0x"+acc),("#3df2ff","#"+acc),
                ("0x9beaff","0x"+accL),("0x9be9ff","0x"+accL),("0x6fe3ff","0x"+accL),
                ("0x7fe6ff","0x"+accL),("0x2bb5d6","0x"+accL),("0x2a6cff","0x"+acc),("#2a6cff","#"+acc),
                ("0x04060a","0x"+bg),("#04060a","#"+bg),("#070b12","#"+bg2)]:
        t = t.replace(a,b)
    # structural layout overrides (injected after main CSS)
    t = t.replace("</head>", f"<style>/* variant {i} layout */\n{overrides(align,order,panel,tscale,scene)}\n</style>\n</head>")
    # default 3D model + switcher highlight + telemetry label
    t = t.replace("let active='brain';", f"let active='{model}';")
    t = t.replace('<button data-m="brain" class="active">NEURAL</button>', '<button data-m="brain">NEURAL</button>')
    t = t.replace(f'data-m="{model}">', f'data-m="{model}" class="active">', 1)
    t = t.replace(">NEURAL CORTEX<", f">{MODEL_LABEL[model]}<")
    # title
    t = re.sub(r'<title>[^<]*</title>', f'<title>AXON AI — {name} (v{i})</title>', t)
    (OUT/f"v{i}.html").write_text(t)
    manifest.append((i,name,acc,bg,disp,mono,f"{align}/{order}/{panel}/{model}",f"v{i}.html"))
    print(f"v{i:>2}  {name:<17} #{acc}  {align}-{order}, {panel} panels, {model} model")

cards = "\n".join(f'''
  <a class="card" href="{fn}" style="--a:#{acc};--b:#{bg}">
    <div class="sw"><span style="background:#{acc}"></span><span style="background:#{bg}"></span></div>
    <div class="meta"><div class="n">v{i} · {name}</div><div class="f">{disp} / {mono}</div>
      <div class="l">{lay}</div><div class="h">#{acc}</div></div>
  </a>''' for (i,name,acc,bg,disp,mono,lay,fn) in manifest)
gallery=f'''<!DOCTYPE html><html><head><meta charset="utf-8"><title>AXON AI — 10 Versions</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{{margin:0;box-sizing:border-box}}body{{background:#05070b;color:#e8f4ff;font-family:system-ui,sans-serif;padding:48px}}
h1{{font-size:34px;font-weight:700;letter-spacing:-.02em}}p{{color:#6f8197;margin:10px 0 36px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:18px}}
.card{{text-decoration:none;color:inherit;border:1px solid rgba(255,255,255,.1);background:var(--b);border-radius:10px;overflow:hidden;transition:.2s}}
.card:hover{{transform:translateY(-4px);border-color:var(--a)}}
.sw{{height:88px;display:flex}}.sw span{{flex:1}}.meta{{padding:16px}}.n{{font-weight:600;font-size:16px}}
.f{{color:#8aa;font-size:12px;margin-top:6px}}.l{{color:#6f8197;font-size:11px;margin-top:6px;font-family:monospace}}
.h{{font-family:monospace;color:var(--a);font-size:12px;margin-top:6px}}</style></head><body>
<h1>AXON AI — 10 Versions</h1><p>Same product &amp; content — different theme <b>and</b> layout DNA (hero, panels, default model, 3D intensity). Click any to open.</p>
<div class="grid">{cards}</div></body></html>'''
(OUT/"index.html").write_text(gallery)
print(f"\nGenerated {len(manifest)} structurally-distinct versions + gallery -> {OUT}")
